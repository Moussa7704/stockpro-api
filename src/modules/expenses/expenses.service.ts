import { Op, type Transaction, type WhereOptions } from "sequelize";
import { sequelize } from "../../config/database.js";
import { CashSession, Expense, ExpenseCategory, PaymentMethod } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { companyTimezone, localDate } from "../company/company-time.js";
import { archiveAction, archivedAtFrom, rethrowAsConflict } from "../catalog/catalog.helpers.js";
import { loadActiveMethods } from "../pos/payment-methods.service.js";
import { assertCurrencyAmount, findUsableSupplier } from "../purchases/purchases.helpers.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "../stock/numbering.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import type {
  CreateExpenseCategoryInput,
  CreateExpenseInput,
  ListExpensesQuery,
  UpdateExpenseCategoryInput,
} from "./expenses.schemas.js";

/**
 * Dépenses (loyer, électricité, transport…) rattachées à une boutique. Payées en espèces depuis
 * le tiroir-caisse d'une session ouverte, elles diminuent les espèces attendues à la clôture ;
 * sinon (coffre, Mobile Money, banque) elles ne touchent pas la caisse. Jamais supprimées :
 * une erreur s'annule, avec un motif, tant que la session de caisse concernée est ouverte.
 */

// Créées avec chaque nouvelle entreprise
export const DEFAULT_EXPENSE_CATEGORIES = ["Loyer", "Électricité et eau", "Salaires", "Transport", "Fournitures", "Autres"];

const CATEGORY_AUDIT_FIELDS: (keyof ExpenseCategory)[] = ["name", "archivedAt"];
const DUPLICATE_CATEGORY = "Une catégorie de dépenses porte déjà ce nom";

export async function createDefaultExpenseCategories(companyId: string, transaction: Transaction): Promise<void> {
  await ExpenseCategory.bulkCreate(
    DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ companyId, name })),
    { transaction },
  );
}

// --- Catégories
export async function listExpenseCategories(companyId: string, includeArchived: boolean) {
  return ExpenseCategory.findAll({
    where: { companyId, ...(!includeArchived && { archivedAt: null }) },
    order: [["name", "ASC"]],
  });
}

export async function createExpenseCategory(access: CompanyAccess, input: CreateExpenseCategoryInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const category = await ExpenseCategory.create({ name: input.name, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "expense_category.create",
          entityType: "expense_category",
          entityId: category.id,
          after: pick(category, CATEGORY_AUDIT_FIELDS),
        },
        transaction,
      );
      return category;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE_CATEGORY);
  }
}

export async function updateExpenseCategory(
  access: CompanyAccess,
  id: string,
  input: UpdateExpenseCategoryInput,
  actor: AuditActor,
) {
  const category = await ExpenseCategory.findOne({ where: { id, companyId: access.companyId } });
  if (!category) {
    throw AppError.notFound("Catégorie de dépenses introuvable");
  }
  try {
    return await sequelize.transaction(async (transaction) => {
      const before = pick(category, CATEGORY_AUDIT_FIELDS);
      const archivedAt = archivedAtFrom(input.archived, category.archivedAt);
      await category.update(
        { ...(input.name && { name: input.name }), ...(archivedAt !== undefined && { archivedAt }) },
        { transaction },
      );
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: archiveAction("expense_category", input.archived, !!before.archivedAt),
          entityType: "expense_category",
          entityId: category.id,
          before,
          after: pick(category, CATEGORY_AUDIT_FIELDS),
        },
        transaction,
      );
      return category;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE_CATEGORY);
  }
}

// --- Dépenses
/** Session de caisse dont le tiroir paie : ouverte, de la boutique ; verrouillée contre une clôture concurrente. */
async function findDrawerSession(access: CompanyAccess, id: string, shopId: string, transaction: Transaction) {
  const session = await CashSession.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    lock: transaction.LOCK.SHARE,
  });
  if (!session || session.shopId !== shopId) {
    throw AppError.badRequest("Session de caisse inconnue pour cette boutique");
  }
  if (session.status !== "open") {
    throw AppError.conflict("Cette session de caisse est clôturée");
  }
  return session;
}

