import { describe, expect, it } from "vitest";
import { api, bearer, cookieHeader, createUser, login, refreshCookieOf } from "./helpers/auth.js";

const EMAIL = "user@test.com";

const refresh = (refreshToken?: string) => {
  const call = api().post("/api/auth/refresh");
  return refreshToken ? call.set("Cookie", cookieHeader(refreshToken)) : call;
};

describe("GET /api/auth/me", () => {
  it("refuse une requête sans token", async () => {
    const response = await api().get("/api/auth/me");

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Token manquant");
  });

  it("refuse un token falsifié", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    const forged = `${session.accessToken.slice(0, -5)}AAAAA`;

    const response = await api().get("/api/auth/me").set("Authorization", `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });

  it("refuse un token signé sans algorithme (alg: none)", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
    const payload = session.accessToken.split(".")[1];

    const response = await api().get("/api/auth/me").set("Authorization", `Bearer ${header}.${payload}.`);

    expect(response.status).toBe(401);
  });
});

describe("POST /api/auth/refresh", () => {
  it("refuse sans cookie", async () => {
    const response = await refresh();

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Session absente");
  });

  it("donne un nouvel access token et remplace le refresh token (rotation)", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);

    const response = await refresh(session.refreshToken).expect(200);
    const newRefreshToken = refreshCookieOf(response);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(newRefreshToken).toEqual(expect.any(String));
    expect(newRefreshToken).not.toBe(session.refreshToken);
  });

  it("détecte la réutilisation d'un ancien refresh token et ferme toutes les sessions", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    const rotated = refreshCookieOf(await refresh(session.refreshToken).expect(200))!;

    // L'ancien token revient : probablement volé
    await refresh(session.refreshToken).expect(401);

    // Le token le plus récent est révoqué lui aussi
    await refresh(rotated).expect(401);
  });

  it("n'accepte qu'un seul renouvellement simultané avec le même token", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);

    const responses = await Promise.all([1, 2, 3].map(() => refresh(session.refreshToken)));

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 401, 401]);
  });
});

describe("POST /api/auth/logout", () => {
  it("révoque la session et efface le cookie", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);

    const response = await api()
      .post("/api/auth/logout")
      .set("Cookie", cookieHeader(session.refreshToken))
      .expect(204);

    const cleared = (response.headers["set-cookie"] as unknown as string[])[0];
    expect(cleared).toMatch(/^refreshToken=;/);
    await refresh(session.refreshToken).expect(401);
  });

  it("répond 204 même sans cookie", async () => {
    await api().post("/api/auth/logout").expect(204);
  });

  it("garde l'access token valide jusqu'à son expiration (15 min)", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    await api().post("/api/auth/logout").set("Cookie", cookieHeader(session.refreshToken));

    // Comportement attendu d'un JWT : seul le refresh token est révoqué côté serveur
    await api().get("/api/auth/me").set("Authorization", bearer(session)).expect(200);
  });
});
