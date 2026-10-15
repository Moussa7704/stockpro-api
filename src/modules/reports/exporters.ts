import ExcelJS from "exceljs";
import type { Response } from "express";
import PDFDocument from "pdfkit";
import { currencyLabel, formatAmount, formatQuantity } from "../../utils/format.js";
import type { ExportFormat } from "./reports.schemas.js";

/**
 * Exports des rapports : un même tableau (colonnes typées + lignes + totaux) rendu en Excel
 * (valeurs numériques, formules possibles côté utilisateur) ou en PDF A4 imprimable.
 */

export type ColumnType = "text" | "money" | "quantity" | "percent" | "integer";

export interface ReportColumn {
  key: string;
  header: string;
  type?: ColumnType;
  /** Largeur relative (Excel : en caractères) */
  width?: number;
}

export type ReportRow = Record<string, string | number | null | undefined>;

export interface ReportTable {
  title: string;
  /** Lignes d'en-tête : entreprise, période, boutique… */
  subtitle: string[];
  currency: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow;
  /** Nom de fichier sans extension */
  filename: string;
}

const isNumeric = (type: ColumnType | undefined) => type !== undefined && type !== "text";
const defaultWidth = (column: ReportColumn) => column.width ?? (column.type === "text" || !column.type ? 24 : 14);

function display(value: ReportRow[string], type: ColumnType | undefined, currency: string): string {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  switch (type) {
    case "money":
      return formatAmount(text, currency);
    case "quantity":
      return formatQuantity(text);
    case "percent":
      return `${text.replace(".", ",")} %`;
    default:
      return text;
  }
}

// --- Excel
export async function toXlsx(table: ReportTable): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockPro";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(table.title.slice(0, 31));
  const moneyFormat = table.currency === "XOF" ? "#,##0" : "#,##0.00";
  const formats: Record<ColumnType, string | undefined> = {
    text: undefined,
    money: moneyFormat,
    quantity: "#,##0.###",
    percent: '0.0" %"',
    integer: "0",
  };

  sheet.addRow([table.title]).font = { bold: true, size: 14 };
  for (const line of table.subtitle) {
    sheet.addRow([line]).font = { color: { argb: "FF555555" } };
  }
  sheet.addRow([`Montants en ${currencyLabel(table.currency)}`]).font = { italic: true, color: { argb: "FF555555" } };
  sheet.addRow([]);

  const header = sheet.addRow(table.columns.map((column) => column.header));
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  });
  const headerRow = header.number;

  const cellValue = (value: ReportRow[string], type: ColumnType | undefined) => {
    if (value === null || value === undefined || value === "") return null;
    // Montants et quantités : nombres dans Excel pour pouvoir trier et additionner
    return isNumeric(type) ? Number(value) : String(value);
  };
  for (const row of table.rows) {
    sheet.addRow(table.columns.map((column) => cellValue(row[column.key], column.type)));
  }
  if (table.totals) {
    const totals = sheet.addRow(table.columns.map((column) => cellValue(table.totals![column.key], column.type)));
    totals.font = { bold: true };
    totals.eachCell((cell) => {
      cell.border = { top: { style: "thin" } };
    });
  }

  table.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    sheetColumn.width = defaultWidth(column);
    const format = formats[column.type ?? "text"];
    if (format) {
      sheetColumn.eachCell((cell, rowNumber) => {
        if (rowNumber > headerRow) cell.numFmt = format;
      });
    }
  });
  sheet.views = [{ state: "frozen", ySplit: headerRow }];

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// --- PDF
// Les polices PDF standard (WinAnsi) ignorent certains caractères : on les remplace par un équivalent
const pdfSafe = (text: string) =>
  text
    .replace(/[\u2212\u2010\u2011]/g, "-")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[^\u0020-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u20ac\u0152\u0153]/g, "?");

export function toPdf(table: ReportTable): Promise<Buffer> {
  const landscape = table.columns.length > 6;
  const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 20;
  const totalWeight = table.columns.reduce((sum, column) => sum + defaultWidth(column), 0);
  const widths = table.columns.map((column) => (defaultWidth(column) / totalWeight) * usable);
  const rowHeight = 16;

  doc.font("Helvetica-Bold").fontSize(14).text(pdfSafe(table.title), left, doc.y);
  doc.font("Helvetica").fontSize(9).fillColor("#555555");
  for (const line of table.subtitle) doc.text(pdfSafe(line));
  doc.text(`Montants en ${currencyLabel(table.currency)}`);
  doc.fillColor("#000000").moveDown(0.8);

  const drawRow = (values: string[], options: { header?: boolean; bold?: boolean; shaded?: boolean }) => {
    const y = doc.y;
    if (options.header) doc.rect(left, y, usable, rowHeight).fill("#1F4E79");
    else if (options.shaded) doc.rect(left, y, usable, rowHeight).fill("#F2F5F9");
    doc.font(options.header || options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    doc.fillColor(options.header ? "#FFFFFF" : "#000000");
    let x = left;
    values.forEach((value, index) => {
      doc.text(pdfSafe(value), x + 3, y + 4, {
        width: widths[index]! - 6,
        align: isNumeric(table.columns[index]!.type) ? "right" : "left",
        lineBreak: false,
        ellipsis: true,
      });
      x += widths[index]!;
    });
    doc.fillColor("#000000");
    doc.y = y + rowHeight;
    doc.x = left;
  };
  const headerValues = table.columns.map((column) => column.header);
  const ensureSpace = () => {
    if (doc.y + rowHeight > bottom) {
      doc.addPage();
      drawRow(headerValues, { header: true });
    }
  };

  drawRow(headerValues, { header: true });
  table.rows.forEach((row, index) => {
    ensureSpace();
    drawRow(
      table.columns.map((column) => display(row[column.key], column.type, table.currency)),
      { shaded: index % 2 === 1 },
    );
  });
  if (table.totals) {
    ensureSpace();
    doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).lineWidth(0.5).stroke();
    drawRow(table.columns.map((column) => display(table.totals![column.key], column.type, table.currency)), { bold: true });
  }
  if (table.rows.length === 0) {
    doc.moveDown().font("Helvetica-Oblique").fontSize(9).text("Aucune donnée sur cette période.", left);
  }

  // Pied de page : date d'édition et pagination
  const range = doc.bufferedPageRange();
  const printedAt = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    // Écrire sous la marge basse ferait ajouter une page par pdfkit : on la lève le temps du pied de page
    const marginBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7).fillColor("#777777");
    doc.text(
      `StockPro — édité le ${printedAt} UTC — page ${page - range.start + 1}/${range.count}`,
      left,
      doc.page.height - marginBottom + 8,
      { width: usable, align: "center", lineBreak: false },
    );
    doc.page.margins.bottom = marginBottom;
  }
  doc.end();
  return done;
}

const CONTENT_TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

/** Réponse JSON, ou fichier à télécharger (Excel / PDF) construit à partir du même rapport. */
export async function sendReport<T>(res: Response, format: ExportFormat, data: T, toTable: (data: T) => ReportTable) {
  if (format === "json") {
    res.json({ report: data });
    return;
  }
  const table = toTable(data);
  const body = format === "xlsx" ? await toXlsx(table) : await toPdf(table);
  const filename = `${table.filename.normalize("NFD").replace(/[^\w.-]+/g, "_")}.${format}`;
  res
    .status(200)
    .set({ "Content-Type": CONTENT_TYPES[format], "Content-Disposition": `attachment; filename="${filename}"` })
    .send(body);
}
