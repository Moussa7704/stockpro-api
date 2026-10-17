import { describe, expect, it } from "vitest";
import { RefreshToken } from "../src/models/index.js";
import { api, bearer, cookieHeader, createUser, PASSWORD, refreshCookieOf, startLogin, type Session } from "./helpers/auth.js";
import { lastOtpCode } from "./helpers/mailbox.js";

const EMAIL = "user@test.com";
const PHONE = "Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";
const PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36";

/** Connexion complète depuis un navigateur donné (User-Agent). */
async function loginFrom(userAgent: string, email = EMAIL): Promise<Session> {
  const challengeToken = await startLogin(email);
  const response = await api().post("/api/auth/login/otp").set("User-Agent", userAgent).send({ challengeToken, code: lastOtpCode(email) }).expect(200);
  return { accessToken: response.body.accessToken, refreshToken: refreshCookieOf(response)!, userId: response.body.user.id, activeCompanyId: response.body.activeCompanyId };
}
const sessions = async (session: Session) => (await api().get("/api/auth/sessions").set("Authorization", bearer(session)).expect(200)).body.sessions;
const refresh = (session: Session, userAgent?: string) => {
  const call = api().post("/api/auth/refresh").set("Cookie", cookieHeader(session.refreshToken));
  return userAgent ? call.set("User-Agent", userAgent) : call;
};

describe("Appareils connectés", () => {
  it("liste les appareils : celui-ci d'abord, navigateur, connexion conservée au renouvellement", async () => {
    await createUser({ email: EMAIL });
    const phone = await loginFrom(PHONE);
    const pc = await loginFrom(PC);

    const list = await sessions(pc);

    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ current: true, userAgent: PC, ipAddress: expect.any(String) });
    expect(list[1]).toMatchObject({ current: false, userAgent: PHONE });

    // Le téléphone renouvelle sa session : même appareil (même id), même date de connexion
    const renewed = await refresh(phone, PHONE).expect(200);
    const phoneAfter = (await sessions(pc)).find((item: { userAgent: string }) => item.userAgent === PHONE);
    expect(phoneAfter).toMatchObject({ id: list[1].id, startedAt: list[1].startedAt });
    expect(new Date(phoneAfter.lastActiveAt).getTime()).toBeGreaterThanOrEqual(new Date(list[1].lastActiveAt).getTime());
    expect(await sessions({ ...phone, accessToken: renewed.body.accessToken })).toHaveLength(2);
  });

  it("déconnecter un autre appareil : effet immédiat, les autres sessions ne sont pas touchées", async () => {
    await createUser({ email: EMAIL });
    const phone = await loginFrom(PHONE);
    const pc = await loginFrom(PC);
    const phoneId = (await sessions(pc))[1].id;

    await api().delete(`/api/auth/sessions/${phoneId}`).set("Authorization", bearer(pc)).expect(204);

    // Le téléphone est refusé tout de suite, puis à son renouvellement…
    await api().get("/api/auth/me").set("Authorization", bearer(phone)).expect(401);
    const retry = await refresh(phone).expect(401);
    expect(retry.body.error.message).toBe("Session fermée");
    // … sans que la protection anti-vol ne ferme aussi le PC
    await api().get("/api/auth/me").set("Authorization", bearer(pc)).expect(200);
    await refresh(pc).expect(200);
    expect(await sessions(pc)).toHaveLength(1);
  });

  it("refuse de déconnecter cet appareil par cette voie, ou un appareil inconnu / d'un autre utilisateur", async () => {
    await createUser({ email: EMAIL });
    await createUser({ email: "other@test.com" });
    const pc = await loginFrom(PC);
    const other = await loginFrom(PHONE, "other@test.com");
    const [mine] = await sessions(pc);
    const [theirs] = await sessions(other);

    const self = await api().delete(`/api/auth/sessions/${mine.id}`).set("Authorization", bearer(pc)).expect(400);
    expect(self.body.error.message).toMatch(/Se déconnecter/);
    await api().delete(`/api/auth/sessions/${theirs.id}`).set("Authorization", bearer(pc)).expect(404);
    await api().get("/api/auth/me").set("Authorization", bearer(other)).expect(200);
  });

  it("déconnecter tous les autres appareils", async () => {
    await createUser({ email: EMAIL });
    const phone = await loginFrom(PHONE);
    const tablet = await loginFrom(PHONE);
    const pc = await loginFrom(PC);

    const response = await api().post("/api/auth/sessions/revoke-others").set("Authorization", bearer(pc)).expect(200);

    expect(response.body).toEqual({ revoked: 2 });
    await api().get("/api/auth/me").set("Authorization", bearer(phone)).expect(401);
    await api().get("/api/auth/me").set("Authorization", bearer(tablet)).expect(401);
    expect(await sessions(pc)).toEqual([expect.objectContaining({ current: true })]);
  });

  it("changement de mot de passe : l'appareil déconnecté qui réessaie ne ferme pas la session en cours", async () => {
    await createUser({ email: EMAIL });
    const phone = await loginFrom(PHONE);
    const pc = await loginFrom(PC);

    await api()
      .post("/api/auth/password/change")
      .set("Authorization", bearer(pc))
      .set("Cookie", cookieHeader(pc.refreshToken))
      .send({ currentPassword: PASSWORD, newPassword: "NouveauMotDePasse!2026" })
      .expect(200);

    await refresh(phone).expect(401);
    // Avant : ce retour passait pour un vol et déconnectait aussi le PC
    await api().get("/api/auth/me").set("Authorization", bearer(pc)).expect(200);
    await refresh(pc).expect(200);
    expect(await RefreshToken.count({ where: { revokeReason: "reuse" } })).toBe(0);
  });
});
