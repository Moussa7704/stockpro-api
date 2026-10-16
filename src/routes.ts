import type { Router } from "express";
import { accessRoutes } from "./modules/access/access.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { categoriesRoutes, productsRoutes, suppliersRoutes, unitsRoutes } from "./modules/catalog/catalog.routes.js";
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

/**
 * Routers de l'API et leur préfixe. app.ts les monte dans cet ordre ; la documentation
 * OpenAPI (docs/openapi.ts) les parcourt pour décrire chaque route. `tag` = section de la doc.
 */
export interface ApiRouter {
  prefix: string;
  router: Router;
  tag: string;
}

export const apiRouters: ApiRouter[] = [
  { prefix: "/api/auth", router: authRoutes, tag: "Authentification" },
  // Back-office de l'administrateur SaaS
  { prefix: "/api/platform", router: platformRoutes, tag: "Plateforme (admin SaaS)" },
  // Entreprise active (company_id du token)
  { prefix: "/api/company", router: companyRoutes, tag: "Entreprise" },
  { prefix: "/api/shops", router: shopsRoutes, tag: "Boutiques" },
  { prefix: "/api/members", router: membersRoutes, tag: "Membres" },
  { prefix: "/api/units", router: unitsRoutes, tag: "Catalogue" },
  { prefix: "/api/categories", router: categoriesRoutes, tag: "Catalogue" },
  { prefix: "/api/suppliers", router: suppliersRoutes, tag: "Catalogue" },
  { prefix: "/api/products", router: productsRoutes, tag: "Catalogue" },
  { prefix: "/api/stock", router: stockRoutes, tag: "Stock" },
  { prefix: "/api/purchases", router: purchasesRoutes, tag: "Achats" },
  { prefix: "/api/customers", router: customersRoutes, tag: "Clients et créances" },
  { prefix: "/api/expenses", router: expensesRoutes, tag: "Dépenses" },
  { prefix: "/api/payment-methods", router: paymentMethodsRoutes, tag: "Caisse" },
  { prefix: "/api/pos", router: posRoutes, tag: "Caisse" },
  { prefix: "/api/reports", router: reportsRoutes, tag: "Rapports" },
  { prefix: "/api", router: accessRoutes, tag: "Rôles et audit" },
];
