import type { Router } from "express";
import type { ApiRouter } from "../routes.js";
import { metaOf, type RouteMeta } from "./route-meta.js";

/**
 * Liste les routes réellement montées (méthode, chemin complet, métadonnées des middlewares)
 * en parcourant la pile des routers Express. Les middlewares posés par router.use() avant une
 * route (authenticate, requirePermission…) s'appliquent à cette route.
 */

export interface CollectedRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Chemin Express complet, ex. /api/products/:id */
  path: string;
  tag: string;
  metas: RouteMeta[];
}

// Structure interne du package "router" (Express 5)
interface RouteLayer {
  method?: string;
  handle: unknown;
}
interface StackLayer {
  handle: unknown;
  route?: { path: unknown; stack: RouteLayer[] };
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function collectRoutes(routers: ApiRouter[]): CollectedRoute[] {
  const routes: CollectedRoute[] = [];
  for (const { prefix, router, tag } of routers) {
    const routerMetas: RouteMeta[] = [];
    for (const layer of (router as Router & { stack: StackLayer[] }).stack) {
      if (!layer.route) {
        const meta = metaOf(layer.handle);
        if (meta) routerMetas.push(meta);
        continue;
      }
      if (typeof layer.route.path !== "string") {
        throw new Error(`Chemin de route non documentable sous ${prefix}`);
      }
      const path = `${prefix}${layer.route.path === "/" ? "" : layer.route.path}` || "/";
      const byMethod = new Map<string, RouteMeta[]>();
      for (const handler of layer.route.stack) {
        const method = handler.method?.toLowerCase();
        if (!method || !METHODS.has(method)) continue;
        const list = byMethod.get(method) ?? [];
        const meta = metaOf(handler.handle);
        if (meta) list.push(meta);
        byMethod.set(method, list);
      }
      for (const [method, metas] of byMethod) {
        routes.push({ method: method as CollectedRoute["method"], path, tag, metas: [...routerMetas, ...metas] });
      }
    }
  }
  return routes;
}
