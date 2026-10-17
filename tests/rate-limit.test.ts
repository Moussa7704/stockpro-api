import { randomUUID } from "node:crypto";
import express, { type Request, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { API_LIMITS, apiClientKey, apiLimiter, refreshLimiter } from "../src/middlewares/rate-limit.middleware.js";
import { signAccessToken } from "../src/utils/jwt.js";

// Les limites sont coupées pour les autres tests (RATE_LIMIT_ENABLED=false) : on les active ici
beforeEach(() => {
  env.RATE_LIMIT_ENABLED = true;
});
afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
});

const bearer = (userId: string) => `Bearer ${signAccessToken({ sub: userId, companyId: null })}`;
const fakeRequest = (authorization?: string) => ({ headers: { authorization }, ip: "203.0.113.7" }) as unknown as Request;

/** Petite application avec un seul limiteur, pour lire ses compteurs sans le reste de l'API. */
function appWith(limiter: RequestHandler, status = 200) {
  const app = express();
  app.set("trust proxy", false);
  app.use(limiter);
  app.all("/{*path}", (_req, res) => {
    res.status(status).json({});
  });
  app.use((err: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({});
  });
  return app;
}

/** Quota annoncé dans l'en-tête RateLimit (brouillon 8) : plafond q et restant r. */
function quota(headers: Record<string, string>) {
  return {
    limit: Number(/q=(\d+)/.exec(headers["ratelimit-policy"] ?? "")?.[1]),
    remaining: Number(/r=(\d+)/.exec(headers["ratelimit"] ?? "")?.[1]),
  };
}

describe("Quota général de l'API", () => {
  it("compte par utilisateur pour un jeton valide, sinon par adresse IP", () => {
    const userId = randomUUID();
    expect(apiClientKey(fakeRequest(bearer(userId)))).toBe(`user:${userId}`);
    expect(apiClientKey(fakeRequest())).not.toMatch(/^user:/);
    // Jeton falsifié ou expiré : retour au compteur de l'adresse IP
    const forged = jwt.sign({ sub: userId, companyId: null }, "autre-secret");
    expect(apiClientKey(fakeRequest(`Bearer ${forged}`))).not.toMatch(/^user:/);
    const expired = jwt.sign({ sub: userId, companyId: null, exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_ACCESS_SECRET);
    expect(apiClientKey(fakeRequest(`Bearer ${expired}`))).not.toMatch(/^user:/);
  });

  it("deux employés derrière la même box ont chacun leur quota, plus large que celui d'un visiteur", async () => {
    const app = appWith(apiLimiter);
    const cashier = bearer(randomUUID());
    const manager = bearer(randomUUID());

    for (let i = 0; i < 3; i++) await request(app).get("/x").set("Authorization", cashier).expect(200);
    const forManager = await request(app).get("/x").set("Authorization", manager).expect(200);

    expect(quota(forManager.headers)).toEqual({ limit: API_LIMITS.user, remaining: API_LIMITS.user - 1 });
    const forCashier = await request(app).get("/x").set("Authorization", cashier).expect(200);
    expect(quota(forCashier.headers).remaining).toBe(API_LIMITS.user - 4);
    const anonymous = await request(app).get("/x").expect(200);
    expect(quota(anonymous.headers).limit).toBe(API_LIMITS.ip);
  });

  it("au-delà du plafond : 429", async () => {
    const app = appWith(apiLimiter);
    const user = bearer(randomUUID());

    for (let i = 0; i < API_LIMITS.user; i++) await request(app).get("/x").set("Authorization", user);
    await request(app).get("/x").set("Authorization", user).expect(429);
  });
});

describe("Renouvellement de session", () => {
  it("les renouvellements réussis ne consomment pas le quota, les échecs si", async () => {
    // Plus de réussites que le plafond (30) : jamais bloqué
    const ok = appWith(refreshLimiter);
    for (let i = 0; i < 40; i++) await request(ok).post("/api/auth/refresh").expect(200);

    const failing = appWith(refreshLimiter, 401);
    for (let i = 0; i < 30; i++) await request(failing).post("/api/auth/refresh").expect(401);
    await request(failing).post("/api/auth/refresh").expect(429);
  });
});
