import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { paginationSchema, parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor, listAuditLogs } from "../audit/audit.service.js";
import { createRoleSchema, updateRoleSchema } from "./roles.schemas.js";
import * as rolesService from "./roles.service.js";

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
});

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);
const canManageRoles = requirePermission("roles.manage");

/** Rôles (lecture pour tous les membres, gestion avec roles.manage), catalogue des permissions et journal d'audit. */
export const accessRoutes = Router();

accessRoutes.get("/permissions", authenticate, requireCompany, (_req: Request, res: Response) => {
  res.json({ groups: rolesService.permissionCatalog() });
});

accessRoutes.get("/roles", authenticate, requireCompany, async (req: Request, res: Response) => {
  res.json({ roles: await rolesService.listRoles(req.company!) });
});
accessRoutes.post("/roles", authenticate, canManageRoles, validateBody(createRoleSchema), async (req: Request, res: Response) => {
  res.status(201).json({ role: await rolesService.createRole(req.company!, req.body, auditActor(req)) });
});
accessRoutes.patch(
  "/roles/:id",
  authenticate,
  canManageRoles,
  byId,
  validateBody(updateRoleSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ role: await rolesService.updateRole(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);
accessRoutes.delete("/roles/:id", authenticate, canManageRoles, byId, async (req: IdRequest, res: Response) => {
  await rolesService.deleteRole(req.company!, req.params.id, auditActor(req));
  res.status(204).end();
});

accessRoutes.get("/audit-logs", authenticate, requirePermission("audit.view"), async (req: Request, res: Response) => {
  res.json(await listAuditLogs(req.company!.companyId, parseQuery(auditQuerySchema, req.query)));
});
