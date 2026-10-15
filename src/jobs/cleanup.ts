import { Op } from "sequelize";
import { EmailOtpCode, PasswordToken, RefreshToken } from "../models/index.js";

/**
 * Purge des données d'authentification devenues inutiles : sans elle, ces tables grossissent
 * indéfiniment (une ligne par connexion, par code envoyé, par lien de mot de passe).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface CleanupResult {
  refreshTokens: number;
  otpCodes: number;
  passwordTokens: number;
}

export async function runCleanup(now = new Date()): Promise<CleanupResult> {
  const oneDayAgo = new Date(now.getTime() - DAY_MS);

  // Sessions expirées. Les sessions révoquées mais pas encore expirées sont gardées :
  // si l'une d'elles est réutilisée, c'est le signe d'un vol (toutes les sessions sont alors fermées)
  const refreshTokens = await RefreshToken.destroy({
    where: { expiresAt: { [Op.lt]: now } },
  });

  // Codes OTP de plus de 24 h (la limite anti-spam ne compte que les 15 dernières minutes)
  const otpCodes = await EmailOtpCode.destroy({
    where: { createdAt: { [Op.lt]: oneDayAgo } },
  });

  // Liens de mot de passe expirés ou utilisés depuis plus de 24 h (la limite anti-spam compte sur 1 h)
  const passwordTokens = await PasswordToken.destroy({
    where: {
      [Op.or]: [{ expiresAt: { [Op.lt]: oneDayAgo } }, { usedAt: { [Op.lt]: oneDayAgo } }],
    },
  });

  return { refreshTokens, otpCodes, passwordTokens };
}

/**
 * Lance la purge au démarrage puis toutes les heures.
 * Avec plusieurs instances de l'API, chacune purge : sans danger, les suppressions se recoupent.
 */
export function startCleanupJob(intervalMs = HOUR_MS): () => void {
  const run = () => {
    runCleanup()
      .then((result) => {
        const total = result.refreshTokens + result.otpCodes + result.passwordTokens;
        if (total > 0) {
          console.log("Purge auth :", result);
        }
      })
      .catch((error: unknown) => console.error("Échec de la purge auth :", error));
  };

  run();
  const timer = setInterval(run, intervalMs);
  // unref : ce minuteur n'empêche pas le processus de s'arrêter
  timer.unref();
  return () => clearInterval(timer);
}
