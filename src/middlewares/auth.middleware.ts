import type { RequestHandler } from "express";
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
