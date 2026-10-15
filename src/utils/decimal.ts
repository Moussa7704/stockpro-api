import { z } from "zod";

/**
 * Montants et quantités : toujours des chaînes décimales ("1500", "2.750"), jamais des
 * nombres flottants JavaScript (0.1 + 0.2 = 0.30000000000000004). PostgreSQL (NUMERIC)
 * fait les calculs exacts ; côté Node, on se limite à valider et comparer.
 */

// Nombre de décimales par devise (D-01 : FCFA sans centimes)
const CURRENCY_DECIMALS: Record<string, number> = { XOF: 0 };

export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency] ?? 2;
}

/** Accepte 1500, "1500" ou "1500.50" et renvoie une chaîne normalisée ("1500.50"). */
function decimalString(maxIntegerDigits: number, maxDecimals: number, label: string) {
  const pattern = new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,${maxDecimals}})?$`);
  return z
    .union([z.number(), z.string()])
    .transform((value) => (typeof value === "number" ? String(value) : value.trim().replace(",", ".")))
    .pipe(z.string().regex(pattern, `${label} invalide (nombre positif, ${maxDecimals} décimales max)`));
}

// NUMERIC(14,2) : 12 chiffres avant la virgule, 2 après
export const amountSchema = decimalString(12, 2, "Montant");
// NUMERIC(14,3) : 11 chiffres avant la virgule, 3 après
export const quantitySchema = decimalString(11, 3, "Quantité");

/** Nombre de décimales significatives : "1500.50" → 1, "1500.00" → 0, "2.125" → 3. */
export function significantDecimals(value: string): number {
  const fraction = value.split(".")[1]?.replace(/0+$/, "") ?? "";
  return fraction.length;
}

export function isWhole(value: string): boolean {
  return significantDecimals(value) === 0;
}

/** Forme canonique d'un décimal positif : "0010.50" → "10.5", "1500.00" → "1500". */
export function normalizeDecimal(value: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const cleanInteger = integer.replace(/^0+(?=\d)/, "");
  const cleanFraction = fraction.replace(/0+$/, "");
  return cleanFraction ? `${cleanInteger}.${cleanFraction}` : cleanInteger;
}

/** Égalité exacte de deux décimaux (null = absence de valeur), sans passer par les flottants. */
export function sameDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  return normalizeDecimal(a) === normalizeDecimal(b);
}
