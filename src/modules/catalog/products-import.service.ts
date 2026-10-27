import ExcelJS from "exceljs";
import { QueryTypes, type Transaction } from "sequelize";
import type { z } from "zod";
import { sequelize } from "../../config/database.js";
import { Category, Product, Unit } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { amountSchema, currencyDecimals, isWhole, quantitySchema, significantDecimals } from "../../utils/decimal.js";
import { readSpreadsheet, type SheetTable } from "../../utils/spreadsheet.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { rethrowAsConflict } from "./catalog.helpers.js";
import {
  barcodeSchema,
  IMPORT_FIELDS,
  skuSchema,
  type ImportField,
  type ImportProductsOptions,
} from "./catalog.schemas.js";

/**
 * Import du catalogue depuis le fichier que le commerçant possède déjà (.xlsx ou .csv), en 3 temps :
 * 1. analyse : colonnes du fichier, quelques lignes d'exemple, correspondance proposée ;
 * 2. aperçu (dryRun) : chaque ligne contrôlée → à créer, déjà existante, ignorée ou en erreur ;
 * 3. import : tout ou rien, dans une seule transaction, audité.
 * Un produit déjà connu (même SKU ou même code-barres) n'est pas modifié.
 */

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

const FIELD_LABELS: Record<ImportField, string> = {
  name: "Nom",
  sku: "SKU",
  barcode: "Code-barres",
  category: "Catégorie",
  unit: "Unité",
  salePrice: "Prix de vente",
  purchasePrice: "Prix d'achat",
  alertThreshold: "Seuil d'alerte",
  description: "Description",
};
const REQUIRED_FIELDS: ImportField[] = ["name", "salePrice"];

/** Minuscules, sans accents ni ponctuation : « Désignation » → « designation », « Qté. » → « qte ». */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Intitulés courants des fichiers de boutique (déjà normalisés), en plus des libellés de StockPro
const SYNONYMS: Record<ImportField, string[]> = {
  name: ["designation", "libelle", "nom", "article", "produit", "intitule", "nom du produit", "nom article"],
  sku: ["sku", "reference", "ref", "code article", "code produit", "code interne", "code"],
  barcode: ["code barre", "code barres", "codebarre", "ean", "ean13", "gencod", "gencode"],
  category: ["categorie", "famille", "rayon", "groupe", "sous famille"],
  unit: ["unite", "unite de mesure", "um", "conditionnement"],
  salePrice: ["prix de vente", "prix vente", "pv", "prix", "pu", "prix unitaire", "tarif", "prix ttc", "prix de vente ttc"],
  purchasePrice: ["prix d achat", "prix achat", "pa", "cout", "cout unitaire", "prix de revient", "pr", "cout d achat"],
  alertThreshold: ["seuil", "seuil d alerte", "stock min", "stock minimum", "alerte", "minimum", "qte min"],
  description: ["description", "details", "detail", "observation", "observations", "remarque", "commentaire"],
};
for (const field of IMPORT_FIELDS) {
  SYNONYMS[field].push(normalize(FIELD_LABELS[field]));
}

/**
 * Correspondance proposée colonne du fichier → champ : d'abord les intitulés identiques,
 * puis ceux qui contiennent un synonyme (le plus long d'abord : « prix d'achat » avant « prix »).
 * Chaque colonne et chaque champ ne servent qu'une fois ; l'utilisateur corrige ensuite.
 */
export function suggestMapping(headers: string[]): Partial<Record<ImportField, string>> {
  const mapping: Partial<Record<ImportField, string>> = {};
  const used = new Set<string>();
  const candidates = IMPORT_FIELDS.flatMap((field) => SYNONYMS[field].map((synonym) => ({ field, synonym }))).sort(
    (a, b) => b.synonym.length - a.synonym.length,
  );

  const assign = (matches: (header: string, synonym: string) => boolean) => {
    for (const { field, synonym } of candidates) {
      if (mapping[field]) continue;
      const header = headers.find((name) => !used.has(name) && matches(normalize(name), synonym));
      if (header) {
        mapping[field] = header;
        used.add(header);
      }
    }
  };
  assign((header, synonym) => header === synonym);
  assign((header, synonym) => ` ${header} `.includes(` ${synonym} `));
  return mapping;
}

async function readFile(file: UploadedFile): Promise<SheetTable> {
  return readSpreadsheet(file.buffer, file.originalname, IMPORT_MAX_ROWS);
}

