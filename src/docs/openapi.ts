import { z } from "zod";
import type { Permission } from "../modules/access/permissions.js";
import { apiRouters } from "../routes.js";
import { collectRoutes, type CollectedRoute } from "./collect-routes.js";
import { operations } from "./operations.js";
import type { RouteMeta } from "./route-meta.js";

/**
 * Spécification OpenAPI 3.1 de l'API, construite à partir des routers réellement montés :
 * chemins, méthodes, permissions, body (schémas zod → JSON Schema) et idempotence viennent
 * du code ; résumés et paramètres d'URL viennent de operations.ts.
 */

type JsonSchema = Record<string, unknown>;

/**
 * Allège le schéma pour la lecture : les regex que zod génère pour uuid, date ou email
 * doublonnent le "format", et l'entier maximum de JavaScript n'apporte rien.
 */
function simplify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplify);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as JsonSchema)
    .filter(([key]) => !(key === "pattern" && "format" in (value as JsonSchema)))
    .filter(([key, item]) => !(key === "maximum" && item === Number.MAX_SAFE_INTEGER))
    .filter(([key, item]) => !(key === "minimum" && item === Number.MIN_SAFE_INTEGER))
    .map(([key, item]) => [key, simplify(item)]);
  return Object.fromEntries(entries);
}

/** JSON Schema de ce que le client ENVOIE (avant transformations zod : trim, valeurs par défaut…). */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  return simplify(json) as JsonSchema;
}

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

function find<K extends RouteMeta["kind"]>(metas: RouteMeta[], kind: K) {
  return metas.filter((meta): meta is Extract<RouteMeta, { kind: K }> => meta.kind === kind);
}

/** Paramètres d'URL (?…) et de chemin (/:id) au format OpenAPI. */
function parametersOf(route: CollectedRoute, query: z.ZodType | undefined) {
  const parameters: Record<string, unknown>[] = [];

  const pathNames = [...route.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
  const paramsSchema = find(route.metas, "params")[0];
  const pathProperties = (paramsSchema ? toJsonSchema(paramsSchema.schema).properties : undefined) as
    | Record<string, JsonSchema>
    | undefined;
  for (const name of pathNames) {
    parameters.push({ name, in: "path", required: true, schema: pathProperties?.[name] ?? { type: "string" } });
  }

  if (query) {
    const json = toJsonSchema(query);
    const required = new Set((json.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries((json.properties as Record<string, JsonSchema> | undefined) ?? {})) {
      // Un paramètre avec valeur par défaut n'est jamais obligatoire pour le client
      parameters.push({ name, in: "query", required: required.has(name) && !("default" in schema), schema });
    }
  }

  const idempotency = find(route.metas, "idempotent")[0];
  if (idempotency) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: idempotency.required,
      description:
        "Clé unique par opération (ex. un UUID), renvoyée telle quelle si la requête est rejouée : " +
        "même clé + même contenu → réponse d'origine, rien n'est refait ; contenu différent → 422 ; encore en cours → 409.",
      schema: { type: "string", pattern: "^[A-Za-z0-9_:.-]{8,100}$" },
    });
  }
  return parameters;
}

