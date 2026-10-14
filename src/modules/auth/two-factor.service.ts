import QRCode from "qrcode";
import { Op } from "sequelize";
import { User, UserTwoFactor } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { decrypt, encrypt } from "../../utils/crypto.js";
import { buildOtpauthUrl, generateTotpSecret, verifyTotp } from "../../utils/totp.js";

const ISSUER = "StockPro"; // nom affiché dans l'appli d'authentification

export interface TwoFactorSetup {
  secret: string; // pour une saisie manuelle si le QR code ne peut pas être scanné
  otpauthUrl: string;
  qrCode: string; // image PNG en data URL, affichable directement dans un <img>
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
 */
export async function enable(userId: string, code: string): Promise<void> {
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

  // Ce code est consommé : il ne pourra pas resservir au login (anti-rejeu)
  await twoFactor.update({ enabledAt: new Date(), lastUsedStep: step });
}

export async function isEnabled(userId: string): Promise<boolean> {
  const twoFactor = await UserTwoFactor.findByPk(userId);
  return Boolean(twoFactor?.enabledAt);
}

/** Vérifie un code TOTP au login. Un code déjà utilisé est refusé (anti-rejeu). */
export async function verifyLoginCode(userId: string, code: string): Promise<boolean> {
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
