import { Op, type Transaction, type WhereOptions } from "sequelize";
import { sequelize } from "../../config/database.js";
import {
  CashSession,
  Company,
  Customer,
  PaymentMethod,
  Product,
  Sale,
  SaleLine,
  SalePayment,
} from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { postLedgerEntry } from "../customers/customers.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "../stock/numbering.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import { applyMovements, loadStockProducts, negate } from "../stock/stock-engine.js";
import { findOpenSession } from "./cash-sessions.service.js";
import { loadActiveMethods } from "./payment-methods.service.js";
import type { CreateSaleInput, ListSalesQuery } from "./pos.schemas.js";
import { priceSale, settlePayments } from "./sale-pricing.js";

const SALE_INCLUDE = [
  {
    model: SaleLine,
    as: "lines",
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name", "barcode"] }],
  },
  {
    model: SalePayment,
    as: "payments",
    include: [{ model: PaymentMethod, as: "paymentMethod", attributes: ["id", "code", "name", "type"] }],
  },
  { model: Customer, as: "customer", attributes: ["id", "name", "phone"] },
];

export async function findSale(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const sale = await Sale.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  const shopIds = await visibleShopIds(access);
  if (!sale || (shopIds && !shopIds.includes(sale.shopId))) {
    throw AppError.notFound("Vente introuvable");
  }
  return sale;
}

export async function getSale(access: CompanyAccess, id: string) {
  await findSale(access, id);
  const sale = await Sale.findByPk(id, { include: SALE_INCLUDE });
  const json = sale!.toJSON() as Record<string, unknown> & { lines?: Record<string, unknown>[] };
  // Le coût d'achat (marge) n'est visible que de ceux qui gèrent les comptes
  if (!access.permissions.has("reports.view") && json.lines) {
    json.lines = json.lines.map(({ unitCost: _unitCost, ...line }) => line);
  }
  return json;
}

export async function listSales(access: CompanyAccess, query: ListSalesQuery, userId: string) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const where: WhereOptions<Sale> = {
    companyId: access.companyId,
    ...(shopIds && { shopId: { [Op.in]: shopIds } }),
    ...(query.sessionId && { cashSessionId: query.sessionId }),
    ...(query.customerId && { customerId: query.customerId }),
    ...(query.status && { status: query.status }),
    // Un caissier ne voit que ses propres ventes
    ...(!access.permissions.has("reports.view") && { createdBy: userId }),
    ...((query.from || query.to) && {
      createdAt: { ...(query.from && { [Op.gte]: query.from }), ...(query.to && { [Op.lte]: query.to }) },
    }),
  };
  const { rows, count } = await Sale.findAndCountAll({
    where,
    include: [{ model: Customer, as: "customer", attributes: ["id", "name"] }],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

/**
 * Validation d'une vente (RB-05), en UNE transaction : si une étape échoue, rien n'est enregistré.
 */
export async function createSale(access: CompanyAccess, input: CreateSaleInput, actor: AuditActor) {
  const userId = actor.actorUserId!;

  const saleId = await sequelize.transaction(async (transaction) => {
    // 1. Boutique, session de caisse ouverte (verrou partagé : la session ne peut pas être clôturée pendant la vente)
    const shop = await findOperableShop(access, input.shopId, transaction);
    const session = await findOpenSession(access, userId, shop.id, transaction);
    if (!session) {
      throw AppError.conflict("Ouvrez une session de caisse avant de vendre");
    }

    // 2. Produits (de l'entreprise, actifs, quantités compatibles avec l'unité) et calcul du ticket
    const products = await loadStockProducts(
      access.companyId,
      input.lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );
    const company = await Company.findByPk(access.companyId, { attributes: ["settings"], transaction });
    const priced = priceSale(access, input, products, company?.settings.maxCashierDiscountPercent ?? 0);

    // 3. Règlement : moyens de paiement, monnaie rendue, reste dû
    const methods = await loadActiveMethods(
      access.companyId,
      [...new Set(input.payments.map((payment) => payment.methodId))],
      transaction,
    );
    const settlement = settlePayments(priced.total, input.payments, (id) => methods.get(id)!.type === "cash");

    // 4. Reste dû → compte du client, dans la limite de son plafond de crédit
    let customer: Customer | null = null;
    if (input.customerId) {
      customer = await Customer.findOne({
        where: { id: input.customerId, companyId: access.companyId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!customer || customer.archivedAt) {
        throw AppError.badRequest("Client inconnu ou archivé");
      }
    }
    const balanceDue = new Decimal(settlement.balanceDue);
    if (balanceDue.greaterThan(0)) {
      if (!customer) {
        throw AppError.badRequest("Paiement incomplet : choisissez un client pour une vente à crédit");
      }
      if (customer.creditLimit === null) {
        throw AppError.badRequest("Ce client n'a pas de crédit autorisé");
      }
      const available = new Decimal(customer.creditLimit).minus(customer.balance);
      if (balanceDue.greaterThan(available)) {
        throw AppError.badRequest(`Plafond de crédit dépassé (disponible : ${Decimal.max(0, available).toFixed(2)})`);
      }
    }

    // 5. Vente + numéro de ticket sans trou
    const sale = await Sale.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        cashSessionId: session.id,
        customerId: customer?.id ?? null,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.ticket),
        subtotal: priced.subtotal,
        discountTotal: priced.discountTotal,
        total: priced.total,
        amountPaid: settlement.amountPaid,
        changeGiven: settlement.changeGiven,
        balanceDue: settlement.balanceDue,
        notes: input.notes ?? null,
        createdBy: userId,
      },
      { transaction },
    );

    // 6. Stock : verrouillé et jamais négatif (deux caissiers ne vendent pas le même dernier article)
    const movements = await applyMovements(
      { companyId: access.companyId, sourceType: "sale", sourceId: sale.id, createdBy: userId, transaction },
      priced.lines.map((line) => ({
        shopId: shop.id,
        productId: line.productId,
        quantity: negate(line.quantity),
        type: "sale" as const,
      })),
    );

    // 7. Lignes : prix ET coût figés (RB-03, D-05)
    await SaleLine.bulkCreate(
      priced.lines.map((line) => ({
        companyId: access.companyId,
        saleId: sale.id,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        lineTotal: line.lineTotal,
        unitCost: movements.find((movement) => movement.productId === line.productId)!.unitCost,
      })),
      { transaction },
    );

    // 8. Paiements, rattachés à la session de caisse
    await SalePayment.bulkCreate(
      settlement.payments.map((payment) => ({
        companyId: access.companyId,
        saleId: sale.id,
        paymentMethodId: payment.methodId,
        cashSessionId: session.id,
        amount: payment.amount,
        reference: payment.reference ?? null,
      })),
      { transaction },
    );
    if (balanceDue.greaterThan(0)) {
      await postLedgerEntry(transaction, {
        companyId: access.companyId,
        customerId: customer!.id,
        type: "sale_credit",
        amount: settlement.balanceDue,
        sourceType: "sale",
        sourceId: sale.id,
        createdBy: userId,
      });
    }

    // 9. Audit
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "sale.create",
        entityType: "sale",
        entityId: sale.id,
        after: {
          number: sale.number,
          total: sale.total,
          discountTotal: sale.discountTotal,
          balanceDue: sale.balanceDue,
          ...(priced.priceOverrides.length > 0 && { priceOverrides: priced.priceOverrides }),
        },
      },
      transaction,
    );
    return sale.id;
  });

  return getSale(access, saleId);
}

