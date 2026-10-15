import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requirePermission } from "../../middlewares/auth.middleware.js";
import { paginationSchema, parseQuery } from "../../utils/query.js";
import { listAuditLogs } from "../audit/audit.service.js";
import { listRoles } from "./roles.service.js";

const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
});

async function roles(req: Request, res: Response): Promise<void> {
  res.json({ roles: await listRoles(req.company!.companyId) });
}

async function auditLogs(req: Request, res: Response): Promise<void> {
  const query = parseQuery(auditQuerySchema, req.query);
  res.json(await listAuditLogs(req.company!.companyId, query));
}

/** Rôles disponibles (pour les formulaires d'invitation) et journal d'audit de l'entreprise. */
export const accessRoutes = Router();

accessRoutes.get("/roles", authenticate, requireCompany, roles);
accessRoutes.get("/audit-logs", authenticate, requirePermission("audit.view"), auditLogs);
