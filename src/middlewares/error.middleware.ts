import type { ErrorRequestHandler, RequestHandler } from "express";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

function isHttpError(err: unknown): err is Error & { status: number; expose: boolean } {
  return err instanceof Error && typeof (err as { status?: unknown }).status === "number";
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route introuvable : ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { message: err.message, details: err.details },
    });
    return;
  }

  // Erreurs client levées par Express lui-même (JSON mal formé, corps trop gros…)
  if (isHttpError(err) && err.expose) {
    res.status(err.status).json({ error: { message: err.message } });
    return;
  }

  // Erreur inattendue : on la journalise, mais on ne divulgue rien au client en production
  console.error(err);
  res.status(500).json({
    error: {
      message: "Erreur interne du serveur",
      ...(env.NODE_ENV === "development" && { stack: err instanceof Error ? err.stack : String(err) }),
    },
  });
};
