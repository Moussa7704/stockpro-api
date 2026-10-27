import ExcelJS from "exceljs";
import { AppError } from "./app-error.js";

/**
 * Lecture d'un fichier tableur envoyé par un commerçant (.xlsx ou .csv), tel qu'il l'a fait :
 * en-tête pas forcément en première ligne, lignes vides, CSV au point-virgule (Excel français)
 * ou en encodage Windows. Tout est rendu en texte : la validation se fait ensuite, champ par champ.
 */

export interface SheetRow {
  /** Numéro de ligne dans le fichier (1 = première ligne), pour les messages d'erreur */
  line: number;
  cells: string[];
}

export interface SheetTable {
  headers: string[];
  rows: SheetRow[];
}

export const SPREADSHEET_EXTENSIONS = [".xlsx", ".csv"] as const;
// L'en-tête est cherché dans les premières lignes (titre, nom de la boutique… au-dessus)
const HEADER_SEARCH_LINES = 20;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export async function readSpreadsheet(buffer: Buffer, filename: string, maxRows: number): Promise<SheetTable> {
  const extension = extensionOf(filename);
  const lines = extension === ".csv" ? readCsv(buffer) : await readXlsx(buffer);
  return toTable(lines, maxRows);
}

// --- Excel

/** Valeur d'une cellule en texte (formule → son résultat, texte enrichi → texte brut, date → AAAA-MM-JJ). */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  // Un nombre Excel est un flottant : 15 chiffres significatifs effacent les 0,1 + 0,2 parasites
  if (typeof value === "number") return String(Number(value.toPrecision(15)));
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("result" in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
  if ("text" in value) return String(value.text);
  return "";
}

async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw AppError.badRequest("Fichier Excel illisible : enregistrez-le au format .xlsx et réessayez");
  }
  // Première feuille qui contient quelque chose
  const sheet = workbook.worksheets.find((worksheet) => worksheet.actualRowCount > 0);
  if (!sheet) {
    return [];
  }
  const lines: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = row.values as ExcelJS.CellValue[]; // index 0 inutilisé (colonnes numérotées à partir de 1)
    lines[rowNumber - 1] = values.slice(1).map((value) => cellText(value).trim());
  });
  return Array.from(lines, (line) => line ?? []);
}

// --- CSV

/** UTF-8 si le fichier en est, sinon Windows-1252 (CSV enregistré par Excel sous Windows). */
function decode(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1252").decode(buffer);
  }
  return text.replace(/^﻿/, "");
}

/** Séparateur le plus fréquent de la première ligne : ";" (Excel français), "," ou tabulation. */
function guessDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }));
  return counts.sort((a, b) => b.count - a.count)[0]!.delimiter;
}

/** CSV (RFC 4180) : champs entre guillemets, "" pour un guillemet, retours à la ligne dans un champ. */
function readCsv(buffer: Buffer): string[][] {
  const text = decode(buffer);
  const delimiter = guessDelimiter(text);
  const lines: string[][] = [];
  let line: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      line.push(field.trim());
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      line.push(field.trim());
      lines.push(line);
      line = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || line.length > 0) {
    line.push(field.trim());
    lines.push(line);
  }
  return lines;
}

// --- En-tête et lignes

/** En-tête = première ligne d'au moins deux cellules remplies ; noms vides ou en double rendus uniques. */
function toTable(lines: string[][], maxRows: number): SheetTable {
  const filled = (line: string[]) => line.filter((cell) => cell !== "").length;
  const headerIndex = lines.slice(0, HEADER_SEARCH_LINES).findIndex((line) => filled(line) >= 2);
  if (headerIndex === -1) {
    throw AppError.badRequest("Aucune ligne d'en-tête trouvée : la première ligne doit nommer les colonnes");
  }

  const width = Math.max(...lines.map((line) => line.length));
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, column) => {
    const name = lines[headerIndex]![column] || `Colonne ${column + 1}`;
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), count);
    return count > 1 ? `${name} (${count})` : name;
  });

  const rows: SheetRow[] = [];
  lines.slice(headerIndex + 1).forEach((line, offset) => {
    if (filled(line) > 0) {
      rows.push({ line: headerIndex + offset + 2, cells: headers.map((_, column) => line[column] ?? "") });
    }
  });
  if (rows.length === 0) {
    throw AppError.badRequest("Le fichier ne contient aucune ligne sous l'en-tête");
  }
  if (rows.length > maxRows) {
    throw AppError.badRequest(`Trop de lignes (${rows.length}) : ${maxRows} au maximum, découpez le fichier`);
  }
  return { headers, rows };
}
