import { sequelize } from "../../config/database.js";
import { CustomerPayment, PaymentMethod } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { findOpenSession } from "../pos/cash-sessions.service.js";
import { loadActiveMethods } from "../pos/payment-methods.service.js";
import { assertCurrencyAmount } from "../purchases/purchases.helpers.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import type { CreateCustomerPaymentInput } from "./customers.schemas.js";
import { findCustomer, postLedgerEntry } from "./customers.service.js";

/**
 * Règlement d'une dette client : diminue le solde (écriture "payment" au compte) sans jamais le
 * rendre négatif — pas d'avance sur achats futurs. En espèces, l'argent entre dans le tiroir de
 * la session ouverte de l'encaisseur, qui doit donc en avoir une dans la boutique.
 */
export async function createCustomerPayment(
  access: CompanyAccess,
  customerId: string,
  input: CreateCustomerPaymentInput,
  actor: AuditActor,
) {
  assertCurrencyAmount(access, input.amount, "Montant");
  const userId = actor.actorUserId!;

  const paymentId = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    const method = (await loadActiveMethods(access.companyId, [input.paymentMethodId], transaction)).get(
      input.paymentMethodId,
    )!;
    const session = await findOpenSession(access, userId, shop.id, transaction);
    if (method.type === "cash" && !session) {
      throw AppError.conflict("Ouvrez une session de caisse pour encaisser en espèces");
    }

    // Le verrou posé par postLedgerEntry arrive trop tard pour le contrôle : on verrouille d'abord
    const customer = await findCustomer(access.companyId, customerId, transaction, true);
    if (new Decimal(input.amount).greaterThan(customer.balance)) {
      throw AppError.badRequest(
        `Le montant dépasse la dette du client (${new Decimal(customer.balance).toFixed(2)})`,
      );
    }

    const payment = await CustomerPayment.create(
      {
        companyId: access.companyId,
        customerId: customer.id,
        shopId: shop.id,
        paymentMethodId: method.id,
        // Seules les espèces vont dans le tiroir ; les autres moyens restent rattachés pour la clôture
        cashSessionId: session?.id ?? null,
        amount: new Decimal(input.amount).toFixed(2),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      },
      { transaction },
    );
    const updated = await postLedgerEntry(transaction, {
      companyId: access.companyId,
      customerId: customer.id,
      type: "payment",
      amount: new Decimal(input.amount).negated().toFixed(2),
      sourceType: "customer_payment",
      sourceId: payment.id,
      createdBy: userId,
    });

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "customer.payment",
        entityType: "customer_payment",
        entityId: payment.id,
        before: { balance: customer.balance },
        after: { customerId: customer.id, amount: payment.amount, method: method.code, balance: updated.balance },
      },
      transaction,
    );
    return payment.id;
  });

  return getCustomerPayment(access, paymentId);
}

export async function getCustomerPayment(access: CompanyAccess, id: string) {
  const payment = await CustomerPayment.findOne({
    where: { id, companyId: access.companyId },
    include: [{ model: PaymentMethod, as: "paymentMethod", attributes: ["id", "code", "name", "type"] }],
  });
  const shopIds = await visibleShopIds(access);
  if (!payment || (shopIds && !shopIds.includes(payment.shopId))) {
    throw AppError.notFound("Règlement introuvable");
  }
  const customer = await findCustomer(access.companyId, payment.customerId);
  return { ...payment.toJSON(), customerBalance: customer.balance };
}

export async function listCustomerPayments(access: CompanyAccess, customerId: string, page: number, pageSize: number) {
  await findCustomer(access.companyId, customerId);
  const { rows, count } = await CustomerPayment.findAndCountAll({
    where: { companyId: access.companyId, customerId },
    include: [{ model: PaymentMethod, as: "paymentMethod", attributes: ["id", "code", "name", "type"] }],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items: rows, total: count, page, pageSize };
}
