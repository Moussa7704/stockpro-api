import { z } from "zod";
import { PRODUCT_STATUSES } from "../../models/catalog.models.js";
import { amountSchema, quantitySchema } from "../../utils/decimal.js";
import { paginationSchema } from "../../utils/query.js";

// Texte facultatif : "" devient null (le champ est vidé)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional();

const nonEmptyUpdate = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine((value) => Object.keys(value).length > 0, "Aucune modification");

// --- Unités
export const createUnitSchema = z.object({
  name: z.string().trim().min(1).max(40),
  symbol: z.string().trim().min(1).max(10),
  allowsDecimal: z.boolean().default(false),
});

export const updateUnitSchema = nonEmptyUpdate({
  name: z.string().trim().min(1).max(40).optional(),
  symbol: z.string().trim().min(1).max(10).optional(),
  // allowsDecimal n'est pas modifiable : des stocks à 2,5 deviendraient invalides
  archived: z.boolean().optional(),
});

// --- Catégories
export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.uuid().nullable().optional(),
});

export const updateCategorySchema = nonEmptyUpdate({
  name: z.string().trim().min(1).max(80).optional(),
  parentId: z.uuid().nullable().optional(),
  archived: z.boolean().optional(),
});

// --- Fournisseurs
const supplierFields = {
  contactName: optionalText(100),
  phone: optionalText(30),
  email: z.email().trim().toLowerCase().nullable().optional().or(z.literal("").transform(() => null)),
  address: optionalText(255),
  notes: optionalText(2000),
};

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2).max(150),
  ...supplierFields,
});

export const updateSupplierSchema = nonEmptyUpdate({
  name: z.string().trim().min(2).max(150).optional(),
  ...supplierFields,
  archived: z.boolean().optional(),
});

export const listSuppliersQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  includeArchived: z.stringbool().default(false),
});

// --- Produits
// SKU et code-barres : sans espaces, SKU en majuscules (comparaison sans ambiguïté)
const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/, "SKU : lettres, chiffres, . _ - (64 max)");
const barcodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z-]{4,64}$/, "Code-barres invalide");

export const createProductSchema = z.object({
  sku: skuSchema,
  barcode: barcodeSchema.nullable().optional(),
  name: z.string().trim().min(2).max(150),
  description: optionalText(2000),
  categoryId: z.uuid().nullable().optional(),
  unitId: z.uuid(),
  salePrice: amountSchema,
  purchasePriceHint: amountSchema.nullable().optional(),
  alertThreshold: quantitySchema.default("0"),
});

export const updateProductSchema = nonEmptyUpdate({
  sku: skuSchema.optional(),
  barcode: barcodeSchema.nullable().optional(),
  name: z.string().trim().min(2).max(150).optional(),
  description: optionalText(2000),
  categoryId: z.uuid().nullable().optional(),
  unitId: z.uuid().optional(),
  salePrice: amountSchema.optional(),
  purchasePriceHint: amountSchema.nullable().optional(),
  alertThreshold: quantitySchema.optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
});

export const PRODUCT_SORT_FIELDS = ["name", "sku", "salePrice", "createdAt"] as const;

export const listProductsQuerySchema = paginationSchema.extend({
  // Cherche dans le nom, le SKU et le code-barres
  search: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  status: z.enum([...PRODUCT_STATUSES, "all"]).default("active"),
  sort: z.enum(PRODUCT_SORT_FIELDS).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

// Recherche rapide en caisse : scan d'un code-barres ou saisie d'un SKU
export const lookupProductQuerySchema = z
  .object({ barcode: z.string().trim().min(1).optional(), sku: z.string().trim().min(1).optional() })
  .refine((value) => !!value.barcode !== !!value.sku, "Indiquez barcode OU sku");

export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
