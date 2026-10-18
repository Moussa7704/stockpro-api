import { randomInt, randomUUID } from "node:crypto";
import { literal, Op } from "sequelize";
import { logger } from "../../config/logger.js";
import { EmailOtpCode, User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { hmac, safeEqual } from "../../utils/crypto.js";
import type { LoginChallenge } from "../../utils/jwt.js";
import { sendOtpEmail } from "../../utils/mailer.js";

export const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5; // codes faux autorisés par code envoyé
const MAX_RESENDS = 3; // renvois autorisés par connexion
const RESEND_COOLDOWN_SECONDS = 60;
// Anti-spam : nombre max de codes envoyés à un même compte sur 15 minutes
const MAX_CHALLENGES_PER_WINDOW = 10;
const CHALLENGE_WINDOW_MS = 15 * 60 * 1000;

// randomInt (crypto) : tirage uniforme et imprévisible, contrairement à Math.random
function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// Le code est lié à son challenge : le même code tiré pour deux connexions donne deux empreintes différentes
function hashCode(challengeId: string, code: string): string {
  return hmac(`${challengeId}:${code}`);
}

function expiryDate(): Date {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

async function deliverCode(user: User, code: string): Promise<void> {
  try {
    await sendOtpEmail({
      to: user.email,
      name: user.name,
      code,
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  } catch (error) {
    // Le détail (identifiants SMTP refusés, serveur injoignable…) reste dans les logs du serveur
    logger.error({ err: error }, "Échec de l'envoi de l'email OTP");
    throw AppError.serviceUnavailable("Impossible d'envoyer le code par email, réessayez plus tard");
  }
}

async function findActiveOtp(challenge: LoginChallenge): Promise<EmailOtpCode> {
  const otp = await EmailOtpCode.findOne({
    where: { challengeId: challenge.jti, userId: challenge.sub },
  });
  if (!otp || otp.consumedAt) {
    throw AppError.unauthorized("Connexion expirée, reconnectez-vous");
  }
  return otp;
}

/** "moussa@gmail.com" -> "m****a@gmail.com" : le client indique où le code a été envoyé sans tout dévoiler. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (local.length <= 2) {
    return `${local[0] ?? ""}***@${domain}`;
  }
  return `${local[0]}${"*".repeat(Math.min(local.length - 2, 6))}${local.at(-1)}@${domain}`;
}

/** Après un mot de passe correct : crée un code, l'envoie par email, renvoie l'id du challenge. */
export async function createChallenge(user: User): Promise<string> {
  const recentCount = await EmailOtpCode.count({
    where: { userId: user.id, createdAt: { [Op.gt]: new Date(Date.now() - CHALLENGE_WINDOW_MS) } },
  });
  if (recentCount >= MAX_CHALLENGES_PER_WINDOW) {
    throw AppError.tooManyRequests("Trop de codes demandés, réessayez dans 15 minutes");
  }

  // Une seule demande active par utilisateur : les codes précédents non utilisés sont annulés
  await EmailOtpCode.update(
    { consumedAt: new Date() },
    { where: { userId: user.id, consumedAt: null } },
  );

  const challengeId = randomUUID();
  const code = generateCode();
  const otp = await EmailOtpCode.create({
    userId: user.id,
    challengeId,
    codeHash: hashCode(challengeId, code),
    expiresAt: expiryDate(),
    lastSentAt: new Date(),
  });

  try {
    await deliverCode(user, code);
  } catch (error) {
    // Email non parti : on ne laisse pas un challenge inutilisable en base
    await otp.destroy();
    throw error;
  }

  return challengeId;
}

/** Vérifie le code saisi. Lève une erreur 401 si le code est faux, expiré ou épuisé. */
export async function verifyCode(challenge: LoginChallenge, code: string): Promise<void> {
  const otp = await findActiveOtp(challenge);

  if (otp.expiresAt <= new Date()) {
    throw AppError.unauthorized("Code expiré, demandez-en un nouveau");
  }

  // L'essai est compté AVANT la vérification, en une requête atomique :
  // même avec des requêtes simultanées, impossible de dépasser MAX_ATTEMPTS essais
  const [counted] = await EmailOtpCode.update(
    { attempts: literal("attempts + 1") },
    { where: { id: otp.id, consumedAt: null, attempts: { [Op.lt]: MAX_ATTEMPTS } } },
  );
  if (counted === 0) {
    throw AppError.unauthorized("Trop de codes invalides, demandez un nouveau code");
  }

  if (!safeEqual(hashCode(otp.challengeId, code), otp.codeHash)) {
    throw AppError.unauthorized("Code invalide");
  }

  // Un code ne sert qu'une fois (atomique, comme pour les refresh tokens)
  const [consumed] = await EmailOtpCode.update(
    { consumedAt: new Date() },
    { where: { id: otp.id, consumedAt: null } },
  );
  if (consumed === 0) {
    throw AppError.unauthorized("Connexion expirée, reconnectez-vous");
  }
}

/** Renvoie un nouveau code pour la même connexion (l'ancien code ne fonctionne plus). */
export async function resendCode(challenge: LoginChallenge): Promise<void> {
  const otp = await findActiveOtp(challenge);

  if (otp.resendCount >= MAX_RESENDS) {
    throw AppError.tooManyRequests("Nombre maximal de renvois atteint, reconnectez-vous");
  }

  const secondsSinceLastSend = (Date.now() - otp.lastSentAt.getTime()) / 1000;
  if (secondsSinceLastSend < RESEND_COOLDOWN_SECONDS) {
    const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastSend);
    throw AppError.tooManyRequests(`Patientez ${wait} secondes avant de redemander un code`);
  }

  const user = await User.findByPk(otp.userId);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  const code = generateCode();
  // resendCount dans le WHERE : si deux renvois arrivent en même temps, un seul passe
  const [updated] = await EmailOtpCode.update(
    {
      codeHash: hashCode(otp.challengeId, code),
      expiresAt: expiryDate(),
      attempts: 0,
      resendCount: otp.resendCount + 1,
      lastSentAt: new Date(),
    },
    { where: { id: otp.id, consumedAt: null, resendCount: otp.resendCount } },
  );
  if (updated === 0) {
    throw AppError.tooManyRequests("Un code vient déjà d'être renvoyé");
  }

  await deliverCode(user, code);
}
