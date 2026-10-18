import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { sequelize } from "./config/database.js";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.js";
import { requestLogger } from "./middlewares/request-logger.middleware.js";
import { apiLimiter } from "./middlewares/rate-limit.middleware.js";
import { createDocsRouter } from "./docs/docs.routes.js";
import { apiRouters } from "./routes.js";

export const app = express();

// Derrière un proxy, req.ip serait l'IP du proxy pour tout le monde : un seul compteur
// partagé par tous les clients. Ne jamais mettre plus que le nombre réel de proxies,
// sinon un client pourrait falsifier son IP via l'en-tête X-Forwarded-For.
app.set("trust proxy", env.TRUST_PROXY);

// En-têtes de sécurité HTTP standard (anti-clickjacking, anti "sniffing" de type MIME,
// HSTS, Content-Security-Policy…) et suppression de X-Powered-By qui révèle "Express"
app.use(helmet());

// Journal : une ligne par requête, avec son numéro (X-Request-Id)
app.use(requestLogger);

app.use(express.json());
app.use(cookieParser()); // remplit req.cookies (refresh token)

// Sonde de santé (Docker, load balancer) : l'API répond ET la base est joignable
app.get("/health", async (_req, res) => {
  try {
    await sequelize.query("SELECT 1");
    res.json({ status: "ok", database: "ok" });
  } catch {
    res.status(503).json({ status: "error", database: "unreachable" });
  }
});

app.use("/api", apiLimiter);
if (env.API_DOCS_ENABLED) {
  app.use("/api/docs", await createDocsRouter());
}
for (const { prefix, router } of apiRouters) {
  app.use(prefix, router);
}

// Toujours en dernier : 404 puis gestionnaire d'erreurs
app.use(notFoundHandler);
app.use(errorHandler);
