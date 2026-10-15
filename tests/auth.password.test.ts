import { describe, expect, it } from "vitest";
import { PasswordToken } from "../src/models/index.js";
import { api, bearer, cookieHeader, createUser, login, PASSWORD } from "./helpers/auth.js";
import { emailsTo, lastLinkToken } from "./helpers/mailbox.js";

const EMAIL = "user@test.com";
const NEW_PASSWORD = "nouveaupass456";

const forgot = (email: string) => api().post("/api/auth/password/forgot").send({ email });
const reset = (token: string, password = NEW_PASSWORD) =>
  api().post("/api/auth/password/reset").send({ token, password });
const tryLogin = (password: string) =>
  api().post("/api/auth/login").send({ email: EMAIL, password });

describe("Mot de passe oublié", () => {
  it("répond pareil pour un email inconnu, sans envoyer d'email", async () => {
    await createUser({ email: EMAIL });

    const unknown = await forgot("inconnu@test.com").expect(200);
    const known = await forgot(EMAIL).expect(200);

    expect(unknown.body).toEqual(known.body);
    expect(emailsTo("inconnu@test.com")).toHaveLength(0);
    expect(emailsTo(EMAIL)).toHaveLength(1);
  });

  it("le lien indique qu'il s'agit d'une réinitialisation", async () => {
    await createUser({ email: EMAIL, name: "Marie Martin" });
    await forgot(EMAIL);

    const response = await api()
      .post("/api/auth/password/check")
      .send({ token: lastLinkToken("reset", EMAIL) })
      .expect(200);

    expect(response.body).toEqual({ purpose: "reset", name: "Marie Martin", email: EMAIL });
  });

  it("change le mot de passe, ferme toutes les sessions et prévient par email", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    await forgot(EMAIL);

    await reset(lastLinkToken("reset", EMAIL)).expect(200);

    await api()
      .post("/api/auth/refresh")
      .set("Cookie", cookieHeader(session.refreshToken))
      .expect(401);
    await tryLogin(PASSWORD).expect(401);
    await tryLogin(NEW_PASSWORD).expect(200);
    expect(emailsTo(EMAIL).map((email) => email.type)).toContain("password-changed");
  });

  it("refuse un mot de passe trop court", async () => {
    await createUser({ email: EMAIL });
    await forgot(EMAIL);

    const response = await reset(lastLinkToken("reset", EMAIL), "123");

    expect(response.status).toBe(400);
  });

  it("n'accepte un lien qu'une seule fois", async () => {
    await createUser({ email: EMAIL });
    await forgot(EMAIL);
    const token = lastLinkToken("reset", EMAIL);
    await reset(token).expect(200);

    const response = await reset(token, "autrepass789");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Lien invalide ou expiré, demandez-en un nouveau");
  });

  it("refuse un lien expiré", async () => {
    await createUser({ email: EMAIL });
    await forgot(EMAIL);
    await PasswordToken.update({ expiresAt: new Date(Date.now() - 1000) }, { where: {} });

    const response = await reset(lastLinkToken("reset", EMAIL));

    expect(response.status).toBe(400);
  });

  it("un nouveau lien annule le précédent", async () => {
    await createUser({ email: EMAIL });
    await forgot(EMAIL);
    const first = lastLinkToken("reset", EMAIL);
    await forgot(EMAIL);

    await reset(first).expect(400);
    await reset(lastLinkToken("reset", EMAIL)).expect(200);
  });

  it("le même lien utilisé en parallèle ne sert qu'une fois", async () => {
    await createUser({ email: EMAIL });
    await forgot(EMAIL);
    const token = lastLinkToken("reset", EMAIL);

    const responses = await Promise.all(
      ["parallele1-123", "parallele2-123", "parallele3-123"].map((password) => reset(token, password)),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400, 400]);
  });

  it("limite à 5 emails par compte et par heure", async () => {
    await createUser({ email: EMAIL });

    for (let i = 0; i < 7; i++) {
      await forgot(EMAIL).expect(200);
    }

    expect(emailsTo(EMAIL)).toHaveLength(5);
  });
});

describe("POST /api/auth/password/change", () => {
  const change = (session: { accessToken: string; refreshToken: string }, body: object) =>
    api()
      .post("/api/auth/password/change")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .set("Cookie", cookieHeader(session.refreshToken))
      .send(body);

  it("exige d'être connecté", async () => {
    const response = await api()
      .post("/api/auth/password/change")
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
  });

  it("refuse un mot de passe actuel incorrect", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);

    const response = await change(session, { currentPassword: "faux", newPassword: NEW_PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Mot de passe actuel incorrect");
  });

  it("refuse un nouveau mot de passe identique à l'actuel", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);

    const response = await change(session, { currentPassword: PASSWORD, newPassword: PASSWORD });

    expect(response.status).toBe(400);
  });

  it("garde la session en cours, déconnecte les autres appareils et prévient par email", async () => {
    await createUser({ email: EMAIL });
    const current = await login(EMAIL);
    const otherDevice = await login(EMAIL);

    await change(current, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);

    await api().post("/api/auth/refresh").set("Cookie", cookieHeader(current.refreshToken)).expect(200);
    await api()
      .post("/api/auth/refresh")
      .set("Cookie", cookieHeader(otherDevice.refreshToken))
      .expect(401);
    await tryLogin(NEW_PASSWORD).expect(200);
    expect(emailsTo(EMAIL).map((email) => email.type)).toContain("password-changed");
  });

  it("invalide un lien 'mot de passe oublié' demandé avant le changement", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    await forgot(EMAIL);
    const pending = lastLinkToken("reset", EMAIL);

    await change(session, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);

    await reset(pending, "pirate12345").expect(400);
    await api().get("/api/auth/me").set("Authorization", bearer(session)).expect(200);
  });
});
