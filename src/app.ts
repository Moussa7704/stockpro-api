import express from "express";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.js";
import { authRoutes } from "./modules/auth/auth.routes.js";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);

// Toujours en dernier : 404 puis gestionnaire d'erreurs
app.use(notFoundHandler);
app.use(errorHandler);
