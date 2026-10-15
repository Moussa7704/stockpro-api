import { Router, type Request, type Response } from "express";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { idempotent } from "../../middlewares/idempotency.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { paginationSchema, parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import * as payments from "./customer-payments.service.js";
import {
  createCustomerPaymentSchema,
  createCustomerSchema,
  debtorsQuerySchema,
  listCustomersQuerySchema,
  statementQuerySchema,
  updateCustomerSchema,
} from "./customers.schemas.js";
import * as customersService from "./customers.service.js";
import * as statements from "./statements.service.js";

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);

export const customersRoutes = Router();
// Caissier, gérant, comptable, propriétaire : la caisse a besoin de chercher et créer des clients
customersRoutes.use(authenticate, requirePermission("customers.manage"));

customersRoutes.get("/", async (req: Request, res: Response) => {
  res.json(await customersService.listCustomers(req.company!.companyId, parseQuery(listCustomersQuerySchema, req.query)));
});
// Impayés avec ancienneté : vue financière (gérant, comptable, propriétaire)
customersRoutes.get("/debtors", requirePermission("reports.view"), async (req: Request, res: Response) => {
  res.json(await statements.listDebtors(req.company!, parseQuery(debtorsQuerySchema, req.query)));
});
customersRoutes.get("/payments/:id", byId, async (req: IdRequest, res: Response) => {
  res.json({ payment: await payments.getCustomerPayment(req.company!, req.params.id) });
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
customersRoutes.get("/:id/statement", byId, async (req: IdRequest, res: Response) => {
  const query = parseQuery(statementQuerySchema, req.query);
  res.json({ statement: await statements.getStatement(req.company!, req.params.id, query) });
});

// Règlements de dette — idempotence obligatoire : un encaissement rejoué n'est jamais compté deux fois
customersRoutes.get("/:id/payments", byId, async (req: IdRequest, res: Response) => {
  const { page, pageSize } = parseQuery(paginationSchema, req.query);
  res.json(await payments.listCustomerPayments(req.company!, req.params.id, page, pageSize));
});
customersRoutes.post(
  "/:id/payments",
  requirePermission("customer_payments.manage"),
  byId,
  idempotent({ required: true }),
  validateBody(createCustomerPaymentSchema),
  async (req: IdRequest, res: Response) => {
    const payment = await payments.createCustomerPayment(req.company!, req.params.id, req.body, auditActor(req));
    res.status(201).json({ payment });
  },
);
