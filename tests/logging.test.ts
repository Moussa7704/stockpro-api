import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED } from "../src/config/logger.js";
import { authenticate } from "../src/middlewares/auth.middleware.js";
import { errorHandler } from "../src/middlewares/error.middleware.js";
import { createRequestLogger } from "../src/middlewares/request-logger.middleware.js";
import { signAccessToken } from "../src/utils/jwt.js";
import { api } from "./helpers/auth.js";

/** Journal en mémoire : chaque ligne JSON écrite est relue sous forme d'objet. */
function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  const logger = createLogger(stream);
  logger.level = "info";
  return { logger, lines };
}

/** Petite application : journal des requêtes, une route normale, une route en panne. */
function appWith(logger: ReturnType<typeof memoryLogger>["logger"]) {
  const app = express();
  app.use(createRequestLogger(logger));
  app.get("/ok", authenticate, (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error("Base de données indisponible");
  });
  app.use(errorHandler);
  return app;
}

describe("Numéro de requête", () => {
  it("chaque réponse en porte un ; celui d'un proxy est gardé s'il est raisonnable", async () => {
    const created = await api().get("/health");
    expect(created.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const kept = await api().get("/health").set("X-Request-Id", "proxy-abc12345");
    expect(kept.headers["x-request-id"]).toBe("proxy-abc12345");

    const replaced = await api().get("/health").set("X-Request-Id", "<script>");
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("une erreur cite le même numéro que l'en-tête", async () => {
    const response = await api().get("/api/nexiste-pas").expect(404);
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});

describe("Journal des requêtes", () => {
  it("une ligne par requête : méthode, adresse, statut, durée, utilisateur, entreprise — sans en-têtes", async () => {
    const { logger, lines } = memoryLogger();
    const token = signAccessToken({ sub: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222" });

    const response = await request(appWith(logger)).get("/ok?page=2").set("Authorization", `Bearer ${token}`).set("Cookie", "refreshToken=secret").expect(200);

    const line = lines.find((item) => (item.req as { url?: string } | undefined)?.url === "/ok?page=2")!;
    expect(line).toMatchObject({
      level: 30,
      service: "stockpro-api",
      req: { id: response.headers["x-request-id"], method: "GET", url: "/ok?page=2" },
      res: { statusCode: 200 },
      userId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      responseTime: expect.any(Number),
    });
    expect(line.msg).toMatch(/^GET \/ok\?page=2 → 200 \(\d+ ms\)$/);
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(JSON.stringify(lines)).not.toContain("refreshToken=secret");
  });

  it("erreur inattendue : journalisée en error avec sa pile, le client ne reçoit que le message et le numéro", async () => {
    const { logger, lines } = memoryLogger();

    const response = await request(appWith(logger)).get("/boom").expect(500);

    expect(response.body).toEqual({ error: { message: "Erreur interne du serveur", requestId: response.headers["x-request-id"] } });
    const logged = lines.find((item) => item.msg === "Erreur inattendue")!;
    expect(logged).toMatchObject({ level: 50, req: { id: response.headers["x-request-id"] }, err: { message: "Base de données indisponible" } });
    expect((logged.err as { stack: string }).stack).toContain("logging.test.ts");
    expect(lines.find((item) => item.msg === "GET /boom → 500")).toMatchObject({ level: 50 });
  });

  it("les erreurs du client sont en warn, sauf 401 et 404 (bruit normal)", async () => {
    const { logger, lines } = memoryLogger();
    const app = appWith(logger);

    await request(app).get("/ok").expect(401);
    await request(app).get("/inconnue").expect(404);

    const status = (code: number) => lines.find((item) => (item.res as { statusCode?: number } | undefined)?.statusCode === code);
    expect(status(401)).toMatchObject({ level: 30 });
    expect(status(404)).toMatchObject({ level: 30 });
  });
});

describe("Secrets masqués", () => {
  it("mots de passe, jetons et cookies ne sont jamais écrits ; les codes d'erreur restent lisibles", () => {
    const { logger, lines } = memoryLogger();

    logger.error({
      password: "MotDePasse!1",
      body: { newPassword: "Nouveau!2", refreshToken: "rt", challengeToken: "ct", otp: "123456" },
      headers: { authorization: "Bearer abc", cookie: "refreshToken=xyz" },
      err: { code: "ECONNREFUSED", message: "connexion refusée" },
    });

    const [line] = lines;
    expect(line).toMatchObject({
      password: REDACTED,
      body: { newPassword: REDACTED, refreshToken: REDACTED, challengeToken: REDACTED, otp: REDACTED },
      headers: { authorization: REDACTED, cookie: REDACTED },
      err: { code: "ECONNREFUSED", message: "connexion refusée" },
    });
    expect(JSON.stringify(line)).not.toMatch(/MotDePasse|Nouveau|Bearer abc|refreshToken=xyz|123456/);
  });
});
