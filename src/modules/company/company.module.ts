import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sequelize } from "../../config/database.js";
import { authenticate, requireCompany, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import { Company } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { auditActor, pick, recordAudit } from "../audit/audit.service.js";
import { timezoneSchema } from "../platform/platform.schemas.js";

/**
 * Paramètres de l'entreprise active (côté commerçant).
 * La devise n'est pas modifiable (D-01) ; le statut ne se change que depuis la plateforme.
 */

const updateCompanySettingsSchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    timezone: timezoneSchema.optional(),
    settings: z
      .object({
        // Remise maximale qu'un caissier peut accorder sans permission sales.discount (RB-10)
        maxCashierDiscountPercent: z.number().min(0).max(100).optional(),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

const AUDIT_FIELDS: (keyof Company)[] = ["name", "timezone", "settings"];

async function getCurrentCompany(req: Request, res: Response): Promise<void> {
  const company = await Company.findByPk(req.company!.companyId);
  res.json({ company });
}

async function updateCurrentCompany(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof updateCompanySettingsSchema>;

  const company = await sequelize.transaction(async (transaction) => {
    const current = await Company.findByPk(req.company!.companyId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!current) {
      throw AppError.notFound("Entreprise introuvable");
    }

    const before = pick(current, AUDIT_FIELDS);
    await current.update(
      {
        ...(input.name && { name: input.name }),
        ...(input.timezone && { timezone: input.timezone }),
        // Les paramètres sont fusionnés : on ne perd pas ceux qui ne sont pas envoyés
        ...(input.settings && { settings: { ...current.settings, ...input.settings } }),
      },
      { transaction },
    );

    await recordAudit(
      {
        ...auditActor(req),
        companyId: current.id,
        action: "company.settings_update",
        entityType: "company",
        entityId: current.id,
        before,
        after: pick(current, AUDIT_FIELDS),
      },
      transaction,
    );
    return current;
  });

  res.json({ company });
}

export const companyRoutes = Router();

companyRoutes.get("/", authenticate, requireCompany, getCurrentCompany);
companyRoutes.patch(
  "/",
  authenticate,
  requirePermission("company.manage"),
  validateBody(updateCompanySettingsSchema),
  updateCurrentCompany,
);
