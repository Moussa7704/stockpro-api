import { createHash, randomBytes } from "node:crypto";
import { UniqueConstraintError } from "sequelize";
import { env } from "../../config/env.js";
import { RefreshToken, User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import {
  signAccessToken,
  signTwoFactorChallenge,
  verifyTwoFactorChallenge,
  type TwoFactorChallenge,
} from "../../utils/jwt.js";
import type { LoginInput, LoginTwoFactorInput, RegisterInput } from "./auth.schemas.js";
import {
  assertChallengeUsable,
  markChallengeUsed,
  recordFailedAttempt,
} from "./challenge-attempts.js";
import * as twoFactorService from "./two-factor.service.js";

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

export async function register(input: RegisterInput): Promise<User> {
  try {
    // Le hash du mot de passe est fait par le hook beforeSave du modèle
    return await User.create(input);
  } catch (error) {
    // L'index unique sur email garantit qu'il n'y a pas de doublon, même avec deux requêtes simultanées
    if (error instanceof UniqueConstraintError) {
      throw AppError.conflict("Un compte existe déjà avec cet email");
    }
    throw error;
  }
}

export type LoginResult =
  | ({ twoFactorRequired: false; user: User } & AuthTokens)
  | { twoFactorRequired: true; challengeToken: string };

export async function login(input: LoginInput): Promise<LoginResult> {
  const user = await User.findOne({ where: { email: input.email } });

  // Même message si l'email est inconnu ou si le mot de passe est faux
  if (!user || !(await user.comparePassword(input.password))) {
    throw AppError.unauthorized("Email ou mot de passe incorrect");
  }

  // 2FA activée : pas encore de session, seulement un challenge à compléter avec le code
  if (await twoFactorService.isEnabled(user.id)) {
    return { twoFactorRequired: true, challengeToken: signTwoFactorChallenge(user.id) };
  }

  return { twoFactorRequired: false, user, ...(await createSession(user)) };
}

/**
 * Deuxième étape du login : challenge (mot de passe déjà validé) + code de l'appli ou de secours.
 * backupCodesRemaining n'est renseigné que si un code de secours a été utilisé.
 */
export async function loginWithTwoFactor(
  input: LoginTwoFactorInput,
): Promise<{ user: User; backupCodesRemaining?: number } & AuthTokens> {
  let challenge: TwoFactorChallenge;
  try {
    challenge = verifyTwoFactorChallenge(input.challengeToken);
  } catch {
    throw AppError.unauthorized("Connexion expirée, reconnectez-vous");
  }

  assertChallengeUsable(challenge);

  const method = await twoFactorService.verifySecondFactor(challenge.sub, input.code);
  if (!method) {
    recordFailedAttempt(challenge);
    throw AppError.unauthorized("Code invalide");
  }
  markChallengeUsed(challenge);

  const user = await User.findByPk(challenge.sub);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  const session = await createSession(user);
  if (method === "backup") {
    // Le client peut avertir l'utilisateur quand il ne lui reste presque plus de codes
    const backupCodesRemaining = await twoFactorService.countRemainingBackupCodes(user.id);
    return { user, ...session, backupCodesRemaining };
  }
  return { user, ...session };
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
