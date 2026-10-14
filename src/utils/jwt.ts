import { createHmac, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { USER_ROLES, type UserRole } from "../models/user.model.js";

export interface AccessTokenPayload {
  sub: string; // "subject" : l'id de l'utilisateur (nom standard dans les JWT)
  role: UserRole;
}

export interface TwoFactorChallenge {
  sub: string;
  jti: string; // identifiant unique du challenge (pour limiter les essais)
  exp: number; // expiration, en secondes depuis 1970
}

const CHALLENGE_EXPIRES_IN = 5 * 60; // 5 minutes pour saisir le code

// Clé dérivée, différente de celle des access tokens : un challenge ne peut jamais
// être accepté comme access token (sinon on contournerait la 2FA)
const challengeSecret = createHmac("sha256", env.JWT_ACCESS_SECRET)
  .update("2fa-challenge")
  .digest();

function isUserRole(value: unknown): value is UserRole {
  return USER_ROLES.includes(value as UserRole);
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  // Lève une erreur si la signature est fausse ou si le token est expiré.
  // algorithms est imposé : on refuse tout token signé autrement (ex. "alg": "none")
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });

  if (typeof payload === "string" || typeof payload.sub !== "string" || !isUserRole(payload.role)) {
    throw new jwt.JsonWebTokenError("Payload invalide");
  }

  return { sub: payload.sub, role: payload.role };
}

/** Jeton intermédiaire du login 2FA : prouve que le mot de passe a été validé, rien de plus. */
export function signTwoFactorChallenge(userId: string): string {
  return jwt.sign({ sub: userId }, challengeSecret, {
    algorithm: "HS256",
    expiresIn: CHALLENGE_EXPIRES_IN,
    jwtid: randomUUID(),
  });
}

export function verifyTwoFactorChallenge(token: string): TwoFactorChallenge {
  const payload = jwt.verify(token, challengeSecret, { algorithms: ["HS256"] });

  if (
    typeof payload === "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new jwt.JsonWebTokenError("Challenge invalide");
  }

  return { sub: payload.sub, jti: payload.jti, exp: payload.exp };
}