/** Étape 1 : ce que contient le fichier et la correspondance proposée. Rien n'est écrit. */
export async function analyzeFile(file: UploadedFile) {
  const table = await readFile(file);
  return {
    filename: file.originalname,
    columns: table.headers,
    rowCount: table.rows.length,
    sample: table.rows.slice(0, 10),
    fields: IMPORT_FIELDS.map((field) => ({ field, label: FIELD_LABELS[field], required: REQUIRED_FIELDS.includes(field) })),
    suggestedMapping: suggestMapping(table.headers),
  };
}

// --- Contrôle des lignes

export type ImportRowStatus = "create" | "existing" | "skipped" | "error";

export interface ImportRowResult {
  line: number;
  status: ImportRowStatus;
  name: string;
  sku: string | null;
  /** SKU généré par StockPro (la ligne n'en avait pas) */
  generatedSku?: boolean;
  messages?: string[];
}

interface PlannedProduct {
  row: ImportRowResult;
  barcode: string | null;
  description: string | null;
  categoryKey: string | null;
  unitId: string;
  salePrice: string;
  purchasePriceHint: string | null;
  alertThreshold: string;
}

// Écritures courantes des unités par défaut, rapportées à leur symbole
const UNIT_ALIASES: Record<string, string> = {
  piece: "pce",
  pieces: "pce",
  pc: "pce",
  pcs: "pce",
  u: "pce",
  unite: "pce",
  unites: "pce",
  kilo: "kg",
  kilos: "kg",
  kilogrammes: "kg",
  kgs: "kg",
  litres: "l",
  lt: "l",
  ltr: "l",
  metres: "m",
  mt: "m",
};

/** « 1 500 F », « 1500,50 », 1500 → décimal validé, ou null si illisible. */
function parseDecimal(schema: z.ZodType<string>, raw: string): string | null {
  const cleaned = raw.replace(/[\s  ]/g, "").replace(/(fcfa|cfa|xof|eur|€|\$|f)$/i, "");
  const result = schema.safeParse(cleaned);
  return result.success ? result.data : null;
}

/** Dernier numéro des SKU générés (ART-000123) : les suivants continuent la série. */
async function lastGeneratedSku(companyId: string, transaction: Transaction): Promise<number> {
  const [row] = await sequelize.query<{ last: string | null }>(
    `SELECT MAX(CAST(substring(sku FROM 5) AS bigint)) AS last FROM products
     WHERE company_id = :companyId AND sku ~ '^ART-[0-9]+$'`,
    { replacements: { companyId }, type: QueryTypes.SELECT, transaction },
  );
  return Number(row?.last ?? 0);
}

