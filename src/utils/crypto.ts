import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

const key = Buffer.from(env.OTP_SECRET_KEY, "hex");

/**
 * Empreinte HMAC-SHA256 (déterministe, donc comparable à une valeur stockée en base).
 * Contrairement à un simple SHA-256, il faut connaître la clé du serveur pour la recalculer :
 * une fuite de la base seule ne permet pas de retrouver un code à 6 chiffres par force brute.
 */
export function hmac(value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

/** Comparaison en temps constant : on ne peut pas deviner une valeur en mesurant le temps de réponse. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
