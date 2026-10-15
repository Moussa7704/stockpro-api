import type { Request } from "express";
import type { Transaction } from "sequelize";
import { AuditLog, User } from "../../models/index.js";

/** Auteur et contexte réseau d'une action, extraits de la requête. */
export interface AuditActor {
  actorUserId: string | null;
  ip: string | null;
}

export function auditActor(req: Request): AuditActor {
  return { actorUserId: req.user?.sub ?? null, ip: req.ip ?? null };
}

export interface AuditEntry extends AuditActor {
  companyId: string | null;
  shopId?: string | null;
  action: string; // ex. "shop.create", "member.role_change"
  entityType?: string;
  entityId?: string;
  // Ne jamais y mettre de secret (mot de passe, jeton…) : le journal est consultable
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Enregistre une opération sensible (RB-07). À appeler dans la même transaction que
 * l'opération : si elle est annulée, la ligne d'audit l'est aussi.
 */
export async function recordAudit(entry: AuditEntry, transaction?: Transaction): Promise<void> {
  await AuditLog.create(
    {
      companyId: entry.companyId,
      shopId: entry.shopId ?? null,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: entry.ip,
    },
    { transaction },
  );
}

/** Ne garde que les champs utiles d'un objet pour le journal (avant / après). */
export function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: string;
  entityType?: string;
}

export async function listAuditLogs(companyId: string, query: AuditQuery) {
  const where = {
    companyId,
    ...(query.action && { action: query.action }),
    ...(query.entityType && { entityType: query.entityType }),
  };

  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  // Nom de l'auteur pour l'affichage (une seule requête pour toute la page)
  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => !!id))];
  const actors = await User.findAll({ where: { id: actorIds }, attributes: ["id", "name", "email"] });
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  return {
    items: rows.map((row) => ({
      ...row.toJSON(),
      actor: row.actorUserId
        ? {
            id: row.actorUserId,
            name: actorById.get(row.actorUserId)?.name ?? null,
            email: actorById.get(row.actorUserId)?.email ?? null,
          }
        : null,
    })),
    total: count,
    page: query.page,
    pageSize: query.pageSize,
  };
}