/**
 * Annulation complète d'une vente, tant que sa session de caisse est ouverte : la marchandise
 * revient en stock (au coût d'origine), l'argent est rendu, le crédit éventuel est effacé.
 * Après la clôture de la caisse, on passe par un retour.
 */
export async function cancelSale(access: CompanyAccess, id: string, reason: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const sale = await findSale(access, id, transaction, true);
    if (sale.status !== "completed") {
      throw AppError.conflict("Cette vente est déjà annulée");
    }
    const session = await CashSession.findByPk(sale.cashSessionId, { transaction, lock: transaction.LOCK.SHARE });
    if (session?.status !== "open") {
      throw AppError.conflict("La caisse de cette vente est clôturée : enregistrez un retour à la place");
    }
    const lines = await SaleLine.findAll({ where: { saleId: sale.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (lines.some((line) => new Decimal(line.returnedQuantity).greaterThan(0))) {
      throw AppError.conflict("Une partie de cette vente a déjà été retournée : enregistrez un retour pour le reste");
    }

    await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "sale",
        sourceId: sale.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      lines.map((line) => ({
        shopId: sale.shopId,
        productId: line.productId,
        quantity: line.quantity,
        type: "sale_cancellation" as const,
        unitCost: line.unitCost,
      })),
    );
    if (new Decimal(sale.balanceDue).greaterThan(0)) {
      await postLedgerEntry(transaction, {
        companyId: access.companyId,
        customerId: sale.customerId!,
        type: "sale_cancellation",
        amount: negate(sale.balanceDue),
        sourceType: "sale",
        sourceId: sale.id,
        createdBy: actor.actorUserId,
      });
    }

    await sale.update(
      { status: "cancelled", cancelledAt: new Date(), cancelledBy: actor.actorUserId, cancelReason: reason },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: sale.shopId,
        action: "sale.cancel",
        entityType: "sale",
        entityId: sale.id,
        before: { status: "completed" },
        after: { status: "cancelled", reason, total: sale.total },
      },
      transaction,
    );
  });
  return getSale(access, id);
}
