import { Op, QueryTypes, UniqueConstraintError, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { CashSession } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { assertCurrencyAmount } from "../purchases/purchases.helpers.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import type { CloseSessionInput, ListSessionsQuery, OpenSessionInput } from "./pos.schemas.js";

/**
 * Session de caisse (RB-08) : ouverture avec un fond de caisse, ventes et paiements rattachés,
 * clôture avec comptage réel → écart enregistré et audité. Une seule session ouverte par
 * caissier et par boutique (index unique partiel en base).
 */

export interface SessionSummary {
  salesCount: number;
  salesTotal: string;
  byMethod: { methodId: string; name: string; type: string; amount: string }[];
  cashRefunds: string;
  expectedCash: string;
}

/** Totaux d'une session : encaissements par moyen de paiement et espèces attendues dans le tiroir. */
export async function sessionSummary(session: CashSession, transaction?: Transaction): Promise<SessionSummary> {
  const [sales] = await sequelize.query<{ count: string; total: string }>(
    `SELECT count(*) AS count, COALESCE(sum(total), 0) AS total
     FROM sales WHERE cash_session_id = :id AND status = 'completed'`,
    { replacements: { id: session.id }, type: QueryTypes.SELECT, transaction },
  );
  // Les paiements des ventes annulées sont exclus : l'argent a été rendu au client
  const byMethod = await sequelize.query<{ method_id: string; name: string; type: string; amount: string }>(
    `SELECT pm.id AS method_id, pm.name, pm.type, sum(sp.amount) AS amount
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id AND s.status = 'completed'
     JOIN payment_methods pm ON pm.id = sp.payment_method_id
     WHERE sp.cash_session_id = :id
     GROUP BY pm.id, pm.name, pm.type, pm.sort_order
     ORDER BY pm.sort_order`,
    { replacements: { id: session.id }, type: QueryTypes.SELECT, transaction },
  );
  const [refunds] = await sequelize.query<{ amount: string }>(
    `SELECT COALESCE(sum(r.refund_amount), 0) AS amount
     FROM sale_returns r JOIN payment_methods pm ON pm.id = r.refund_method_id
     WHERE r.cash_session_id = :id AND r.refund_to = 'method' AND pm.type = 'cash'`,
    { replacements: { id: session.id }, type: QueryTypes.SELECT, transaction },
  );

  const cashIn = byMethod
    .filter((row) => row.type === "cash")
    .reduce((total, row) => total.plus(row.amount), new Decimal(0));
  const expectedCash = new Decimal(session.openingFloat).plus(cashIn).minus(refunds!.amount);

  return {
    salesCount: Number(sales!.count),
    salesTotal: new Decimal(sales!.total).toFixed(2),
    byMethod: byMethod.map((row) => ({
      methodId: row.method_id,
      name: row.name,
      type: row.type,
      amount: new Decimal(row.amount).toFixed(2),
    })),
    cashRefunds: new Decimal(refunds!.amount).toFixed(2),
    expectedCash: expectedCash.toFixed(2),
  };
}

/** Session ouverte de l'utilisateur dans la boutique (null s'il n'en a pas). */
export async function findOpenSession(
  access: CompanyAccess,
  userId: string,
  shopId: string,
  transaction?: Transaction,
): Promise<CashSession | null> {
  return CashSession.findOne({
    where: { companyId: access.companyId, shopId, cashierId: userId, status: "open" },
    transaction,
    ...(transaction && { lock: transaction.LOCK.SHARE }),
  });
}

async function findSession(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const session = await CashSession.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  const shopIds = await visibleShopIds(access);
  if (!session || (shopIds && !shopIds.includes(session.shopId))) {
    throw AppError.notFound("Session de caisse introuvable");
  }
  return session;
}

export async function getSession(access: CompanyAccess, id: string) {
  const session = await findSession(access, id);
  return { ...session.toJSON(), summary: await sessionSummary(session) };
}

export async function currentSession(access: CompanyAccess, userId: string, shopId: string) {
  await findOperableShop(access, shopId);
  const session = await findOpenSession(access, userId, shopId);
  return session ? { ...session.toJSON(), summary: await sessionSummary(session) } : null;
}

export async function openSession(access: CompanyAccess, input: OpenSessionInput, actor: AuditActor) {
  assertCurrencyAmount(access, input.openingFloat, "Fond de caisse");
  try {
    const id = await sequelize.transaction(async (transaction) => {
      const shop = await findOperableShop(access, input.shopId, transaction);
      const session = await CashSession.create(
        {
          companyId: access.companyId,
          shopId: shop.id,
          cashierId: actor.actorUserId!,
          openedAt: new Date(),
          openingFloat: input.openingFloat,
        },
        { transaction },
      );
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          shopId: shop.id,
          action: "cash_session.open",
          entityType: "cash_session",
          entityId: session.id,
          after: { openingFloat: session.openingFloat },
        },
        transaction,
      );
      return session.id;
    });
    return getSession(access, id);
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw AppError.conflict("Vous avez déjà une session de caisse ouverte dans cette boutique");
    }
    throw error;
  }
}

/** Clôture : le caissier compte son tiroir ; l'écart avec l'attendu est enregistré et audité. */
export async function closeSession(access: CompanyAccess, id: string, input: CloseSessionInput, actor: AuditActor) {
  assertCurrencyAmount(access, input.countedCash, "Montant compté");
  await sequelize.transaction(async (transaction) => {
    const session = await findSession(access, id, transaction, true);
    if (session.status !== "open") {
      throw AppError.conflict("Cette session est déjà clôturée");
    }
    // Sa propre session, ou celle d'un autre si on supervise (gérant, propriétaire, comptable)
    if (session.cashierId !== actor.actorUserId && !access.permissions.has("reports.view")) {
      throw AppError.forbidden("Vous ne pouvez clôturer que votre propre session");
    }

    const summary = await sessionSummary(session, transaction);
    const difference = new Decimal(input.countedCash).minus(summary.expectedCash).toFixed(2);
    await session.update(
      {
        status: "closed",
        closedAt: new Date(),
        closedBy: actor.actorUserId,
        expectedCash: summary.expectedCash,
        countedCash: input.countedCash,
        difference,
        notes: input.notes ?? null,
      },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: session.shopId,
        action: new Decimal(difference).isZero() ? "cash_session.close" : "cash_session.close_with_difference",
        entityType: "cash_session",
        entityId: session.id,
        before: { status: "open" },
        after: { status: "closed", expectedCash: summary.expectedCash, countedCash: input.countedCash, difference },
      },
      transaction,
    );
  });
  return getSession(access, id);
}

export async function listSessions(access: CompanyAccess, query: ListSessionsQuery, userId: string) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await CashSession.findAndCountAll({
    where: {
      companyId: access.companyId,
      ...(shopIds && { shopId: { [Op.in]: shopIds } }),
      ...(query.status && { status: query.status }),
      // Un caissier ne voit que ses propres sessions
      ...(!access.permissions.has("reports.view") && { cashierId: userId }),
    },
    order: [["openedAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}
