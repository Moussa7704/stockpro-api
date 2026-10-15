import { Router, type Request, type Response } from "express";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { idempotent } from "../../middlewares/idempotency.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import * as invoices from "./invoices.service.js";
import * as orders from "./orders.service.js";
import * as schemas from "./purchases.schemas.js";
import * as receipts from "./receipts.service.js";
import * as returns from "./returns.service.js";

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);
// Commandes, réceptions, retours : gestionnaire de stock, gérant, propriétaire
const canPurchase = requirePermission("purchases.manage");
// Factures et paiements : comptable, propriétaire
const canPay = requirePermission("supplier_payments.manage");

export const purchasesRoutes = Router();
purchasesRoutes.use(authenticate);

// --- Bons de commande
purchasesRoutes.get("/orders", canPurchase, async (req: Request, res: Response) => {
  res.json(await orders.listOrders(req.company!, parseQuery(schemas.listOrdersQuerySchema, req.query)));
});
purchasesRoutes.get("/orders/:id", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ order: await orders.getOrder(req.company!, req.params.id) });
});
purchasesRoutes.post("/orders", canPurchase, validateBody(schemas.createOrderSchema), async (req: Request, res: Response) => {
  res.status(201).json({ order: await orders.createOrder(req.company!, req.body, auditActor(req)) });
});
purchasesRoutes.patch(
  "/orders/:id",
  canPurchase,
  byId,
  validateBody(schemas.updateOrderSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ order: await orders.updateOrder(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);
purchasesRoutes.post("/orders/:id/send", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ order: await orders.sendOrder(req.company!, req.params.id, auditActor(req)) });
});
purchasesRoutes.post("/orders/:id/cancel", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ order: await orders.cancelOrder(req.company!, req.params.id, auditActor(req)) });
});
purchasesRoutes.post("/orders/:id/close", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ order: await orders.closeOrder(req.company!, req.params.id, auditActor(req)) });
});

// --- Réceptions
purchasesRoutes.get("/receipts", canPurchase, async (req: Request, res: Response) => {
  res.json(await receipts.listReceipts(req.company!, parseQuery(schemas.listReceiptsQuerySchema, req.query)));
});
purchasesRoutes.get("/receipts/:id", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ receipt: await receipts.getReceipt(req.company!, req.params.id) });
});
purchasesRoutes.post("/receipts", canPurchase, validateBody(schemas.createReceiptSchema), async (req: Request, res: Response) => {
  res.status(201).json({ receipt: await receipts.createReceipt(req.company!, req.body, auditActor(req)) });
});
// Augmente le stock : une validation rejouée après une coupure ne doit rien refaire
purchasesRoutes.post("/receipts/:id/validate", canPurchase, byId, idempotent(), async (req: IdRequest, res: Response) => {
  res.json({ receipt: await receipts.validateReceipt(req.company!, req.params.id, auditActor(req)) });
});
purchasesRoutes.post("/receipts/:id/cancel", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ receipt: await receipts.cancelReceipt(req.company!, req.params.id, auditActor(req)) });
});

// --- Retours fournisseurs
purchasesRoutes.get("/returns", canPurchase, async (req: Request, res: Response) => {
  res.json(await returns.listReturns(req.company!, parseQuery(schemas.listReturnsQuerySchema, req.query)));
});
purchasesRoutes.get("/returns/:id", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ return: await returns.getReturn(req.company!, req.params.id) });
});
purchasesRoutes.post("/returns", canPurchase, validateBody(schemas.createReturnSchema), async (req: Request, res: Response) => {
  res.status(201).json({ return: await returns.createReturn(req.company!, req.body, auditActor(req)) });
});
purchasesRoutes.post("/returns/:id/validate", canPurchase, byId, idempotent(), async (req: IdRequest, res: Response) => {
  res.json({ return: await returns.validateReturn(req.company!, req.params.id, auditActor(req)) });
});
purchasesRoutes.post("/returns/:id/cancel", canPurchase, byId, async (req: IdRequest, res: Response) => {
  res.json({ return: await returns.cancelReturn(req.company!, req.params.id, auditActor(req)) });
});

// --- Factures, paiements et dettes fournisseurs
purchasesRoutes.get("/invoices", canPay, async (req: Request, res: Response) => {
  res.json(await invoices.listInvoices(req.company!, parseQuery(schemas.listInvoicesQuerySchema, req.query)));
});
purchasesRoutes.get("/invoices/:id", canPay, byId, async (req: IdRequest, res: Response) => {
  res.json({ invoice: await invoices.getInvoice(req.company!, req.params.id) });
});
purchasesRoutes.post("/invoices", canPay, validateBody(schemas.createInvoiceSchema), async (req: Request, res: Response) => {
  res.status(201).json({ invoice: await invoices.createInvoice(req.company!, req.body, auditActor(req)) });
});
purchasesRoutes.post(
  "/invoices/:id/payments",
  canPay,
  byId,
  idempotent(),
  validateBody(schemas.createSupplierPaymentSchema),
  async (req: IdRequest, res: Response) => {
    res.status(201).json({ invoice: await invoices.addPayment(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);
purchasesRoutes.post("/invoices/:id/cancel", canPay, byId, async (req: IdRequest, res: Response) => {
  res.json({ invoice: await invoices.cancelInvoice(req.company!, req.params.id, auditActor(req)) });
});
purchasesRoutes.get("/supplier-balances", canPay, async (req: Request, res: Response) => {
  res.json({ balances: await invoices.supplierBalances(req.company!) });
});
