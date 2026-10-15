import { z } from "zod";
import { AppError } from "./app-error.js";

/**
 * Valide les paramètres d'URL (?page=2&pageSize=50…).
 * Express 5 ne permet pas de remplacer req.query : on renvoie la version nettoyée.
 */
export function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const result = schema.safeParse(query);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw AppError.badRequest("Paramètres invalides", details);
  }
  return result.data;
}

/** Pagination commune à toutes les listes : 20 par page, 100 au maximum. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const uuidParamsSchema = z.object({
  id: z.uuid("Identifiant invalide"),
});
