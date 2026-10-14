import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { UserRole } from "../models/user.model.js";

export interface AccessTokenPayload {
  sub: string; // "subject" : l'id de l'utilisateur (nom standard dans les JWT)
  role: UserRole;
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

  if (typeof payload === "string" || typeof payload.sub !== "string") {
    throw new jwt.JsonWebTokenError("Payload invalide");
  }

  return { sub: payload.sub, role: payload.role as UserRole };
}
