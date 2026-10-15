import { createHash, randomBytes } from "node:crypto";
import { Op } from "sequelize";
import { sequelize } from "../../config/database.js";
import { env } from "../../config/env.js";
import { PasswordToken, RefreshToken, User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import {
  signAccessToken,
  signLoginChallenge,
  verifyLoginChallenge,
  type LoginChallenge,
} from "../../utils/jwt.js";
import type { ChangePasswordInput, LoginInput, LoginOtpInput } from "./auth.schemas.js";
import * as otpService from "./otp.service.js";
import * as passwordService from "./password.service.js";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// SHA-256 suffit ici (pas besoin de bcrypt) : le token est aléatoire sur 256 bits, impossible à deviner
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createSession(user: User): Promise<AuthTokens> {
  const refreshToken = randomBytes(32).toString("base64url");

  await RefreshToken.create({
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_IN_MS),
  });

  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role }),
    refreshToken,
  };
}

async function revokeAllSessions(userId: string): Promise<void> {
  await RefreshToken.update({ revokedAt: new Date() }, { where: { userId, revokedAt: null } });
}

export interface LoginChallengeResult {
  challengeToken: string;
  sentTo: string; // email masqué, ex. m****a@gmail.com
  expiresInSeconds: number;
}

function readChallenge(challengeToken: string): LoginChallenge {
  try {
    return verifyLoginChallenge(challengeToken);
  } catch {
    throw AppError.unauthorized("Connexion expirée, reconnectez-vous");
  }
}

/**
 * Première étape du login : email + mot de passe.
 * Si c'est bon, aucune session n'est encore créée : un code est envoyé par email.
 */
export async function login(input: LoginInput): Promise<LoginChallengeResult> {
  const user = await User.findOne({ where: { email: input.email } });

  // Même message si l'email est inconnu ou si le mot de passe est faux
  if (!user || !(await user.comparePassword(input.password))) {
    throw AppError.unauthorized("Email ou mot de passe incorrect");
  }

  const challengeId = await otpService.createChallenge(user);
  return {
    challengeToken: signLoginChallenge(user.id, challengeId),
    sentTo: otpService.maskEmail(user.email),
    expiresInSeconds: otpService.OTP_TTL_MINUTES * 60,
  };
}

/** Deuxième étape du login : challenge + code reçu par email → la session est créée. */
export async function loginWithOtp(input: LoginOtpInput): Promise<{ user: User } & AuthTokens> {
  const challenge = readChallenge(input.challengeToken);
  await otpService.verifyCode(challenge, input.code);

  const user = await User.findByPk(challenge.sub);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  return { user, ...(await createSession(user)) };
}

export async function resendOtp(challengeToken: string): Promise<{ expiresInSeconds: number }> {
  await otpService.resendCode(readChallenge(challengeToken));
  return { expiresInSeconds: otpService.OTP_TTL_MINUTES * 60 };
}

/**
 * Échange un refresh token contre une nouvelle paire de tokens (rotation) :
 * l'ancien refresh token est révoqué et ne pourra plus jamais servir.
 */
export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const session = await RefreshToken.findOne({ where: { tokenHash: hashToken(refreshToken) } });

  if (!session) {
    throw AppError.unauthorized("Session invalide");
  }

  // Un token déjà révoqué qui revient a probablement été volé :
  // on ferme toutes les sessions de l'utilisateur par précaution
  if (session.revokedAt) {
    await revokeAllSessions(session.userId);
    throw AppError.unauthorized("Session invalide");
  }

  if (session.expiresAt <= new Date()) {
    throw AppError.unauthorized("Session expirée");
  }

  // La condition revokedAt: null rend la révocation atomique :
  // si deux requêtes utilisent le même token en même temps, une seule passe
  const [revokedCount] = await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { id: session.id, revokedAt: null } },
  );
  if (revokedCount === 0) {
    await revokeAllSessions(session.userId);
    throw AppError.unauthorized("Session invalide");
  }

  const user = await User.findByPk(session.userId);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  return createSession(user);
}

export async function logout(refreshToken: string): Promise<void> {
  await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { tokenHash: hashToken(refreshToken), revokedAt: null } },
  );
}

export async function getMe(userId: string): Promise<User> {
  const user = await User.findByPk(userId);

  // Le token peut être encore valide alors que le compte a été supprimé
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  return user;
}

/**
 * Changement de mot de passe par un utilisateur connecté.
 * Les autres appareils sont déconnectés ; la session en cours (currentRefreshToken) est conservée.
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  currentRefreshToken?: string,
): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  // 400 et pas 401 : l'utilisateur est bien connecté, un 401 pousserait le client à rafraîchir sa session
  if (!(await user.comparePassword(input.currentPassword))) {
    throw AppError.badRequest("Mot de passe actuel incorrect");
  }
  if (input.newPassword === input.currentPassword) {
    throw AppError.badRequest("Le nouveau mot de passe doit être différent de l'actuel");
  }

  await sequelize.transaction(async (transaction) => {
    // Le hook beforeSave du modèle hash le mot de passe
    user.password = input.newPassword;
    await user.save({ transaction });

    const keepCurrentSession = currentRefreshToken
      ? { tokenHash: { [Op.ne]: hashToken(currentRefreshToken) } }
      : {};
    await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { userId, revokedAt: null, ...keepCurrentSession }, transaction },
    );

    // Un lien "mot de passe oublié" encore valide ne doit pas pouvoir écraser le nouveau mot de passe
    await PasswordToken.update(
      { usedAt: new Date() },
      { where: { userId, usedAt: null }, transaction },
    );
  });

  passwordService.notifyPasswordChanged(user);
}
