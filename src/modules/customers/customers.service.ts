import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Customer, CustomerLedgerEntry, Sale } from "../../models/index.js";
import type { LedgerType } from "../../models/pos.models.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { archiveAction, archivedAtFrom, likePattern, rethrowAsConflict } from "../catalog/catalog.helpers.js";
import { assertCurrencyAmount } from "../purchases/purchases.helpers.js";
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from "./customers.schemas.js";

const AUDIT_FIELDS: (keyof Customer)[] = ["name", "phone", "email", "creditLimit", "archivedAt"];
const DUPLICATE = "Un client utilise déjà ce numéro de téléphone";

/** Accorder du crédit est une décision financière : réservée à ceux qui voient les comptes (pas au caissier). */
function assertCanSetCreditLimit(access: CompanyAccess, creditLimit: string | null | undefined) {
  if (creditLimit !== undefined && creditLimit !== null && !access.permissions.has("reports.view")) {
    throw AppError.forbidden("Fixer un plafond de crédit est réservé au gérant, au comptable ou au propriétaire");
  }
}

export async function findCustomer(companyId: string, id: string, transaction?: Transaction) {
  const customer = await Customer.findOne({ where: { id, companyId }, transaction });
  if (!customer) {
    throw AppError.notFound("Client introuvable");
  }
  return customer;
}

/**
 * Écriture au compte client (en ajout seul) : verrouille le client, met à jour son solde et
 * journalise. amount signé : + augmente la dette, − la diminue. À appeler dans la transaction
 * de l'opération (vente, annulation, retour, paiement).
 */
export async function postLedgerEntry(
  transaction: Transaction,
  entry: {
    companyId: string;
    customerId: string;
    type: LedgerType;
    amount: string;
    sourceType: string;
    sourceId: string;
    createdBy: string | null;
  },
): Promise<Customer> {
  const customer = await Customer.findOne({
    where: { id: entry.customerId, companyId: entry.companyId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!customer) {
    throw AppError.badRequest("Client inconnu");
  }

  const balance = new Decimal(customer.balance).plus(entry.amount).toFixed(2);
  await customer.update({ balance }, { transaction });
  await CustomerLedgerEntry.create(
    {
      companyId: entry.companyId,
      customerId: customer.id,
      type: entry.type,
      amount: new Decimal(entry.amount).toFixed(2),
      balanceAfter: balance,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      createdBy: entry.createdBy,
    },
    { transaction },
  );
  return customer;
}

export async function listCustomers(companyId: string, query: ListCustomersQuery) {
  const search = query.search ? likePattern(query.search) : undefined;
  const { rows, count } = await Customer.findAndCountAll({
    where: {
      companyId,
      ...(!query.includeArchived && { archivedAt: null }),
      ...(query.withDebt && { balance: { [Op.gt]: 0 } }),
      ...(search && {
        [Op.or]: [{ name: { [Op.iLike]: search } }, { phone: { [Op.iLike]: search } }, { email: { [Op.iLike]: search } }],
      }),
    },
    order: query.withDebt ? [["balance", "DESC"]] : [["name", "ASC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

/** Fiche client : solde, crédit encore disponible et derniers achats. */
export async function getCustomer(companyId: string, id: string) {
  const customer = await findCustomer(companyId, id);
  const recentSales = await Sale.findAll({
    where: { companyId, customerId: id },
    attributes: ["id", "number", "status", "total", "balanceDue", "createdAt"],
    order: [["createdAt", "DESC"]],
    limit: 20,
  });
  const availableCredit =
    customer.creditLimit === null ? "0.00" : Decimal.max(0, new Decimal(customer.creditLimit).minus(customer.balance)).toFixed(2);
  return { ...customer.toJSON(), availableCredit, recentSales };
}

export async function listLedger(companyId: string, customerId: string, page: number, pageSize: number) {
  await findCustomer(companyId, customerId);
  const { rows, count } = await CustomerLedgerEntry.findAndCountAll({
    where: { companyId, customerId },
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items: rows, total: count, page, pageSize };
}

export async function createCustomer(access: CompanyAccess, input: CreateCustomerInput, actor: AuditActor) {
  assertCurrencyAmount(access, input.creditLimit, "Plafond de crédit");
  assertCanSetCreditLimit(access, input.creditLimit);
  try {
    return await sequelize.transaction(async (transaction) => {
      const customer = await Customer.create({ ...input, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "customer.create",
          entityType: "customer",
          entityId: customer.id,
          after: pick(customer, AUDIT_FIELDS),
        },
        transaction,
      );
      return customer;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}

export async function updateCustomer(
  access: CompanyAccess,
  id: string,
  input: UpdateCustomerInput,
  actor: AuditActor,
) {
  assertCurrencyAmount(access, input.creditLimit, "Plafond de crédit");
  assertCanSetCreditLimit(access, input.creditLimit);

  const customer = await findCustomer(access.companyId, id);
  const { archived, ...fields } = input;
  try {
    return await sequelize.transaction(async (transaction) => {
      const before = pick(customer, AUDIT_FIELDS);
      const archivedAt = archivedAtFrom(archived, customer.archivedAt);
      await customer.update({ ...fields, ...(archivedAt !== undefined && { archivedAt }) }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: input.creditLimit !== undefined ? "customer.credit_limit_change" : archiveAction("customer", archived, !!before.archivedAt),
          entityType: "customer",
          entityId: customer.id,
          before,
          after: pick(customer, AUDIT_FIELDS),
        },
        transaction,
      );
      return customer;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}
