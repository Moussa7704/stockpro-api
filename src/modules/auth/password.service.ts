import { randomBytes } from "node:crypto";
import { Op, type Transaction } from "sequelize";
import { env } from "../../config/env.js";
import { sequelize } from "../../config/database.js";
import { EmailOtpCode, PasswordToken, RefreshToken, User } from "../../models/index.js";
import type { PasswordTokenPurpose } from "../../models/password-token.model.js";
import { AppError } from "../../utils/app-error.js";
import { hmac } from "../../utils/crypto.js";
import {
  sendInvitationEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "../../utils/mailer.js";

/**
 * Liens "définir un mot de passe" envoyés par email.
 * Même mécanisme pour l'invitation (compte créé par un admin) et le mot de passe oublié.
 */

const INVITE_TTL_HOURS = 48;
const RESET_TTL_MINUTES = 30;
// Anti-spam : au plus 5 emails de réinitialisation par compte et par heure
const MAX_RESETS_PER_HOUR = 5;

const TTL_MS: Record<PasswordTokenPurpose, number> = {
  invite: INVITE_TTL_HOURS * 60 * 60 * 1000,
  reset: RESET_TTL_MINUTES * 60 * 1000,
};

const INVALID_LINK = "Lien invalide ou expiré, demandez-en un nouveau";

function buildLink(token: string): string {
  const url = new URL("/reset-password", env.CLIENT_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Alerte "mot de passe modifié" envoyée sans attendre : un échec d'envoi ne doit pas
 * annuler le changement de mot de passe, il est seulement journalisé.
 */
export function notifyPasswordChanged(user: User): void {
  sendPasswordChangedEmail({
    to: user.email,
    name: user.name,
    resetLink: new URL("/forgot-password", env.CLIENT_URL).toString(),
  }).catch((error: unknown) => {
    console.error("Échec de l'envoi de l'alerte de changement de mot de passe :", error);
  });
}

/** Crée un lien à usage unique ; les liens précédents encore valides sont annulés. */
async function createToken(
  userId: string,
  purpose: PasswordTokenPurpose,
  transaction?: Transaction,
): Promise<string> {
  await PasswordToken.update({ usedAt: new Date() }, { where: { userId, usedAt: null }, transaction });

  // 256 bits aléatoires : impossible à deviner, une empreinte HMAC suffit pour le stocker
  const token = randomBytes(32).toString("base64url");
  await PasswordToken.create(
    {
      userId,
      purpose,
      tokenHash: hmac(token),
      expiresAt: new Date(Date.now() + TTL_MS[purpose]),
    },
    { transaction },
  );
  return token;
}

async function findValidToken(token: string): Promise<PasswordToken> {
  const record = await PasswordToken.findOne({ where: { tokenHash: hmac(token) } });
  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    throw AppError.badRequest(INVALID_LINK);
  }
  return record;
}

/** Invitation d'un compte créé par un admin. À appeler dans la transaction qui crée le compte. */
export async function sendInvitation(
  user: User,
  invitedBy: string,
  transaction?: Transaction,
): Promise<void> {
  const token = await createToken(user.id, "invite", transaction);
  try {
    await sendInvitationEmail({
      to: user.email,
      name: user.name,
      invitedBy,
      link: buildLink(token),
      expiresInHours: INVITE_TTL_HOURS,
    });
  } catch (error) {
    console.error("Échec de l'envoi de l'email d'invitation :", error);
    throw AppError.serviceUnavailable("Impossible d'envoyer l'email d'invitation, réessayez plus tard");
  }
}

/**
 * Mot de passe oublié. Ne dit jamais si l'email existe : la réponse est la même dans tous les cas.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ where: { email } });
  if (!user) {
    return;
  }

  const recentCount = await PasswordToken.count({
    where: {
      userId: user.id,
      purpose: "reset",
      createdAt: { [Op.gt]: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (recentCount >= MAX_RESETS_PER_HOUR) {
    return;
  }

  const token = await createToken(user.id, "reset");

  // Envoi sans attendre la fin : la réponse arrive aussi vite que l'email existe ou non,
  // on ne peut donc pas deviner les comptes existants en mesurant le temps de réponse
  sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    link: buildLink(token),
    expiresInMinutes: RESET_TTL_MINUTES,
  }).catch((error: unknown) => {
    console.error("Échec de l'envoi de l'email de réinitialisation :", error);
  });
}

/** Permet au front d'afficher le bon titre (invitation / réinitialisation) avant la saisie. */
export async function inspectToken(
  token: string,
): Promise<{ purpose: PasswordTokenPurpose; name: string; email: string }> {
  const record = await findValidToken(token);
  const user = await User.findByPk(record.userId);
  if (!user) {
    throw AppError.badRequest(INVALID_LINK);
  }
  return { purpose: record.purpose, name: user.name, email: user.email };
}

/** Définit le mot de passe à partir d'un lien reçu par email (invitation ou réinitialisation). */
export async function setPasswordWithToken(token: string, password: string): Promise<void> {
  const record = await findValidToken(token);

  const user = await sequelize.transaction(async (transaction) => {
    // usedAt: null dans le WHERE : deux envois simultanés du même lien, un seul passe
    const [used] = await PasswordToken.update(
      { usedAt: new Date() },
      { where: { id: record.id, usedAt: null }, transaction },
    );
    if (used === 0) {
      throw AppError.badRequest(INVALID_LINK);
    }

    const user = await User.findByPk(record.userId, { transaction });
    if (!user) {
      throw AppError.badRequest(INVALID_LINK);
    }

    // Le hook beforeSave du modèle hash le mot de passe
    user.password = password;
    await user.save({ transaction });

    // Nouveau mot de passe : toutes les sessions ouvertes et les codes OTP en cours sont annulés
    // (si le compte était compromis, l'attaquant est déconnecté)
    await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { userId: user.id, revokedAt: null }, transaction },
    );
    await EmailOtpCode.update(
      { consumedAt: new Date() },
      { where: { userId: user.id, consumedAt: null }, transaction },
    );
    return user;
  });

  // Pas d'alerte pour une invitation : c'est le tout premier mot de passe du compte
  if (record.purpose === "reset") {
    notifyPasswordChanged(user);
  }
}
