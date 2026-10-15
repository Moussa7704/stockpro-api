import type { Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Category } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { archiveAction, archivedAtFrom, rethrowAsConflict } from "./catalog.helpers.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./catalog.schemas.js";

const AUDIT_FIELDS: (keyof Category)[] = ["name", "parentId", "archivedAt"];
const DUPLICATE = "Une catégorie porte déjà ce nom à ce niveau";

/** Liste à plat (avec parentId) : le front construit l'arbre. */
export async function listCategories(companyId: string, includeArchived: boolean): Promise<Category[]> {
  return Category.findAll({
    where: { companyId, ...(!includeArchived && { archivedAt: null }) },
    order: [["name", "ASC"]],
  });
}

export async function findCategory(companyId: string, id: string, transaction?: Transaction): Promise<Category> {
  const category = await Category.findOne({ where: { id, companyId }, transaction });
  if (!category) {
    throw AppError.notFound("Catégorie introuvable");
  }
  return category;
}

/** Catégorie utilisable comme parent ou pour un produit : de l'entreprise et non archivée. */
export async function findUsableCategory(
  companyId: string,
  id: string,
  transaction?: Transaction,
): Promise<Category> {
  const category = await Category.findOne({ where: { id, companyId }, transaction });
  if (!category || category.archivedAt) {
    throw AppError.badRequest("Catégorie inconnue ou archivée");
  }
  return category;
}

/** Interdit les cycles : une catégorie ne peut pas descendre d'elle-même. */
async function assertNotDescendant(
  companyId: string,
  categoryId: string,
  newParentId: string,
  transaction: Transaction,
): Promise<void> {
  let currentId: string | null = newParentId;
  // On remonte du nouveau parent jusqu'à la racine (profondeur limitée par sécurité)
  for (let depth = 0; currentId && depth < 50; depth++) {
    if (currentId === categoryId) {
      throw AppError.badRequest(
        "Une catégorie ne peut pas être placée sous elle-même ou sous une de ses sous-catégories",
      );
    }
    const current: Category | null = await Category.findOne({
      where: { id: currentId, companyId },
      attributes: ["parentId"],
      transaction,
    });
    currentId = current?.parentId ?? null;
  }
}

export async function createCategory(access: CompanyAccess, input: CreateCategoryInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      if (input.parentId) {
        await findUsableCategory(access.companyId, input.parentId, transaction);
      }
      const category = await Category.create(
        { name: input.name, parentId: input.parentId ?? null, companyId: access.companyId },
        { transaction },
      );
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "category.create",
          entityType: "category",
          entityId: category.id,
          after: pick(category, AUDIT_FIELDS),
        },
        transaction,
      );
      return category;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}

export async function updateCategory(
  access: CompanyAccess,
  id: string,
  input: UpdateCategoryInput,
  actor: AuditActor,
) {
  const category = await findCategory(access.companyId, id);
  const { archived, ...fields } = input;

  try {
    return await sequelize.transaction(async (transaction) => {
      if (fields.parentId) {
        await findUsableCategory(access.companyId, fields.parentId, transaction);
        await assertNotDescendant(access.companyId, category.id, fields.parentId, transaction);
      }

      const before = pick(category, AUDIT_FIELDS);
      const archivedAt = archivedAtFrom(archived, category.archivedAt);
      await category.update({ ...fields, ...(archivedAt !== undefined && { archivedAt }) }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: archiveAction("category", archived, !!before.archivedAt),
          entityType: "category",
          entityId: category.id,
          before,
          after: pick(category, AUDIT_FIELDS),
        },
        transaction,
      );
      return category;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}
