import cookieParser from "cookie-parser";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.js";
import { apiLimiter } from "./middlewares/rate-limit.middleware.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";

export const app = express();

// Derrière un proxy, req.ip serait l'IP du proxy pour tout le monde : un seul compteur
// partagé par tous les clients. Ne jamais mettre plus que le nombre réel de proxies,
// sinon un client pourrait falsifier son IP via l'en-tête X-Forwarded-For.
app.set("trust proxy", env.TRUST_PROXY);

app.use(express.json());
app.use(cookieParser()); // remplit req.cookies (refresh token)

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", apiLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);

// Toujours en dernier : 404 puis gestionnaire d'erreurs
app.use(notFoundHandler);
app.use(errorHandler);
