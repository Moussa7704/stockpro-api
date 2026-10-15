import type { Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { PaymentMethod } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { rethrowAsConflict } from "../catalog/catalog.helpers.js";
import type { CreatePaymentMethodInput, UpdatePaymentMethodInput } from "./pos.schemas.js";

// Créés avec chaque nouvelle entreprise
export const DEFAULT_PAYMENT_METHODS = [
  { code: "cash", name: "Espèces", type: "cash" as const, sortOrder: 1 },
  { code: "mobile_money", name: "Mobile Money", type: "mobile_money" as const, sortOrder: 2 },
  { code: "card", name: "Carte bancaire", type: "card" as const, sortOrder: 3 },
];

const AUDIT_FIELDS: (keyof PaymentMethod)[] = ["code", "name", "type", "active"];

export async function createDefaultPaymentMethods(companyId: string, transaction: Transaction): Promise<void> {
  await PaymentMethod.bulkCreate(
    DEFAULT_PAYMENT_METHODS.map((method) => ({ ...method, companyId })),
    { transaction },
  );
}

export async function listPaymentMethods(companyId: string, includeInactive: boolean) {
  return PaymentMethod.findAll({
    where: { companyId, ...(!includeInactive && { active: true }) },
    order: [
      ["sortOrder", "ASC"],
      ["name", "ASC"],
    ],
  });
}

/** Moyens de paiement actifs de l'entreprise, indexés par id ; 400 si l'un est inconnu. */
export async function loadActiveMethods(companyId: string, ids: string[], transaction: Transaction) {
  const methods = await PaymentMethod.findAll({ where: { companyId, id: ids, active: true }, transaction });
  const byId = new Map(methods.map((method) => [method.id, method]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw AppError.badRequest("Moyen de paiement inconnu ou désactivé");
    }
  }
  return byId;
}

export async function createPaymentMethod(access: CompanyAccess, input: CreatePaymentMethodInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const method = await PaymentMethod.create({ ...input, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "payment_method.create",
          entityType: "payment_method",
          entityId: method.id,
          after: pick(method, AUDIT_FIELDS),
        },
        transaction,
      );
      return method;
    });
  } catch (error) {
    rethrowAsConflict(error, {}, "Un moyen de paiement utilise déjà ce code");
  }
}

export async function updatePaymentMethod(
  access: CompanyAccess,
  id: string,
  input: UpdatePaymentMethodInput,
  actor: AuditActor,
) {
  const method = await PaymentMethod.findOne({ where: { id, companyId: access.companyId } });
  if (!method) {
    throw AppError.notFound("Moyen de paiement introuvable");
  }
  return sequelize.transaction(async (transaction) => {
    const before = pick(method, AUDIT_FIELDS);
    await method.update(input, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "payment_method.update",
        entityType: "payment_method",
        entityId: method.id,
        before,
        after: pick(method, AUDIT_FIELDS),
      },
      transaction,
    );
    return method;
  });
}
