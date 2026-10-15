import type { Transaction } from "sequelize";
import { Company } from "../../models/index.js";

/**
 * Dates en UTC en base, journées dans le fuseau de l'entreprise (D-06) : "aujourd'hui" ou
 * "du 1er au 31" s'entendent à l'heure de Dakar ou d'Abidjan, pas à celle du serveur.
 */

export async function companyTimezone(companyId: string, transaction?: Transaction): Promise<string> {
  const company = await Company.findByPk(companyId, { attributes: ["timezone"], transaction });
  return company!.timezone;
}

/** Jour (AAAA-MM-JJ) d'un instant dans un fuseau donné. */
export function localDate(timezone: string, at: Date = new Date()): string {
  // en-CA formate en AAAA-MM-JJ
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
}

/** Décale un jour AAAA-MM-JJ de `days` jours (calcul calendaire, sans fuseau). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Condition SQL "l'instant `column` tombe entre les jours :from et :to inclus" dans le fuseau :timezone.
 * Attend les remplacements from, to et timezone.
 */
export function localDayRange(column: string): string {
  return `${column} >= (CAST(:from AS date)::timestamp AT TIME ZONE :timezone)
      AND ${column} < ((CAST(:to AS date) + 1)::timestamp AT TIME ZONE :timezone)`;
}