/** Ligne "qui peut appeler cette route" ajoutée à la description. */
function accessLine(metas: RouteMeta[]): string {
  if (find(metas, "platformAdmin").length > 0) return "**Accès** : administrateur de la plateforme.";
  const permissions = find(metas, "permission").flatMap((meta) => meta.permissions);
  if (permissions.length > 0) {
    const unique = [...new Set<Permission>(permissions)];
    return `**Permission${unique.length > 1 ? "s" : ""}** : ${unique.map((permission) => `\`${permission}\``).join(", ")} (entreprise active).`;
  }
  if (find(metas, "company").length > 0) return "**Accès** : tout membre de l'entreprise active.";
  if (find(metas, "authenticated").length > 0) return "**Accès** : utilisateur connecté.";
  return "**Accès** : public.";
}

function operationOf(route: CollectedRoute) {
  const key = `${route.method.toUpperCase()} ${route.path}`;
  const doc = operations[key];
  const metas = route.metas;
  const authenticated = find(metas, "authenticated").length > 0;
  const body = find(metas, "body")[0];
  const upload = find(metas, "upload")[0];
  const parameters = parametersOf(route, doc?.query);
  const restricted = find(metas, "permission").length + find(metas, "company").length + find(metas, "platformAdmin").length > 0;

  const responses: Record<string, unknown> = { "2XX": { description: "Succès" } };
  if (body || upload || parameters.some((parameter) => parameter.in !== "header")) responses["400"] = errorResponse("Données ou paramètres invalides");
  if (authenticated) responses["401"] = errorResponse("Token manquant, invalide ou expiré");
  if (restricted) responses["403"] = errorResponse("Droits insuffisants");
  if (route.path.includes(":")) responses["404"] = errorResponse("Introuvable (ou appartient à une autre entreprise)");
  if (route.method !== "get") responses["409"] = errorResponse("Conflit avec l'état actuel (déjà fait, doublon, stock insuffisant…)");
  if (find(metas, "idempotent").length > 0) responses["422"] = errorResponse("Clé d'idempotence réutilisée avec un contenu différent");
  responses["429"] = errorResponse("Trop de requêtes");

  return {
    tags: [route.tag],
    summary: doc?.summary ?? key,
    description: [doc?.description, accessLine(metas)].filter(Boolean).join("\n\n"),
    operationId: key.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    ...(authenticated && { security: [{ bearerAuth: [] }] }),
    ...(parameters.length > 0 && { parameters }),
    ...(body && { requestBody: { required: true, content: { "application/json": { schema: toJsonSchema(body.schema) } } } }),
    ...(upload && { requestBody: uploadBody(upload) }),
    responses,
  };
}

/** Envoi de fichier : multipart/form-data, champ "file" + champ "options" (JSON) facultatif. */
function uploadBody(upload: Extract<RouteMeta, { kind: "upload" }>) {
  const properties: Record<string, unknown> = {
    file: { type: "string", format: "binary", description: `Fichier ${upload.extensions.join(" ou ")}` },
  };
  if (upload.options) {
    properties.options = {
      type: "string",
      description: "Options en JSON (chaîne de caractères) :",
      contentMediaType: "application/json",
      contentSchema: toJsonSchema(upload.options),
    };
  }
  return {
    required: true,
    content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties } } },
  };
}

export function buildOpenApiDocument() {
  const routes = collectRoutes(apiRouters);
  const paths: Record<string, Record<string, unknown>> = {
    "/health": {
      get: {
        tags: ["Système"],
        summary: "Santé de l'API et de la base (Docker, load balancer)",
        operationId: "GET_health",
        responses: { "200": { description: "API et base disponibles" }, "503": { description: "Base injoignable" } },
      },
    },
  };
  for (const route of routes) {
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    paths[path] = { ...paths[path], [route.method]: operationOf(route) };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "StockPro API",
      version: "1.0.0",
      description:
        "API de gestion de boutiques et de stock, multi-entreprises.\n\n" +
        "**Connexion** : `POST /api/auth/login` puis `POST /api/auth/login/otp` (code reçu par email) → `accessToken`, " +
        "à coller dans **Authorize**. Toutes les données sont limitées à l'entreprise active du token.\n\n" +
        "**Montants** : chaînes décimales (`\"1500.00\"`), jamais des nombres à virgule flottante. " +
        "**Dates** : ISO 8601 en UTC ; les rapports raisonnent en jours du fuseau de l'entreprise.",
    },
    tags: [...new Set(["Système", ...apiRouters.map((router) => router.tag)])].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["message"],
              properties: {
                message: { type: "string" },
                details: {
                  type: "array",
                  items: { type: "object", properties: { field: { type: "string" }, message: { type: "string" } } },
                },
                // Même valeur que l'en-tête X-Request-Id : retrouve la ligne du journal du serveur
                requestId: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
