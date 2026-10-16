import type { RequestHandler } from "express";
import type { z } from "zod";
import type { Permission } from "../modules/access/permissions.js";

/**
 * Métadonnées attachées aux middlewares (schéma du body, permission exigée, idempotence…).
 * Le générateur OpenAPI (docs/openapi.ts) les relit en parcourant les routers Express :
 * la documentation suit le code au lieu d'être recopiée à la main.
 */

export type RouteMeta =
  | { kind: "authenticated" }
  | { kind: "company" }
  | { kind: "platformAdmin" }
  | { kind: "permission"; permissions: Permission[] }
  | { kind: "body"; schema: z.ZodType }
  | { kind: "params"; schema: z.ZodType }
  | { kind: "idempotent"; required: boolean };

const metadata = new WeakMap<RequestHandler, RouteMeta>();

/** Associe une métadonnée à un middleware et le renvoie tel quel. */
export function withMeta<T extends RequestHandler>(handler: T, meta: RouteMeta): T {
  metadata.set(handler, meta);
  return handler;
}

export function metaOf(handler: unknown): RouteMeta | undefined {
  return typeof handler === "function" ? metadata.get(handler as RequestHandler) : undefined;
}
