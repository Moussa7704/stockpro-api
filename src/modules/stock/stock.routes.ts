import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { Product } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import * as adjustmentsService from "./adjustments.service.js";
import * as inventoriesService from "./inventories.service.js";
import * as queries from "./stock-queries.service.js";
import * as schemas from "./stock.schemas.js";
import * as transfersService from "./transfers.service.js";

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);
const canView = requirePermission("stock.view");
const canAdjust = requirePermission("stock.adjust");
const canTransfer = requirePermission("stock.transfer");

export const stockRoutes = Router();
stockRoutes.use(authenticate);

// --- Consultation
stockRoutes.get("/", canView, async (req: Request, res: Response) => {
  res.json(await queries.listStockLevels(req.company!, parseQuery(schemas.listStockQuerySchema, req.query)));
});
stockRoutes.get("/alerts", canView, async (req: Request, res: Response) => {
  const { shopId } = parseQuery(z.object({ shopId: z.uuid().optional() }), req.query);
  res.json({ alerts: await queries.listStockAlerts(req.company!, shopId) });
});
stockRoutes.get("/movements", canView, async (req: Request, res: Response) => {
  res.json(await queries.listMovements(req.company!, parseQuery(schemas.listMovementsQuerySchema, req.query)));
});
stockRoutes.get("/products/:id", canView, byId, async (req: IdRequest, res: Response) => {
  // Le produit doit appartenir à l'entreprise (RB-01)
  const product = await Product.findOne({ where: { id: req.params.id, companyId: req.company!.companyId } });
  if (!product) {
    throw AppError.notFound("Produit introuvable");
  }
  res.json({ product: { id: product.id, sku: product.sku, name: product.name }, stock: await queries.productStock(req.company!, product.id) });
});

// --- Ajustements
stockRoutes.get("/adjustments", canView, async (req: Request, res: Response) => {
  res.json(await adjustmentsService.listAdjustments(req.company!, parseQuery(schemas.listDocumentsQuerySchema, req.query)));
});
stockRoutes.get("/adjustments/:id", canView, byId, async (req: IdRequest, res: Response) => {
  res.json({ adjustment: await adjustmentsService.getAdjustment(req.company!, req.params.id) });
});
stockRoutes.post("/adjustments", canAdjust, validateBody(schemas.createAdjustmentSchema), async (req: Request, res: Response) => {
  res.status(201).json({ adjustment: await adjustmentsService.createAdjustment(req.company!, req.body, auditActor(req)) });
});

// --- Transferts
stockRoutes.get("/transfers", canView, async (req: Request, res: Response) => {
  res.json(await transfersService.listTransfers(req.company!, parseQuery(schemas.listTransfersQuerySchema, req.query)));
});
stockRoutes.get("/transfers/:id", canView, byId, async (req: IdRequest, res: Response) => {
  res.json({ transfer: await transfersService.getTransfer(req.company!, req.params.id) });
});
stockRoutes.post("/transfers", canTransfer, validateBody(schemas.createTransferSchema), async (req: Request, res: Response) => {
  res.status(201).json({ transfer: await transfersService.createTransfer(req.company!, req.body, auditActor(req)) });
});
stockRoutes.post("/transfers/:id/ship", canTransfer, byId, async (req: IdRequest, res: Response) => {
  res.json({ transfer: await transfersService.shipTransfer(req.company!, req.params.id, auditActor(req)) });
});
stockRoutes.post(
  "/transfers/:id/receive",
  canTransfer,
  byId,
  validateBody(schemas.receiveTransferSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ transfer: await transfersService.receiveTransfer(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);
stockRoutes.post("/transfers/:id/cancel", canTransfer, byId, async (req: IdRequest, res: Response) => {
  res.json({ transfer: await transfersService.cancelTransfer(req.company!, req.params.id, auditActor(req)) });
});

// --- Inventaires
stockRoutes.get("/inventories", canView, async (req: Request, res: Response) => {
  res.json(await inventoriesService.listInventories(req.company!, parseQuery(schemas.listDocumentsQuerySchema, req.query)));
});
stockRoutes.get("/inventories/:id", canView, byId, async (req: IdRequest, res: Response) => {
  res.json({ inventory: await inventoriesService.getInventory(req.company!, req.params.id) });
});
stockRoutes.post("/inventories", canAdjust, validateBody(schemas.createInventorySchema), async (req: Request, res: Response) => {
  res.status(201).json({ inventory: await inventoriesService.createInventory(req.company!, req.body, auditActor(req)) });
});
stockRoutes.put(
  "/inventories/:id/lines",
  canAdjust,
  byId,
  validateBody(schemas.setInventoryLinesSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ inventory: await inventoriesService.setInventoryLines(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);
stockRoutes.post("/inventories/:id/validate", canAdjust, byId, async (req: IdRequest, res: Response) => {
  res.json({ inventory: await inventoriesService.validateInventory(req.company!, req.params.id, auditActor(req)) });
});
stockRoutes.post("/inventories/:id/cancel", canAdjust, byId, async (req: IdRequest, res: Response) => {
  res.json({ inventory: await inventoriesService.cancelInventory(req.company!, req.params.id, auditActor(req)) });
});
