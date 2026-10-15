import type { Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Unit } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { archiveAction, archivedAtFrom, rethrowAsConflict } from "./catalog.helpers.js";
import type { CreateUnitInput, UpdateUnitInput } from "./catalog.schemas.js";

// Créées avec chaque nouvelle entreprise
export const DEFAULT_UNITS = [
  { name: "Pièce", symbol: "pce", allowsDecimal: false },
  { name: "Kilogramme", symbol: "kg", allowsDecimal: true },
  { name: "Litre", symbol: "L", allowsDecimal: true },
  { name: "Mètre", symbol: "m", allowsDecimal: true },
];

const AUDIT_FIELDS: (keyof Unit)[] = ["name", "symbol", "allowsDecimal", "archivedAt"];
const DUPLICATE = "Une unité porte déjà ce nom";

export async function createDefaultUnits(companyId: string, transaction: Transaction): Promise<void> {
  await Unit.bulkCreate(
    DEFAULT_UNITS.map((unit) => ({ ...unit, companyId })),
    { transaction },
  );
}

export async function listUnits(companyId: string, includeArchived: boolean): Promise<Unit[]> {
  return Unit.findAll({
    where: { companyId, ...(!includeArchived && { archivedAt: null }) },
    order: [["name", "ASC"]],
  });
}

/** Unité de l'entreprise ; 404 sinon (y compris si elle appartient à une autre entreprise). */
export async function findUnit(companyId: string, id: string, transaction?: Transaction): Promise<Unit> {
  const unit = await Unit.findOne({ where: { id, companyId }, transaction });
  if (!unit) {
    throw AppError.notFound("Unité introuvable");
  }
  return unit;
}

export async function createUnit(access: CompanyAccess, input: CreateUnitInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const unit = await Unit.create({ ...input, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "unit.create",
          entityType: "unit",
          entityId: unit.id,
          after: pick(unit, AUDIT_FIELDS),
        },
        transaction,
      );
      return unit;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}

export async function updateUnit(access: CompanyAccess, id: string, input: UpdateUnitInput, actor: AuditActor) {
  const unit = await findUnit(access.companyId, id);
  const { archived, ...fields } = input;

  try {
    return await sequelize.transaction(async (transaction) => {
      const before = pick(unit, AUDIT_FIELDS);
      const archivedAt = archivedAtFrom(archived, unit.archivedAt);
      await unit.update({ ...fields, ...(archivedAt !== undefined && { archivedAt }) }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: archiveAction("unit", archived, !!before.archivedAt),
          entityType: "unit",
          entityId: unit.id,
          before,
          after: pick(unit, AUDIT_FIELDS),
        },
        transaction,
      );
      return unit;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, DUPLICATE);
  }
}
