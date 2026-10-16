import type { RequestHandler } from "express";
import { z } from "zod";
import { withMeta } from "../docs/route-meta.js";
import { AppError } from "../utils/app-error.js";

// Messages d'erreur de zod en français
z.config(z.locales.fr());

function toDetails(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * Valide req.body avec un schéma zod.
 * Si c'est valide, req.body est remplacé par les données nettoyées
 * (espaces retirés, email en minuscules, champs inconnus supprimés).
 */
export function validateBody(schema: z.ZodType): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return next(AppError.badRequest("Données invalides", toDetails(result.error)));
    }

    req.body = result.data;
    next();
  };
  return withMeta(handler, { kind: "body", schema });
}

/** Valide les paramètres d'URL (ex. :id doit être un UUID) : 400 au lieu d'une erreur SQL. */
export function validateParams(schema: z.ZodType): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      return next(AppError.badRequest("Paramètres invalides", toDetails(result.error)));
    }
    next();
  };
  return withMeta(handler, { kind: "params", schema });
}
