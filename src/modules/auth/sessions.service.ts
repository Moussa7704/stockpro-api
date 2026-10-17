import { Op } from "sequelize";
import { RefreshToken } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";

/**
 * Appareils connectés de l'utilisateur : une session = la ligne active d'un sessionId (chaque
 * renouvellement remplace la ligne en gardant le sessionId). Fermer une session invalide aussi
 * ses access tokens à la requête suivante (vérifiée par authenticate).
 */

const activeWhere = () => ({ revokedAt: null, expiresAt: { [Op.gt]: new Date() } });

/** La session d'un access token est-elle toujours ouverte ? */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  return (await RefreshToken.count({ where: { sessionId, ...activeWhere() } })) > 0;
}

export async function listSessions(userId: string, currentSessionId?: string) {
  const rows = await RefreshToken.findAll({
    where: { userId, ...activeWhere() },
    attributes: ["sessionId", "sessionStartedAt", "updatedAt", "userAgent", "ipAddress", "expiresAt"],
    order: [["updatedAt", "DESC"]],
  });
  const sessions = rows.map((row) => ({
    id: row.sessionId,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    startedAt: row.sessionStartedAt,
    // Renouvelée au moins toutes les 15 min tant que l'appareil sert : bonne mesure de l'activité
    lastActiveAt: row.updatedAt,
    expiresAt: row.expiresAt,
    current: row.sessionId === currentSessionId,
  }));
  // Cet appareil d'abord, puis les plus récemment actifs
  return [...sessions.filter((session) => session.current), ...sessions.filter((session) => !session.current)];
}

/** Déconnecte un autre appareil ; pour celui-ci, c'est « Se déconnecter » (le cookie est effacé). */
export async function revokeSession(userId: string, sessionId: string, currentSessionId?: string): Promise<void> {
  if (sessionId === currentSessionId) {
    throw AppError.badRequest("C'est l'appareil que vous utilisez : choisissez « Se déconnecter »");
  }
  const [count] = await RefreshToken.update(
    { revokedAt: new Date(), revokeReason: "revoked" },
    { where: { userId, sessionId, revokedAt: null } },
  );
  if (count === 0) {
    throw AppError.notFound("Appareil introuvable ou déjà déconnecté");
  }
}

/** Déconnecte tous les appareils sauf celui-ci ; renvoie combien ont été déconnectés. */
export async function revokeOtherSessions(userId: string, currentSessionId?: string): Promise<number> {
  // Sans session identifiée (jeton émis avant les appareils connectés), on fermerait aussi celle-ci
  if (!currentSessionId) {
    throw AppError.badRequest("Session non identifiée : reconnectez-vous puis réessayez");
  }
  const [count] = await RefreshToken.update(
    { revokedAt: new Date(), revokeReason: "revoked" },
    { where: { userId, revokedAt: null, sessionId: { [Op.ne]: currentSessionId } } },
  );
  return count;
}
