import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { USER_ROLES, type UserRole } from "../models/user.model.js";

export interface AccessTokenPayload {
  sub: string; // "subject" : l'id de l'utilisateur (nom standard dans les JWT)
  role: UserRole;
}

export interface LoginChallenge {
  sub: string; // id de l'utilisateur
  jti: string; // id du challenge = ligne email_otp_codes correspondante
}

// 15 min : laisse le temps de recevoir l'email et de redemander un code si besoin
const CHALLENGE_EXPIRES_IN = 15 * 60;

// Clé dérivée, différente de celle des access tokens : un challenge ne peut jamais
// être accepté comme access token (sinon on contournerait l'OTP)
const challengeSecret = createHmac("sha256", env.JWT_ACCESS_SECRET)
  .update("login-otp-challenge")
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

/** Jeton intermédiaire du login : prouve que le mot de passe a été validé, rien de plus. */
export function signLoginChallenge(userId: string, challengeId: string): string {
  return jwt.sign({ sub: userId }, challengeSecret, {
    algorithm: "HS256",
    expiresIn: CHALLENGE_EXPIRES_IN,
    jwtid: challengeId,
  });
}

export function verifyLoginChallenge(token: string): LoginChallenge {
  const payload = jwt.verify(token, challengeSecret, { algorithms: ["HS256"] });

  if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.jti !== "string") {
    throw new jwt.JsonWebTokenError("Challenge invalide");
  }

  return { sub: payload.sub, jti: payload.jti };
}
