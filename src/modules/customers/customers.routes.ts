import { Router, type Request, type Response } from "express";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { paginationSchema, parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import { createCustomerSchema, listCustomersQuerySchema, updateCustomerSchema } from "./customers.schemas.js";
import * as customersService from "./customers.service.js";

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);

export const customersRoutes = Router();
// Caissier, gérant, comptable, propriétaire : la caisse a besoin de chercher et créer des clients
customersRoutes.use(authenticate, requirePermission("customers.manage"));

customersRoutes.get("/", async (req: Request, res: Response) => {
  res.json(await customersService.listCustomers(req.company!.companyId, parseQuery(listCustomersQuerySchema, req.query)));
});
customersRoutes.get("/:id", byId, async (req: IdRequest, res: Response) => {
  res.json({ customer: await customersService.getCustomer(req.company!.companyId, req.params.id) });
});
customersRoutes.get("/:id/ledger", byId, async (req: IdRequest, res: Response) => {
  const { page, pageSize } = parseQuery(paginationSchema, req.query);
  res.json(await customersService.listLedger(req.company!.companyId, req.params.id, page, pageSize));
});
customersRoutes.post("/", validateBody(createCustomerSchema), async (req: Request, res: Response) => {
  res.status(201).json({ customer: await customersService.createCustomer(req.company!, req.body, auditActor(req)) });
});
customersRoutes.patch("/:id", byId, validateBody(updateCustomerSchema), async (req: IdRequest, res: Response) => {
  res.json({ customer: await customersService.updateCustomer(req.company!, req.params.id, req.body, auditActor(req)) });
});
