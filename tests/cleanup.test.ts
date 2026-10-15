import { randomUUID } from "node:crypto";
import { Op } from "sequelize";
import { describe, expect, it } from "vitest";
import { sequelize } from "../src/config/database.js";
import { runCleanup } from "../src/jobs/cleanup.js";
import { EmailOtpCode, PasswordToken, RefreshToken } from "../src/models/index.js";
import { api, cookieHeader, createUser, login } from "./helpers/auth.js";

const EMAIL = "user@test.com";
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const daysAhead = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

describe("Purge des données d'authentification", () => {
  it("supprime ce qui est périmé et garde ce qui est récent", async () => {
    const user = await createUser({ email: EMAIL });
    const base = { userId: user.id };

    await RefreshToken.bulkCreate([
      { ...base, tokenHash: "a".repeat(64), expiresAt: daysAgo(1) }, // expirée → supprimée
      { ...base, tokenHash: "b".repeat(64), expiresAt: daysAhead(5) }, // active → gardée
    ]);
    await EmailOtpCode.bulkCreate([
      { ...base, challengeId: randomUUID(), codeHash: "c".repeat(64), expiresAt: daysAgo(2), lastSentAt: daysAgo(2) },
      { ...base, challengeId: randomUUID(), codeHash: "d".repeat(64), expiresAt: daysAhead(1), lastSentAt: new Date() },
    ]);
    // Sequelize impose created_at = maintenant : on vieillit le premier code directement en SQL
    await sequelize.query(
      "UPDATE email_otp_codes SET created_at = now() - interval '2 days' WHERE code_hash = :hash",
      { replacements: { hash: "c".repeat(64) } },
    );
    await PasswordToken.bulkCreate([
      { ...base, purpose: "reset", tokenHash: "e".repeat(64), expiresAt: daysAgo(2) }, // expiré → supprimé
      { ...base, purpose: "reset", tokenHash: "f".repeat(64), expiresAt: daysAhead(1), usedAt: daysAgo(2) }, // utilisé il y a longtemps → supprimé
      { ...base, purpose: "invite", tokenHash: "g".repeat(64), expiresAt: daysAhead(2) }, // valide → gardé
    ]);

    const result = await runCleanup();

    expect(result).toEqual({ refreshTokens: 1, otpCodes: 1, passwordTokens: 2 });
    expect(await RefreshToken.count()).toBe(1);
    expect(await EmailOtpCode.count()).toBe(1);
    expect(await PasswordToken.count()).toBe(1);
  });

  it("garde une session révoquée mais pas encore expirée (elle sert à détecter un vol)", async () => {
    await createUser({ email: EMAIL });
    const session = await login(EMAIL);
    // La rotation révoque l'ancien refresh token
    await api().post("/api/auth/refresh").set("Cookie", cookieHeader(session.refreshToken)).expect(200);

    const result = await runCleanup();

    expect(result.refreshTokens).toBe(0);
    expect(await RefreshToken.count({ where: { revokedAt: { [Op.ne]: null } } })).toBe(1);
  });

  it("ne supprime rien quand tout est à jour", async () => {
    await createUser({ email: EMAIL });
    await login(EMAIL);

    expect(await runCleanup()).toEqual({ refreshTokens: 0, otpCodes: 0, passwordTokens: 0 });
  });
});
