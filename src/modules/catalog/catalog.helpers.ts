import { UniqueConstraintError } from "sequelize";
import { AppError } from "../../utils/app-error.js";

/** Nom de la contrainte PostgreSQL violée (ex. "products_company_sku_key"). */
export function violatedConstraint(error: unknown): string | undefined {
  if (!(error instanceof UniqueConstraintError)) {
    return undefined;
  }
  const original = error.original as { constraint?: string } | undefined;
  return original?.constraint ?? "unique";
}

/** Traduit une violation d'unicité en 409 lisible ; relance toute autre erreur. */
export function rethrowAsConflict(error: unknown, messages: Record<string, string>, fallback: string): never {
  const constraint = violatedConstraint(error);
  if (constraint) {
    throw AppError.conflict(messages[constraint] ?? fallback);
  }
  throw error;
}

/** Recherche "contient" sans que % ou _ tapés par l'utilisateur soient des jokers SQL. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** archived: true/false → nouvelle valeur de archivedAt (on garde la date d'origine si déjà archivé). */
export function archivedAtFrom(archived: boolean | undefined, current: Date | null): Date | null | undefined {
  if (archived === undefined) {
    return undefined;
  }
  return archived ? (current ?? new Date()) : null;
}

export function archiveAction(prefix: string, archived: boolean | undefined, wasArchived: boolean): string {
  if (archived === true && !wasArchived) return `${prefix}.archive`;
  if (archived === false && wasArchived) return `${prefix}.restore`;
  return `${prefix}.update`;
}
