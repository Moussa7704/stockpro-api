import { Router, type Request, type Response } from "express";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import { inviteMemberSchema, updateMemberSchema } from "./members.schemas.js";
import * as membersService from "./members.service.js";

async function list(req: Request, res: Response): Promise<void> {
  res.json({ members: await membersService.listMembers(req.company!.companyId) });
}

async function invite(req: Request, res: Response): Promise<void> {
  const member = await membersService.inviteMember(req.company!, req.body, auditActor(req));
  res.status(201).json({ member });
}

async function update(req: Request<{ id: string }>, res: Response): Promise<void> {
  const member = await membersService.updateMember(req.company!, req.params.id, req.body, auditActor(req));
  res.json({ member });
}

async function resendInvitation(req: Request<{ id: string }>, res: Response): Promise<void> {
  await membersService.resendMemberInvitation(req.company!, req.params.id, auditActor(req));
  res.json({ message: "Invitation renvoyée" });
}

export const membersRoutes = Router();

// Équipe de l'entreprise active : réservé à la permission users.manage (propriétaire par défaut)
membersRoutes.use(authenticate, requirePermission("users.manage"));

membersRoutes.get("/", list);
membersRoutes.post("/", validateBody(inviteMemberSchema), invite);
membersRoutes.patch("/:id", validateParams(uuidParamsSchema), validateBody(updateMemberSchema), update);
membersRoutes.post("/:id/invite", validateParams(uuidParamsSchema), resendInvitation);
