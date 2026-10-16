import { Router, static as serveStatic } from "express";
import { buildOpenApiDocument } from "./openapi.js";

/**
 * Documentation interactive : GET /api/docs (Swagger UI) et GET /api/docs/openapi.json.
 * Activée hors production (API_DOCS_ENABLED). swagger-ui-dist est une dépendance de dev :
 * elle est chargée seulement si la doc est activée.
 * Le script d'initialisation est un fichier séparé (pas de script inline) : compatible avec
 * la Content-Security-Policy de helmet.
 */

const PAGE = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>StockPro API — documentation</title>
  <link rel="stylesheet" href="assets/swagger-ui.css" />
  <link rel="icon" type="image/png" href="assets/favicon-32x32.png" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="assets/swagger-ui-bundle.js"></script>
  <script src="init.js"></script>
</body>
</html>`;

const INIT = `window.ui = SwaggerUIBundle({
  url: "openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  persistAuthorization: true,
  displayRequestDuration: true,
  filter: true,
  docExpansion: "none",
  tagsSorter: "alpha",
});`;

export async function createDocsRouter(): Promise<Router> {
  const { getAbsoluteFSPath } = await import("swagger-ui-dist");
  // Construite une fois au démarrage : les routes ne changent pas pendant l'exécution
  const document = buildOpenApiDocument();

  const router = Router();
  // /api/docs → /api/docs/ : les chemins relatifs de la page (assets/…, init.js) en dépendent
  router.get("/", (req, res, next) => {
    if (!req.originalUrl.split("?")[0]!.endsWith("/")) {
      res.redirect(301, `${req.baseUrl}/`);
      return;
    }
    next();
  });
  router.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });
  router.get("/init.js", (_req, res) => {
    res.type("application/javascript").send(INIT);
  });
  router.get("/openapi.json", (_req, res) => {
    res.json(document);
  });
  router.use("/assets", serveStatic(getAbsoluteFSPath(), { index: false }));
  return router;
}
