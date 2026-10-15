import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.js";
import { apiLimiter } from "./middlewares/rate-limit.middleware.js";
import { accessRoutes } from "./modules/access/access.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import {
  categoriesRoutes,
  productsRoutes,
  suppliersRoutes,
  unitsRoutes,
} from "./modules/catalog/catalog.routes.js";
import { companyRoutes } from "./modules/company/company.module.js";
import { customersRoutes } from "./modules/customers/customers.routes.js";
import { expensesRoutes } from "./modules/expenses/expenses.routes.js";
import { membersRoutes } from "./modules/members/members.routes.js";
import { platformRoutes } from "./modules/platform/platform.routes.js";
import { paymentMethodsRoutes, posRoutes } from "./modules/pos/pos.routes.js";
import { purchasesRoutes } from "./modules/purchases/purchases.routes.js";
import { reportsRoutes } from "./modules/reports/reports.routes.js";
import { shopsRoutes } from "./modules/shops/shops.routes.js";
import { stockRoutes } from "./modules/stock/stock.routes.js";

export const app = express();

// Derrière un proxy, req.ip serait l'IP du proxy pour tout le monde : un seul compteur
// partagé par tous les clients. Ne jamais mettre plus que le nombre réel de proxies,
// sinon un client pourrait falsifier son IP via l'en-tête X-Forwarded-For.
app.set("trust proxy", env.TRUST_PROXY);

// En-têtes de sécurité HTTP standard (anti-clickjacking, anti "sniffing" de type MIME,
// HSTS, Content-Security-Policy…) et suppression de X-Powered-By qui révèle "Express"
app.use(helmet());

app.use(express.json());
app.use(cookieParser()); // remplit req.cookies (refresh token)

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", apiLimiter);
app.use("/api/auth", authRoutes);
// Back-office de l'administrateur SaaS
app.use("/api/platform", platformRoutes);
// Entreprise active (company_id du token)
app.use("/api/company", companyRoutes);
app.use("/api/shops", shopsRoutes);
app.use("/api/members", membersRoutes);
app.use("/api/units", unitsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/suppliers", suppliersRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/purchases", purchasesRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/payment-methods", paymentMethodsRoutes);
app.use("/api/pos", posRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api", accessRoutes);

// Toujours en dernier : 404 puis gestionnaire d'erreurs
app.use(notFoundHandler);
app.use(errorHandler);