export async function createExpense(access: CompanyAccess, input: CreateExpenseInput, actor: AuditActor) {
  assertCurrencyAmount(access, input.amount, "Montant");
  const userId = actor.actorUserId!;

  const expenseId = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    const category = await ExpenseCategory.findOne({
      where: { id: input.categoryId, companyId: access.companyId },
      transaction,
    });
    if (!category || category.archivedAt) {
      throw AppError.badRequest("Catégorie de dépenses inconnue ou archivée");
    }
    const method = (await loadActiveMethods(access.companyId, [input.paymentMethodId], transaction)).get(
      input.paymentMethodId,
    )!;
    if (input.supplierId) {
      await findUsableSupplier(access.companyId, input.supplierId, transaction);
    }

    let cashSessionId: string | null = null;
    if (input.cashSessionId) {
      if (method.type !== "cash") {
        throw AppError.badRequest("Seules les dépenses en espèces sont payées depuis le tiroir-caisse");
      }
      cashSessionId = (await findDrawerSession(access, input.cashSessionId, shop.id, transaction)).id;
    }

    const today = localDate(await companyTimezone(access.companyId, transaction));
    const spentAt = input.spentAt ?? today;
    if (spentAt > today) {
      throw AppError.badRequest("La date de la dépense ne peut pas être dans le futur");
    }

    const expense = await Expense.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        categoryId: category.id,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.expense),
        amount: new Decimal(input.amount).toFixed(2),
        description: input.description,
        spentAt,
        paymentMethodId: method.id,
        cashSessionId,
        supplierId: input.supplierId ?? null,
        reference: input.reference ?? null,
        createdBy: userId,
      },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "expense.create",
        entityType: "expense",
        entityId: expense.id,
        after: {
          number: expense.number,
          category: category.name,
          amount: expense.amount,
          method: method.code,
          fromCashDrawer: cashSessionId !== null,
        },
      },
      transaction,
    );
    return expense.id;
  });

  return getExpense(access, expenseId);
}

async function findExpense(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const expense = await Expense.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  const shopIds = await visibleShopIds(access);
  if (!expense || (shopIds && !shopIds.includes(expense.shopId))) {
    throw AppError.notFound("Dépense introuvable");
  }
  return expense;
}

const INCLUDES = [
  { model: ExpenseCategory, as: "category", attributes: ["id", "name"] },
  { model: PaymentMethod, as: "paymentMethod", attributes: ["id", "code", "name", "type"] },
];

export async function getExpense(access: CompanyAccess, id: string) {
  await findExpense(access, id);
  return Expense.findOne({ where: { id, companyId: access.companyId }, include: INCLUDES });
}

/** Annulation : la dépense reste visible (motif, auteur) mais ne compte plus, ni en caisse ni en rapport. */
export async function cancelExpense(access: CompanyAccess, id: string, reason: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const expense = await findExpense(access, id, transaction, true);
    if (expense.status === "cancelled") {
      throw AppError.conflict("Cette dépense est déjà annulée");
    }
    // Une session clôturée a un écart figé : on ne change plus ce qui est sorti de son tiroir
    if (expense.cashSessionId) {
      const session = await CashSession.findOne({
        where: { id: expense.cashSessionId, companyId: access.companyId },
        transaction,
        lock: transaction.LOCK.SHARE,
      });
      if (session!.status !== "open") {
        throw AppError.conflict("La session de caisse de cette dépense est clôturée : elle ne peut plus être annulée");
      }
    }
    await expense.update(
      { status: "cancelled", cancelledAt: new Date(), cancelledBy: actor.actorUserId, cancelReason: reason },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: expense.shopId,
        action: "expense.cancel",
        entityType: "expense",
        entityId: expense.id,
        before: { status: "recorded" },
        after: { status: "cancelled", reason, amount: expense.amount },
      },
      transaction,
    );
  });
  return getExpense(access, id);
}

export async function listExpenses(access: CompanyAccess, query: ListExpensesQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const where: WhereOptions<Expense> = {
    companyId: access.companyId,
    ...(shopIds && { shopId: { [Op.in]: shopIds } }),
    ...(query.categoryId && { categoryId: query.categoryId }),
    ...(query.status && { status: query.status }),
    ...((query.from || query.to) && {
      spentAt: { ...(query.from && { [Op.gte]: query.from }), ...(query.to && { [Op.lte]: query.to }) },
    }),
  };
  const [{ rows, count }, total] = await Promise.all([
    Expense.findAndCountAll({
      where,
      include: INCLUDES,
      order: [
        ["spentAt", "DESC"],
        ["createdAt", "DESC"],
      ],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    }),
    // Total des dépenses retenues (hors annulées) sur le filtre, pour le pied de tableau
    Expense.sum("amount", { where: { ...where, ...(!query.status && { status: "recorded" }) } }),
  ]);
  return {
    items: rows,
    total: count,
    totalAmount: new Decimal(total ?? 0).toFixed(2),
    page: query.page,
    pageSize: query.pageSize,
  };
}
