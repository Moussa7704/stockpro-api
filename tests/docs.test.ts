import { describe, expect, it } from "vitest";
import { collectRoutes } from "../src/docs/collect-routes.js";
import { buildOpenApiDocument } from "../src/docs/openapi.js";
import { operations } from "../src/docs/operations.js";
import { apiRouters } from "../src/routes.js";
import { api } from "./helpers/auth.js";

type Operation = {
  summary: string;
  description?: string;
  operationId: string;
  security?: unknown[];
  parameters?: { name: string; in: string; required: boolean }[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

const document = buildOpenApiDocument();
const allOperations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation: operation as Operation })),
);
const operationAt = (path: string, method: string) => (document.paths[path] as Record<string, Operation>)[method]!;

describe("Documentation OpenAPI : synchronisée avec le code", () => {
  it("chaque route montée est documentée, et aucune entrée ne décrit une route disparue", () => {
    const mounted = collectRoutes(apiRouters).map((route) => `${route.method.toUpperCase()} ${route.path}`);
    const documented = Object.keys(operations);

    // Nouvelle route ? Ajouter son résumé dans src/docs/operations.ts
    expect(mounted.filter((key) => !documented.includes(key))).toEqual([]);
    // Route supprimée ou renommée ? Retirer ou corriger son entrée
    expect(documented.filter((key) => !mounted.includes(key))).toEqual([]);
    expect(new Set(mounted).size).toBe(mounted.length);
  });

  it("produit un document cohérent : identifiants uniques, paramètres de chemin déclarés", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(allOperations.length).toBe(Object.keys(operations).length + 1); // + /health

    const ids = allOperations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const { path, operation } of allOperations) {
      const declared = (operation.parameters ?? []).filter((parameter) => parameter.in === "path").map((parameter) => parameter.name);
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(declared, path).toEqual(inPath);
      expect(operation.summary, path).not.toMatch(/^(GET|POST|PUT|PATCH|DELETE) /);
    }
  });

  it("décrit permission, body, idempotence et paramètres à partir des middlewares", () => {
    const sale = operationAt("/api/pos/sales", "post");
    expect(sale.description).toContain("`sales.create`");
    expect(sale.security).toEqual([{ bearerAuth: [] }]);
    expect(sale.parameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }));
    expect(sale.requestBody).toMatchObject({ content: { "application/json": { schema: { type: "object", required: expect.arrayContaining(["shopId", "lines"]) } } } });
    expect(Object.keys(sale.responses)).toEqual(expect.arrayContaining(["2XX", "400", "401", "403", "409", "422"]));

    // Paramètres d'URL : obligatoires sauf valeur par défaut
    const report = operationAt("/api/reports/sales", "get");
    const query = Object.fromEntries((report.parameters ?? []).map((parameter) => [parameter.name, parameter.required]));
    expect(query).toMatchObject({ from: true, to: true, shopId: false, groupBy: false, format: false });

    // Routes publiques : ni sécurité ni 401
    const login = operationAt("/api/auth/login", "post");
    expect(login.security).toBeUndefined();
    expect(login.responses["401"]).toBeUndefined();
    expect(login.description).toContain("public");

    expect(operationAt("/api/platform/companies", "get").description).toContain("administrateur de la plateforme");
  });
});

describe("Documentation servie par l'API", () => {
  it("sert la spécification et Swagger UI (sans script inline, compatible CSP)", async () => {
    const spec = await api().get("/api/docs/openapi.json").expect(200);
    expect(spec.body.info.title).toBe("StockPro API");

    await api().get("/api/docs").expect(301).expect("Location", "/api/docs/");
    const page = await api().get("/api/docs/").expect(200).expect("Content-Type", /html/);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    // Tous les scripts sont des fichiers : aucun <script> inline bloqué par la CSP
    expect(page.text.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();

    await api().get("/api/docs/init.js").expect(200).expect("Content-Type", /javascript/);
    await api().get("/api/docs/assets/swagger-ui-bundle.js").expect(200).expect("Content-Type", /javascript/);
    await api().get("/api/docs/assets/swagger-ui.css").expect(200).expect("Content-Type", /css/);
  });
});
