import { Router, type Request, type Response } from "express";
import { authenticate, requireCompany, requirePermission } from "../../middlewares/auth.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { includeArchivedQuerySchema, parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import * as schemas from "./catalog.schemas.js";
import * as categoriesService from "./categories.service.js";
import * as productsService from "./products.service.js";
import * as suppliersService from "./suppliers.service.js";
import * as unitsService from "./units.service.js";

type IdRequest = Request<{ id: string }>;

const byId = validateParams(uuidParamsSchema);
const canManageProducts = requirePermission("products.manage");

// --- Unités : lecture pour tout membre, gestion avec products.manage
export const unitsRoutes = Router();
unitsRoutes.use(authenticate, requireCompany);

unitsRoutes.get("/", async (req: Request, res: Response) => {
  const { includeArchived } = parseQuery(includeArchivedQuerySchema, req.query);
  res.json({ units: await unitsService.listUnits(req.company!.companyId, includeArchived) });
});
unitsRoutes.post("/", canManageProducts, validateBody(schemas.createUnitSchema), async (req: Request, res: Response) => {
  res.status(201).json({ unit: await unitsService.createUnit(req.company!, req.body, auditActor(req)) });
});
unitsRoutes.patch(
  "/:id",
  canManageProducts,
  byId,
  validateBody(schemas.updateUnitSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ unit: await unitsService.updateUnit(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);

// --- Catégories : lecture pour tout membre, gestion avec products.manage
export const categoriesRoutes = Router();
categoriesRoutes.use(authenticate, requireCompany);

categoriesRoutes.get("/", async (req: Request, res: Response) => {
  const { includeArchived } = parseQuery(includeArchivedQuerySchema, req.query);
  res.json({ categories: await categoriesService.listCategories(req.company!.companyId, includeArchived) });
});
categoriesRoutes.post(
  "/",
  canManageProducts,
  validateBody(schemas.createCategorySchema),
  async (req: Request, res: Response) => {
    const category = await categoriesService.createCategory(req.company!, req.body, auditActor(req));
    res.status(201).json({ category });
  },
);
categoriesRoutes.patch(
  "/:id",
  canManageProducts,
  byId,
  validateBody(schemas.updateCategorySchema),
  async (req: IdRequest, res: Response) => {
    const category = await categoriesService.updateCategory(req.company!, req.params.id, req.body, auditActor(req));
    res.json({ category });
  },
);

// --- Fournisseurs : lecture avec products.view, gestion avec purchases.manage
export const suppliersRoutes = Router();
suppliersRoutes.use(authenticate);

suppliersRoutes.get("/", requirePermission("products.view"), async (req: Request, res: Response) => {
  const query = parseQuery(schemas.listSuppliersQuerySchema, req.query);
  res.json(await suppliersService.listSuppliers(req.company!.companyId, query));
});
suppliersRoutes.get("/:id", requirePermission("products.view"), byId, async (req: IdRequest, res: Response) => {
  res.json({ supplier: await suppliersService.findSupplier(req.company!.companyId, req.params.id) });
});
suppliersRoutes.post(
  "/",
  requirePermission("purchases.manage"),
  validateBody(schemas.createSupplierSchema),
  async (req: Request, res: Response) => {
    const supplier = await suppliersService.createSupplier(req.company!, req.body, auditActor(req));
    res.status(201).json({ supplier });
  },
);
suppliersRoutes.patch(
  "/:id",
  requirePermission("purchases.manage"),
  byId,
  validateBody(schemas.updateSupplierSchema),
  async (req: IdRequest, res: Response) => {
    const supplier = await suppliersService.updateSupplier(req.company!, req.params.id, req.body, auditActor(req));
    res.json({ supplier });
  },
);

// --- Produits : lecture avec products.view, gestion avec products.manage (+ prices.manage pour les prix)
export const productsRoutes = Router();
productsRoutes.use(authenticate, requirePermission("products.view"));

productsRoutes.get("/", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.listProductsQuerySchema, req.query);
  res.json(await productsService.listProducts(req.company!.companyId, query));
});
// Avant "/:id" : sinon "lookup" serait pris pour un identifiant
productsRoutes.get("/lookup", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.lookupProductQuerySchema, req.query);
  res.json({ product: await productsService.lookupProduct(req.company!.companyId, query) });
});
productsRoutes.get("/:id", byId, async (req: IdRequest, res: Response) => {
  res.json({ product: await productsService.findProduct(req.company!.companyId, req.params.id) });
});
productsRoutes.post(
  "/",
  canManageProducts,
  validateBody(schemas.createProductSchema),
  async (req: Request, res: Response) => {
    const product = await productsService.createProduct(req.company!, req.body, auditActor(req));
    res.status(201).json({ product });
  },
);
productsRoutes.patch(
  "/:id",
  canManageProducts,
  byId,
  validateBody(schemas.updateProductSchema),
  async (req: IdRequest, res: Response) => {
    const product = await productsService.updateProduct(req.company!, req.params.id, req.body, auditActor(req));
    res.json({ product });
  },
);
