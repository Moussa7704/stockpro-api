import { Router, type Request, type Response } from "express";
import { authenticate, requirePermission } from "../../middlewares/auth.middleware.js";
import { parseQuery } from "../../utils/query.js";
import { sendReport } from "./exporters.js";
import * as schemas from "./reports.schemas.js";
import * as reports from "./reports.service.js";
import * as tables from "./reports.tables.js";

// Gérant, comptable, propriétaire. ?format=xlsx|pdf → fichier à télécharger
export const reportsRoutes = Router();
reportsRoutes.use(authenticate, requirePermission("reports.view"));

reportsRoutes.get("/dashboard", async (req: Request, res: Response) => {
  res.json({ dashboard: await reports.dashboard(req.company!, parseQuery(schemas.dashboardQuerySchema, req.query)) });
});

reportsRoutes.get("/sales", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.salesReportQuerySchema, req.query);
  const report = await reports.salesReport(req.company!, query);
  const subtitle = query.format === "json" ? [] : await tables.headerLines(req.company!, query.shopId, query);
  await sendReport(res, query.format, report, (data) => tables.salesTable(data, subtitle));
});

reportsRoutes.get("/top-products", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.topProductsQuerySchema, req.query);
  const report = await reports.topProducts(req.company!, query);
  const subtitle = query.format === "json" ? [] : await tables.headerLines(req.company!, query.shopId, query);
  await sendReport(res, query.format, report, (data) => tables.topProductsTable(data, subtitle));
});

reportsRoutes.get("/stock-value", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.stockValueQuerySchema, req.query);
  const report = await reports.stockValue(req.company!, query);
  const subtitle = query.format === "json" ? [] : await tables.headerLines(req.company!, query.shopId);
  await sendReport(res, query.format, report, (data) => tables.stockValueTable(data, subtitle));
});

reportsRoutes.get("/expenses", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.periodQuerySchema, req.query);
  const report = await reports.expensesReport(req.company!, query);
  const subtitle = query.format === "json" ? [] : await tables.headerLines(req.company!, query.shopId, query);
  await sendReport(res, query.format, report, (data) => tables.expensesTable(data, subtitle));
});

reportsRoutes.get("/profit-and-loss", async (req: Request, res: Response) => {
  const query = parseQuery(schemas.periodQuerySchema, req.query);
  const report = await reports.profitAndLoss(req.company!, query);
  const subtitle = query.format === "json" ? [] : await tables.headerLines(req.company!, query.shopId, query);
  await sendReport(res, query.format, report, (data) => tables.profitAndLossTable(data, subtitle));
});
