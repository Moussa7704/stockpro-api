import type { RequestHandler } from "express";
import { User } from "../models/index.js";
import type { UserRole } from "../models/user.model.js";
import { AppError } from "../utils/app-error.js";
import { verifyAccessToken, type AccessTokenPayload } from "../utils/jwt.js";

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return next(AppError.unauthorized("Token manquant"));
  }

  const token = header.slice("Bearer ".length);

  // Le try/catch n'entoure que la vérification : une erreur levée plus loin
  // dans la chaîne ne doit pas être transformée en "token invalide"
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(AppError.unauthorized("Token invalide ou expiré"));
  }

  req.user = payload;
  next();
};

/**
 * Réserve une route à certains rôles. À placer APRÈS authenticate.
 * Le rôle est relu en base : un admin rétrogradé perd l'accès immédiatement,
 * sans attendre l'expiration de son access token (15 min) qui contient l'ancien rôle.
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return async (req, _res, next) => {
    if (!req.user) {
      return next(AppError.unauthorized("Token manquant"));
    }

    const user = await User.findByPk(req.user.sub, { attributes: ["id", "role"] });
    if (!user) {
      return next(AppError.unauthorized("Utilisateur introuvable"));
    }
    if (!roles.includes(user.role)) {
      return next(AppError.forbidden("Vous n'avez pas les droits pour cette action"));
    }

    next();
  };
}
