import { Router, type Request, type Response } from "express";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { idempotent } from "../../middlewares/idempotency.middleware.js";
import { validateBody, validateParams } from "../../middlewares/validate.middleware.js";
import { includeArchivedQuerySchema, parseQuery, uuidParamsSchema } from "../../utils/query.js";
import { auditActor } from "../audit/audit.service.js";
import * as schemas from "./expenses.schemas.js";
import * as expenses from "./expenses.service.js";

type IdRequest = Request<{ id: string }>;
const byId = validateParams(uuidParamsSchema);

// Gérant, comptable, propriétaire
export const expensesRoutes = Router();
expensesRoutes.use(authenticate, requirePermission("expenses.manage"));

// Catégories
expensesRoutes.get("/categories", async (req: Request, res: Response) => {
  const { includeArchived } = parseQuery(includeArchivedQuerySchema, req.query);
  res.json({ categories: await expenses.listExpenseCategories(req.company!.companyId, includeArchived) });
});
expensesRoutes.post("/categories", validateBody(schemas.createExpenseCategorySchema), async (req: Request, res: Response) => {
  res.status(201).json({ category: await expenses.createExpenseCategory(req.company!, req.body, auditActor(req)) });
});
expensesRoutes.patch(
  "/categories/:id",
  byId,
  validateBody(schemas.updateExpenseCategorySchema),
  async (req: IdRequest, res: Response) => {
    res.json({ category: await expenses.updateExpenseCategory(req.company!, req.params.id, req.body, auditActor(req)) });
  },
);

// Dépenses
expensesRoutes.get("/", async (req: Request, res: Response) => {
  res.json(await expenses.listExpenses(req.company!, parseQuery(schemas.listExpensesQuerySchema, req.query)));
});
expensesRoutes.get("/:id", byId, async (req: IdRequest, res: Response) => {
  res.json({ expense: await expenses.getExpense(req.company!, req.params.id) });
});
expensesRoutes.post("/", idempotent(), validateBody(schemas.createExpenseSchema), async (req: Request, res: Response) => {
  res.status(201).json({ expense: await expenses.createExpense(req.company!, req.body, auditActor(req)) });
});
expensesRoutes.post(
  "/:id/cancel",
  byId,
  idempotent(),
  validateBody(schemas.cancelExpenseSchema),
  async (req: IdRequest, res: Response) => {
    res.json({ expense: await expenses.cancelExpense(req.company!, req.params.id, req.body.reason, auditActor(req)) });
  },
);