export async function importProducts(
  access: CompanyAccess,
  file: UploadedFile,
  options: ImportProductsOptions,
  actor: AuditActor,
) {
  const table = await readFile(file);

  const columnOf: Partial<Record<ImportField, number>> = {};
  for (const [field, column] of Object.entries(options.mapping) as [ImportField, string | undefined][]) {
    if (column === undefined) continue;
    const index = table.headers.indexOf(column);
    if (index === -1) {
      throw AppError.badRequest(`Colonne « ${column} » absente du fichier (champ ${FIELD_LABELS[field]})`);
    }
    columnOf[field] = index;
  }
  const valueOf = (cells: string[], field: ImportField) => {
    const index = columnOf[field];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };

  try {
    return await sequelize.transaction(async (transaction) => {
      const companyId = access.companyId;
      const units = await Unit.findAll({ where: { companyId, archivedAt: null }, transaction });
      const categories = await Category.findAll({ where: { companyId, archivedAt: null }, transaction });

      const defaultUnit = options.defaultUnitId ? units.find((unit) => unit.id === options.defaultUnitId) : undefined;
      if (options.defaultUnitId && !defaultUnit) {
        throw AppError.badRequest("Unité par défaut inconnue ou archivée");
      }
      const unitByName = new Map<string, Unit>();
      for (const unit of units) {
        unitByName.set(normalize(unit.name), unit);
        unitByName.set(normalize(unit.symbol), unit);
      }
      // Même nom à plusieurs niveaux : la catégorie racine l'emporte
      const categoryByName = new Map<string, string>();
      for (const category of [...categories].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId))) {
        if (!categoryByName.has(normalize(category.name))) categoryByName.set(normalize(category.name), category.id);
      }
      const newCategories = new Map<string, string>(); // clé normalisée → nom tel qu'écrit la première fois

      const decimals = currencyDecimals(access.currency);
      const planned: PlannedProduct[] = [];
      const results: ImportRowResult[] = [];
      const lineOfSku = new Map<string, number>();
      const lineOfBarcode = new Map<string, number>();

      for (const { line, cells } of table.rows) {
        const name = valueOf(cells, "name");
        const rawSku = valueOf(cells, "sku");
        const row: ImportRowResult = { line, status: "create", name, sku: null };
        results.push(row);

        // Ligne de total, de sous-titre… : pas un produit
        if (!name || /^(sous[- ]?)?(total|totaux)\b/i.test(name)) {
          row.status = "skipped";
          row.messages = ["Pas de nom de produit : ligne ignorée (total, titre…)"];
          continue;
        }
        const messages: string[] = [];

        if (name.length < 2 || name.length > 150) {
          messages.push("Nom : 2 à 150 caractères");
        }

        if (rawSku) {
          const sku = skuSchema.safeParse(rawSku.replace(/[\s/\\]+/g, "-"));
          if (sku.success) {
            row.sku = sku.data;
            const previous = lineOfSku.get(sku.data);
            if (previous) messages.push(`SKU ${sku.data} déjà présent ligne ${previous}`);
            else lineOfSku.set(sku.data, line);
          } else {
            messages.push(`SKU « ${rawSku} » invalide (lettres, chiffres, . _ -)`);
          }
        }

        let barcode: string | null = null;
        const rawBarcode = valueOf(cells, "barcode").replace(/\s/g, "");
        if (rawBarcode) {
          const parsed = barcodeSchema.safeParse(rawBarcode);
          if (parsed.success) {
            barcode = parsed.data;
            const previous = lineOfBarcode.get(barcode);
            if (previous) messages.push(`Code-barres ${barcode} déjà présent ligne ${previous}`);
            else lineOfBarcode.set(barcode, line);
          } else {
            messages.push(`Code-barres « ${rawBarcode} » invalide`);
          }
        }

        const rawUnit = valueOf(cells, "unit");
        const unitKey = normalize(rawUnit);
        const unit = rawUnit ? (unitByName.get(unitKey) ?? unitByName.get(UNIT_ALIASES[unitKey] ?? "")) : defaultUnit;
        if (!unit) {
          messages.push(
            rawUnit ? `Unité « ${rawUnit} » inconnue : créez-la d'abord ou corrigez le fichier` : "Unité manquante (choisissez une unité par défaut)",
          );
        }

        const amount = (field: "salePrice" | "purchasePrice", required: boolean): string | null => {
          const raw = valueOf(cells, field);
          if (!raw) {
            if (required) messages.push(`${FIELD_LABELS[field]} manquant`);
            return null;
          }
          const value = parseDecimal(amountSchema, raw);
          if (value === null) {
            messages.push(`${FIELD_LABELS[field]} « ${raw} » invalide`);
          } else if (significantDecimals(value) > decimals) {
            messages.push(`${FIELD_LABELS[field]} : pas de décimales en ${access.currency}`);
          }
          return value;
        };
        const salePrice = amount("salePrice", true);
        const purchasePriceHint = amount("purchasePrice", false);

        let alertThreshold = "0";
        const rawThreshold = valueOf(cells, "alertThreshold");
        if (rawThreshold) {
          const value = parseDecimal(quantitySchema, rawThreshold);
          if (value === null) messages.push(`Seuil d'alerte « ${rawThreshold} » invalide`);
          else if (unit && !unit.allowsDecimal && !isWhole(value)) messages.push(`Seuil d'alerte : nombre entier attendu (${unit.name})`);
          else alertThreshold = value;
        }

        let categoryKey: string | null = null;
        const rawCategory = valueOf(cells, "category");
        if (rawCategory) {
          categoryKey = normalize(rawCategory);
          if (!categoryKey || rawCategory.length > 80) {
            messages.push(`Catégorie « ${rawCategory} » invalide (80 caractères max)`);
          } else if (!categoryByName.has(categoryKey)) {
            if (options.createCategories) {
              if (!newCategories.has(categoryKey)) newCategories.set(categoryKey, rawCategory);
            } else {
              messages.push(`Catégorie « ${rawCategory} » inconnue`);
            }
          }
        }

        const description = valueOf(cells, "description") || null;
        if (description && description.length > 2000) {
          messages.push("Description : 2000 caractères max");
        }

        if (messages.length > 0) {
          row.status = "error";
          row.messages = messages;
          continue;
        }
        planned.push({
          row,
          barcode,
          description,
          categoryKey,
          unitId: unit!.id,
          salePrice: salePrice!,
          purchasePriceHint,
          alertThreshold,
        });
      }

      // Produits déjà connus (même SKU ou même code-barres, archivés compris) : laissés tels quels
      const skus = planned.map((item) => item.row.sku).filter((sku): sku is string => !!sku);
      const barcodes = planned.map((item) => item.barcode).filter((barcode): barcode is string => !!barcode);
      // [""] : IN () vide est invalide en SQL, et aucun SKU ni code-barres n'est vide
      const existing = await sequelize.query<{ sku: string; barcode: string | null }>(
        `SELECT sku, barcode FROM products
         WHERE company_id = :companyId AND (sku IN (:skus) OR barcode IN (:barcodes))`,
        {
          replacements: { companyId, skus: skus.length ? skus : [""], barcodes: barcodes.length ? barcodes : [""] },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      const knownSkus = new Set(existing.map((product) => product.sku));
      const knownBarcodes = new Set(existing.map((product) => product.barcode).filter(Boolean));

      let nextNumber = await lastGeneratedSku(companyId, transaction);
      const toCreate = planned.filter((item) => {
        if ((item.row.sku && knownSkus.has(item.row.sku)) || (item.barcode && knownBarcodes.has(item.barcode))) {
          item.row.status = "existing";
          item.row.messages = ["Produit déjà enregistré (même SKU ou code-barres) : non modifié"];
          return false;
        }
        if (!item.row.sku) {
          let sku: string;
          do {
            nextNumber++;
            sku = `ART-${String(nextNumber).padStart(6, "0")}`;
          } while (lineOfSku.has(sku));
          item.row.sku = sku;
          item.row.generatedSku = true;
        }
        return true;
      });

      const count = (status: ImportRowStatus) => results.filter((row) => row.status === status).length;
      const report = {
        dryRun: options.dryRun,
        filename: file.originalname,
        totalRows: results.length,
        toCreate: count("create"),
        existing: count("existing"),
        skipped: count("skipped"),
        errors: count("error"),
        categoriesToCreate: [...newCategories.values()],
        rows: results,
      };

      if (report.errors > 0 && !options.dryRun) {
        throw AppError.badRequest(`${report.errors} ligne(s) en erreur : rien n'a été importé`, report);
      }
      if (options.dryRun || toCreate.length === 0) {
        return report;
      }

      // --- Écriture : catégories manquantes, puis produits, puis une ligne d'audit récapitulative
      const usedCategories = new Set(toCreate.map((item) => item.categoryKey).filter(Boolean));
      const createdCategories: string[] = [];
      for (const [key, categoryName] of newCategories) {
        if (!usedCategories.has(key)) continue;
        const category = await Category.create({ companyId, name: categoryName, parentId: null }, { transaction });
        categoryByName.set(key, category.id);
        createdCategories.push(categoryName);
        await recordAudit(
          {
            ...actor,
            companyId,
            action: "category.create",
            entityType: "category",
            entityId: category.id,
            after: { name: categoryName, parentId: null, source: "import" },
          },
          transaction,
        );
      }

      await Product.bulkCreate(
        toCreate.map((item) => ({
          companyId,
          sku: item.row.sku!,
          barcode: item.barcode,
          name: item.row.name,
          description: item.description,
          categoryId: item.categoryKey ? categoryByName.get(item.categoryKey)! : null,
          unitId: item.unitId,
          salePrice: item.salePrice,
          purchasePriceHint: item.purchasePriceHint,
          alertThreshold: item.alertThreshold,
        })),
        { transaction },
      );
      await recordAudit(
        {
          ...actor,
          companyId,
          action: "product.import",
          entityType: "product",
          after: {
            filename: file.originalname,
            created: toCreate.length,
            existing: report.existing,
            skipped: report.skipped,
            categoriesCreated: createdCategories,
          },
        },
        transaction,
      );

      return { ...report, categoriesToCreate: createdCategories };
    });
  } catch (error) {
    rethrowAsConflict(
      error,
      {
        products_company_sku_key: "Un SKU du fichier vient d'être utilisé par un autre produit : relancez l'aperçu",
        products_company_barcode_key: "Un code-barres du fichier vient d'être utilisé par un autre produit : relancez l'aperçu",
        categories_company_parent_name_key: "Une catégorie du fichier vient d'être créée : relancez l'aperçu",
      },
      "Le catalogue a changé pendant l'import : relancez l'aperçu",
    );
  }
}

// --- Modèle vierge

/** Fichier Excel prêt à remplir : les intitulés sont reconnus tels quels par l'analyse. */
export async function importTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockPro";
  const sheet = workbook.addWorksheet("Produits");
  sheet.columns = IMPORT_FIELDS.map((field) => ({ header: FIELD_LABELS[field], key: field, width: field === "name" ? 32 : 16 }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({
    name: "Riz parfumé 25 kg",
    sku: "RIZ-25KG",
    barcode: "6111234567890",
    category: "Alimentation",
    unit: "pce",
    salePrice: 15000,
    purchasePrice: 13500,
    alertThreshold: 5,
    description: "",
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
