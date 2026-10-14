import type { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../utils/app-error.js";

// Messages d'erreur de zod en français
z.config(z.locales.fr());

/**
 * Valide req.body avec un schéma zod.
 * Si c'est valide, req.body est remplacé par les données nettoyées
 * (espaces retirés, email en minuscules, champs inconnus supprimés).
 */
export function validateBody(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.map(String).join("."),
        message: issue.message,
      }));
      return next(AppError.badRequest("Données invalides", details));
    }

    req.body = result.data;
    next();
  };
}
