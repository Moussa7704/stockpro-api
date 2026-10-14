import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // taille recommandée pour GCM
const key = Buffer.from(env.TWO_FACTOR_ENCRYPTION_KEY, "hex");

/**
 * Chiffre un texte avec AES-256-GCM.
 * Résultat : "iv.authTag.donnéesChiffrées" (base64url). Un nouvel IV aléatoire à chaque appel :
 * chiffrer deux fois la même valeur donne deux résultats différents.
 * GCM ajoute un "authTag" : toute modification du texte chiffré est détectée au déchiffrement.
 */
export function encrypt(plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, authTag, encrypted] = payload.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !authTag || !encrypted) {
    throw new Error("Donnée chiffrée mal formée");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * Empreinte HMAC-SHA256 (déterministe, donc on peut chercher par empreinte en base).
 * Contrairement à un simple SHA-256, il faut connaître la clé du serveur pour la recalculer :
 * une fuite de la base seule ne permet pas de retrouver les codes par force brute.
 */
export function hmac(value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
