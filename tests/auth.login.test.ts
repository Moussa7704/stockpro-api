import { describe, expect, it } from "vitest";
import { EmailOtpCode } from "../src/models/index.js";
import {
  api,
  createUser,
  login,
  PASSWORD,
  refreshCookieOf,
  startLogin,
} from "./helpers/auth.js";
import { emailsTo, lastOtpCode } from "./helpers/mailbox.js";

const EMAIL = "user@test.com";

const sendCode = (challengeToken: string, code: string) =>
  api().post("/api/auth/login/otp").send({ challengeToken, code });

const resend = (challengeToken: string) =>
  api().post("/api/auth/login/otp/resend").send({ challengeToken });

describe("POST /api/auth/login (étape 1 : mot de passe)", () => {
  it("refuse un mauvais mot de passe sans envoyer d'email", async () => {
    await createUser({ email: EMAIL });

    const response = await api().post("/api/auth/login").send({ email: EMAIL, password: "faux" });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Email ou mot de passe incorrect");
    expect(emailsTo(EMAIL)).toHaveLength(0);
  });

  it("répond exactement pareil pour un email inconnu", async () => {
    const response = await api()
      .post("/api/auth/login")
      .send({ email: "inconnu@test.com", password: PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Email ou mot de passe incorrect");
  });

  it("refuse un compte invité qui n'a pas encore de mot de passe", async () => {
    await createUser({ email: EMAIL, password: null });

    const response = await api()
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "nimportequoi" });

    expect(response.status).toBe(401);
    expect(emailsTo(EMAIL)).toHaveLength(0);
  });

  it("envoie un code par email sans ouvrir de session", async () => {
    await createUser({ email: EMAIL });

    const response = await api()
      .post("/api/auth/login")
      .send({ email: "  USER@test.com ", password: PASSWORD })
      .expect(200);

    expect(response.body).toMatchObject({
      otpRequired: true,
      sentTo: "u**r@test.com",
      expiresInSeconds: 600,
    });
    expect(response.body.challengeToken).toEqual(expect.any(String));
    expect(response.body.accessToken).toBeUndefined();
    expect(refreshCookieOf(response)).toBeUndefined();
    expect(lastOtpCode(EMAIL)).toMatch(/^\d{6}$/);
  });
});

describe("POST /api/auth/login/otp (étape 2 : code reçu par email)", () => {
  it("ouvre la session avec le bon code, même saisi avec un espace", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    const code = lastOtpCode(EMAIL);

    const response = await sendCode(challengeToken, `${code.slice(0, 3)} ${code.slice(3)}`);

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({ email: EMAIL, isPlatformAdmin: false });
    expect(response.body.user.password).toBeUndefined();
    expect(refreshCookieOf(response)).toEqual(expect.any(String));
  });

  it("refuse un code faux", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    const wrong = lastOtpCode(EMAIL) === "000000" ? "111111" : "000000";

    const response = await sendCode(challengeToken, wrong);

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Code invalide");
  });

  it("refuse un code au mauvais format", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);

    const response = await sendCode(challengeToken, "12ab");

    expect(response.status).toBe(400);
  });

  it("n'accepte un code qu'une seule fois", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    const code = lastOtpCode(EMAIL);
    await sendCode(challengeToken, code).expect(200);

    const response = await sendCode(challengeToken, code);

    expect(response.status).toBe(401);
  });

  it("bloque le code après 5 essais faux, même si le 6e est le bon", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    const code = lastOtpCode(EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < 5; attempt++) {
      await sendCode(challengeToken, wrong).expect(401);
    }
    const response = await sendCode(challengeToken, code);

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Trop de codes invalides, demandez un nouveau code");
  });

  it("refuse un code expiré", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    await EmailOtpCode.update({ expiresAt: new Date(Date.now() - 1000) }, { where: {} });

    const response = await sendCode(challengeToken, lastOtpCode(EMAIL));

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Code expiré, demandez-en un nouveau");
  });

  it("refuse un challenge inventé", async () => {
    const response = await sendCode("abc.def.ghi", "123456");

    expect(response.status).toBe(401);
  });

  it("n'accepte pas le challenge comme access token", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);

    const response = await api().get("/api/auth/me").set("Authorization", `Bearer ${challengeToken}`);

    expect(response.status).toBe(401);
  });

  it("annule le code précédent quand on relance le login", async () => {
    await createUser({ email: EMAIL });
    const firstChallenge = await startLogin(EMAIL);
    const firstCode = lastOtpCode(EMAIL);
    await startLogin(EMAIL);

    const response = await sendCode(firstChallenge, firstCode);

    expect(response.status).toBe(401);
  });

  it("le même code envoyé en parallèle ne crée qu'une session", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    const code = lastOtpCode(EMAIL);

    const responses = await Promise.all([1, 2, 3].map(() => sendCode(challengeToken, code)));

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 401, 401]);
  });
});

describe("POST /api/auth/login/otp/resend", () => {
  // Simule l'attente du délai entre deux envois
  const skipCooldown = () =>
    EmailOtpCode.update({ lastSentAt: new Date(Date.now() - 61_000) }, { where: {} });

  it("impose un délai de 60 secondes entre deux envois", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);

    const response = await resend(challengeToken);

    expect(response.status).toBe(429);
    expect(response.body.error.message).toMatch(/^Patientez \d+ secondes/);
  });

  it("envoie un nouveau code et invalide l'ancien", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);
    const oldCode = lastOtpCode(EMAIL);
    await skipCooldown();

    await resend(challengeToken).expect(200);
    const newCode = lastOtpCode(EMAIL);

    expect(emailsTo(EMAIL)).toHaveLength(2);
    if (newCode !== oldCode) {
      await sendCode(challengeToken, oldCode).expect(401);
    }
    await sendCode(challengeToken, newCode).expect(200);
  });

  it("limite à 3 renvois par connexion", async () => {
    await createUser({ email: EMAIL });
    const challengeToken = await startLogin(EMAIL);

    for (let i = 0; i < 3; i++) {
      await skipCooldown();
      await resend(challengeToken).expect(200);
    }
    await skipCooldown();
    const response = await resend(challengeToken);

    expect(response.status).toBe(429);
    expect(response.body.error.message).toBe("Nombre maximal de renvois atteint, reconnectez-vous");
  });
});

describe("Connexion complète", () => {
  it("donne accès à /me", async () => {
    await createUser({ email: EMAIL, name: "Marie Martin" });
    const session = await login(EMAIL);

    const response = await api()
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .expect(200);

    expect(response.body.user).toMatchObject({ email: EMAIL, name: "Marie Martin" });
  });
});
