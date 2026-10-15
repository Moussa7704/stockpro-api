import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requirePermission } from "../../middlewares/auth.middleware.js";
import { idempotent } from "../../middlewares/idempotency.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import * as sessions from "./cash-sessions.service.js";
import * as paymentMethods from "./payment-methods.service.js";
import * as schemas from "./pos.schemas.js";
import * as saleReturns from "./sale-returns.service.js";
import * as sales from "./sales.service.js";
import { buildTicket } from "./ticket.js";

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);

// --- Moyens de paiement : liste pour tout membre, gestion avec company.manage
export const paymentMethodsRoutes = Router();
paymentMethodsRoutes.use(authenticate, requireCompany);

paymentMethodsRoutes.get("/", async (req: Request, res: Response) => {
  const { includeInactive } = parseQuery(z.object({ includeInactive: z.stringbool().default(false) }), req.query);
  res.json({ paymentMethods: await paymentMethods.listPaymentMethods(req.company!.companyId, includeInactive) });
});
paymentMethodsRoutes.post(
  "/",
  requirePermission("company.manage"),
  validateBody(schemas.createPaymentMethodSchema),
  async (req: Request, res: Response) => {
    const method = await paymentMethods.createPaymentMethod(req.company!, req.body, auditActor(req));
    res.status(201).json({ paymentMethod: method });
  },
);
paymentMethodsRoutes.patch(
  "/:id",
  requirePermission("company.manage"),
  byId,
  validateBody(schemas.updatePaymentMethodSchema),
  async (req: IdRequest, res: Response) => {
    const method = await paymentMethods.updatePaymentMethod(req.company!, req.params.id, req.body, auditActor(req));
    res.json({ paymentMethod: method });
  },
);

// --- Caisse
export const posRoutes = Router();
posRoutes.use(authenticate);

const canSell = requirePermission("sales.create");
const canManageSessions = requirePermission("cash_sessions.manage");
const canRefund = requirePermission("sales.cancel_refund");

// Sessions de caisse
posRoutes.get("/sessions", canManageSessions, async (req: Request, res: Response) => {
  const query = parseQuery(schemas.listSessionsQuerySchema, req.query);
  res.json(await sessions.listSessions(req.company!, query, req.user!.sub));
});
posRoutes.get("/sessions/current", canManageSessions, async (req: Request, res: Response) => {
  const { shopId } = parseQuery(z.object({ shopId: z.uuid() }), req.query);
  res.json({ session: await sessions.currentSession(req.company!, req.user!.sub, shopId) });
});
posRoutes.get("/sessions/:id", canManageSessions, byId, async (req: IdRequest, res: Response) => {
  res.json({ session: await sessions.getSession(req.company!, req.params.id) });
});
posRoutes.post("/sessions", canManageSessions, validateBody(schemas.openSessionSchema), async (req: Request, res: Response) => {
  res.status(201).json({ session: await sessions.openSession(req.company!, req.body, auditActor(req)) });
});
posRoutes.post(
  "/sessions/:id/close",
  canManageSessions,
  byId,
  validateBody(schemas.closeSessionSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ session: await sessions.closeSession(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);

// Ventes — idempotence OBLIGATOIRE : une vente rejouée après une coupure n'est jamais enregistrée deux fois
posRoutes.get("/sales", canSell, async (req: Request, res: Response) => {
  res.json(await sales.listSales(req.company!, parseQuery(schemas.listSalesQuerySchema, req.query), req.user!.sub));
});
posRoutes.get("/sales/:id", canSell, byId, async (req: IdRequest, res: Response) => {
  res.json({ sale: await sales.getSale(req.company!, req.params.id) });
});
posRoutes.get("/sales/:id/ticket", canSell, byId, async (req: IdRequest, res: Response) => {
  const ticket = await buildTicket(req.company!, req.params.id);
  if (req.query.format === "text") {
    res.type("text/plain; charset=utf-8").send(ticket.text);
    return;
  }
  res.json({ ticket });
});
posRoutes.post(
  "/sales",
  canSell,
  idempotent({ required: true }),
  validateBody(schemas.createSaleSchema),
  async (req: Request, res: Response) => {
    res.status(201).json({ sale: await sales.createSale(req.company!, req.body, auditActor(req)) });
  },
);
posRoutes.post(
  "/sales/:id/cancel",
  canRefund,
  byId,
  idempotent(),
  validateBody(schemas.cancelSaleSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ sale: await sales.cancelSale(req.company!, req.params.id, req.body.reason, auditActor(req)) });
  },
);

// Retours clients
posRoutes.get("/returns/:id", canSell, byId, async (req: IdRequest, res: Response) => {
  res.json({ return: await saleReturns.getSaleReturn(req.company!, req.params.id) });
});
posRoutes.post(
  "/returns",
  canRefund,
  idempotent({ required: true }),
  validateBody(schemas.createSaleReturnSchema),
  async (req: Request, res: Response) => {
    res.status(201).json({ return: await saleReturns.createSaleReturn(req.company!, req.body, auditActor(req)) });
  },
);
