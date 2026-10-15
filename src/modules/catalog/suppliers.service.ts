import { Op } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Supplier } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { archiveAction, archivedAtFrom, likePattern, rethrowAsConflict } from "./catalog.helpers.js";
import type { CreateSupplierInput, ListSuppliersQuery, UpdateSupplierInput } from "./catalog.schemas.js";

const AUDIT_FIELDS: (keyof Supplier)[] = ["name", "contactName", "phone", "email", "address", "archivedAt"];
const DUPLICATE = "Un fournisseur porte déjà ce nom";

export async function listSuppliers(companyId: string, query: ListSuppliersQuery) {
  const search = query.search ? likePattern(query.search) : undefined;
  const { rows, count } = await Supplier.findAndCountAll({
    where: {
      companyId,
      ...(!query.includeArchived && { archivedAt: null }),
      ...(search && {
        [Op.or]: [
          { name: { [Op.iLike]: search } },
          { contactName: { [Op.iLike]: search } },
          { phone: { [Op.iLike]: search } },
        ],
      }),
    },
    order: [["name", "ASC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

export async function findSupplier(companyId: string, id: string): Promise<Supplier> {
  const supplier = await Supplier.findOne({ where: { id, companyId } });
  if (!supplier) {
    throw AppError.notFound("Fournisseur introuvable");
  }
  return supplier;
}

export async function createSupplier(access: CompanyAccess, input: CreateSupplierInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const supplier = await Supplier.create({ ...input, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "supplier.create",
          entityType: "supplier",
          entityId: supplier.id,
          after: pick(supplier, AUDIT_FIELDS),
        },
        transaction,
      );
      return supplier;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}

export async function updateSupplier(
  access: CompanyAccess,
  id: string,
  input: UpdateSupplierInput,
  actor: AuditActor,
) {
  const supplier = await findSupplier(access.companyId, id);
  const { archived, ...fields } = input;

  try {
    return await sequelize.transaction(async (transaction) => {
      const before = pick(supplier, AUDIT_FIELDS);
      const archivedAt = archivedAtFrom(archived, supplier.archivedAt);
      await supplier.update({ ...fields, ...(archivedAt !== undefined && { archivedAt }) }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: archiveAction("supplier", archived, !!before.archivedAt),
          entityType: "supplier",
          entityId: supplier.id,
          before,
          after: pick(supplier, AUDIT_FIELDS),
        },
        transaction,
      );
      return supplier;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}
