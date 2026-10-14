import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { TwoFactorBackupCode, User, UserTwoFactor } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { decrypt, encrypt, hmac } from "../../utils/crypto.js";
import { buildOtpauthUrl, generateTotpSecret, verifyTotp } from "../../utils/totp.js";

const ISSUER = "StockPro"; // nom affiché dans l'appli d'authentification

const BACKUP_CODE_COUNT = 10;
// Sans 0/O, 1/I/L : pas de confusion quand on recopie un code imprimé
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BACKUP_CODE_LENGTH = 8;

export interface TwoFactorSetup {
  secret: string; // pour une saisie manuelle si le QR code ne peut pas être scanné
  otpauthUrl: string;
  qrCode: string; // image PNG en data URL, affichable directement dans un <img>
}

export type SecondFactorMethod = "totp" | "backup";

// "abcd-efgh" et "ABCDEFGH" désignent le même code
function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

function generateBackupCode(): string {
  let code = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    // randomInt (crypto) : tirage uniforme et imprévisible, contrairement à Math.random
    code += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Remplace tous les codes de secours de l'utilisateur. Les codes en clair ne sont renvoyés qu'ici. */
async function replaceBackupCodes(userId: string, transaction: Transaction): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);

  await TwoFactorBackupCode.destroy({ where: { userId }, transaction });
  await TwoFactorBackupCode.bulkCreate(
    codes.map((code) => ({ userId, codeHash: hmac(normalizeBackupCode(code)) })),
    { transaction },
  );

  return codes;
}

/** Code TOTP : refusé s'il a déjà été utilisé (anti-rejeu). */
async function verifyTotpCode(userId: string, code: string): Promise<boolean> {
  const twoFactor = await UserTwoFactor.findByPk(userId);
  if (!twoFactor?.enabledAt) {
    return false;
  }

  const step = verifyTotp(decrypt(twoFactor.secretEncrypted), code);
  if (step === null) {
    return false;
  }

  // On n'accepte qu'une fenêtre plus récente que la dernière utilisée.
  // La condition dans le WHERE rend la vérification atomique : deux requêtes
  // simultanées avec le même code ne peuvent pas passer toutes les deux.
  const [updatedCount] = await UserTwoFactor.update(
    { lastUsedStep: step },
    {
      where: {
        userId,
        [Op.or]: [{ lastUsedStep: null }, { lastUsedStep: { [Op.lt]: step } }],
      },
    },
  );
  return updatedCount === 1;
}

/** Code de secours : consommé de façon atomique, il ne sert qu'une fois. */
async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const [updatedCount] = await TwoFactorBackupCode.update(
    { usedAt: new Date() },
    { where: { userId, codeHash: hmac(normalizeBackupCode(code)), usedAt: null } },
  );
  return updatedCount === 1;
}

async function getEnabledTwoFactor(userId: string): Promise<UserTwoFactor> {
  const twoFactor = await UserTwoFactor.findByPk(userId);
  if (!twoFactor?.enabledAt) {
    throw AppError.badRequest("La double authentification n'est pas activée");
  }
  return twoFactor;
}

/** Actions sensibles (désactiver, régénérer) : mot de passe ET second facteur exigés. */
async function assertPasswordAndCode(userId: string, password: string, code: string): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  // Volontairement 400 et pas 401 : l'utilisateur est bien connecté,
  // un 401 pousserait le client à rafraîchir sa session pour rien
  const passwordOk = await user.comparePassword(password);
  if (!passwordOk || !(await verifySecondFactor(userId, code))) {
    throw AppError.badRequest("Mot de passe ou code incorrect");
  }
}

/**
 * Étape 1 de l'activation : génère un nouveau secret (pas encore actif).
 * Peut être relancé tant que la 2FA n'est pas confirmée : l'ancien secret est remplacé.
 */
export async function setup(userId: string): Promise<TwoFactorSetup> {
  const user = await User.findByPk(userId);
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  const existing = await UserTwoFactor.findByPk(userId);
  if (existing?.enabledAt) {
    throw AppError.conflict("La double authentification est déjà activée");
  }

  const secret = generateTotpSecret();
  await UserTwoFactor.upsert({
    userId,
    secretEncrypted: encrypt(secret),
    enabledAt: null,
    lastUsedStep: null,
  });

  const otpauthUrl = buildOtpauthUrl(secret, user.email, ISSUER);
  return { secret, otpauthUrl, qrCode: await QRCode.toDataURL(otpauthUrl) };
}

/**
 * Étape 2 de l'activation : l'utilisateur envoie un code généré par son appli.
 * On n'active qu'après cette preuve, sinon un QR mal scanné bloquerait le compte.
 * Renvoie les codes de secours, affichés une seule fois.
 */
export async function enable(userId: string, code: string): Promise<string[]> {
  const twoFactor = await UserTwoFactor.findByPk(userId);
  if (!twoFactor) {
    throw AppError.badRequest("Lancez d'abord la configuration (POST /api/auth/2fa/setup)");
  }
  if (twoFactor.enabledAt) {
    throw AppError.conflict("La double authentification est déjà activée");
  }

  const step = verifyTotp(decrypt(twoFactor.secretEncrypted), code);
  if (step === null) {
    throw AppError.badRequest("Code invalide");
  }

  // Transaction : activation et codes de secours sont créés ensemble, ou pas du tout
  return sequelize.transaction(async (transaction) => {
    // Ce code est consommé : il ne pourra pas resservir au login (anti-rejeu)
    await twoFactor.update({ enabledAt: new Date(), lastUsedStep: step }, { transaction });
    return replaceBackupCodes(userId, transaction);
  });
}

export async function disable(userId: string, password: string, code: string): Promise<void> {
  await getEnabledTwoFactor(userId);
  await assertPasswordAndCode(userId, password, code);

  await sequelize.transaction(async (transaction) => {
    await TwoFactorBackupCode.destroy({ where: { userId }, transaction });
    await UserTwoFactor.destroy({ where: { userId }, transaction });
  });
}

/** Nouveaux codes de secours (les anciens deviennent invalides), ex. quand il n'en reste plus. */
export async function regenerateBackupCodes(
  userId: string,
  password: string,
  code: string,
): Promise<string[]> {
  await getEnabledTwoFactor(userId);
  await assertPasswordAndCode(userId, password, code);

  return sequelize.transaction((transaction) => replaceBackupCodes(userId, transaction));
}

export async function isEnabled(userId: string): Promise<boolean> {
  const twoFactor = await UserTwoFactor.findByPk(userId);
  return Boolean(twoFactor?.enabledAt);
}

/** Vérifie le second facteur : code à 6 chiffres de l'appli, sinon code de secours. */
export async function verifySecondFactor(
  userId: string,
  code: string,
): Promise<SecondFactorMethod | null> {
  if (/^\d{6}$/.test(code)) {
    return (await verifyTotpCode(userId, code)) ? "totp" : null;
  }
  return (await consumeBackupCode(userId, code)) ? "backup" : null;
}

export async function countRemainingBackupCodes(userId: string): Promise<number> {
  return TwoFactorBackupCode.count({ where: { userId, usedAt: null } });
}
