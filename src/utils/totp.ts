import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) : le code à 6 chiffres affiché par Google Authenticator & co.
 * code = HMAC-SHA1(secret, numéro de la fenêtre de 30 s), réduit à 6 chiffres.
 * Le serveur et le téléphone partagent le secret et l'heure : ils calculent le même code.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
// On accepte aussi la fenêtre précédente et la suivante (±30 s) : tolère un léger décalage d'horloge
const ALLOWED_DRIFT_STEPS = 1;

// Les applis d'authentification attendent le secret en base32
function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Secret base32 invalide");
    }
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// HOTP (RFC 4226) : code pour un compteur donné
function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const hash = createHmac("sha1", key).update(message).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;

  return code.toString().padStart(DIGITS, "0");
}

function timeStep(now: number): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/** Secret aléatoire de 160 bits (taille recommandée par la RFC 4226), encodé en base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function generateTotp(secret: string, now = Date.now()): string {
  return hotp(base32Decode(secret), timeStep(now));
}

/**
 * Vérifie un code. Renvoie le numéro de la fenêtre qui correspond (pour l'anti-rejeu), ou null.
 * timingSafeEqual : la comparaison prend toujours le même temps, on ne peut pas deviner
 * le code chiffre par chiffre en mesurant le temps de réponse.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const key = base32Decode(secret);
  const current = timeStep(now);

  for (let drift = -ALLOWED_DRIFT_STEPS; drift <= ALLOWED_DRIFT_STEPS; drift++) {
    const candidate = hotp(key, current + drift);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) {
      return current + drift;
    }
  }
  return null;
}

/** URI standard lue par les applis d'authentification (c'est ce que contient le QR code). */
export function buildOtpauthUrl(secret: string, accountName: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
