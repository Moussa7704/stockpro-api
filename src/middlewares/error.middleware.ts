import type { ErrorRequestHandler, RequestHandler } from "express";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

function isHttpError(err: unknown): err is Error & { status: number; expose: boolean } {
  return err instanceof Error && typeof (err as { status?: unknown }).status === "number";
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route introuvable : ${req.method} ${req.originalUrl}`));
};

// Chaque erreur porte le numéro de la requête : le commerçant le cite, on retrouve la ligne du journal
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = typeof req.id === "string" ? req.id : undefined;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { message: err.message, details: err.details, requestId },
    });
    return;
  }

  // Erreurs client levées par Express lui-même (JSON mal formé, corps trop gros…)
  if (isHttpError(err) && err.expose) {
    res.status(err.status).json({ error: { message: err.message, requestId } });
    return;
  }

  // Erreur inattendue : journalisée avec sa pile, mais rien n'est divulgué au client en production
  req.log.error({ err }, "Erreur inattendue");
  res.status(500).json({
    error: {
      message: "Erreur interne du serveur",
      requestId,
      ...(env.NODE_ENV === "development" && { stack: err instanceof Error ? err.stack : String(err) }),
    },
  });
};
