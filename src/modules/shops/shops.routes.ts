import { Router, type Request, type Response } from "express";
import { authenticate, requireCompany, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import { createShopSchema, listShopsQuerySchema, updateShopSchema } from "./shops.schemas.js";
import * as shopsService from "./shops.service.js";

async function list(req: Request, res: Response): Promise<void> {
  const { includeArchived } = parseQuery(listShopsQuerySchema, req.query);
  res.json({ shops: await shopsService.listShops(req.company!, includeArchived) });
}

async function get(req: Request<{ id: string }>, res: Response): Promise<void> {
  res.json({ shop: await shopsService.findAccessibleShop(req.company!, req.params.id) });
}

async function create(req: Request, res: Response): Promise<void> {
  const shop = await shopsService.createShop(req.company!, req.body, auditActor(req));
  res.status(201).json({ shop });
}

async function update(req: Request<{ id: string }>, res: Response): Promise<void> {
  const shop = await shopsService.updateShop(req.company!, req.params.id, req.body, auditActor(req));
  res.json({ shop });
}

export const shopsRoutes = Router();

// Tout membre voit les boutiques de son périmètre ; seul company.manage les crée et les modifie
shopsRoutes.use(authenticate, requireCompany);

shopsRoutes.get("/", list);
shopsRoutes.get("/:id", validateParams(uuidParamsSchema), get);
shopsRoutes.post("/", requirePermission("company.manage"), validateBody(createShopSchema), create);
shopsRoutes.patch(
  "/:id",
  requirePermission("company.manage"),
  validateParams(uuidParamsSchema),
  validateBody(updateShopSchema),
  update,
);
