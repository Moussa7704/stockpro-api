import { z } from "zod";
import { ADJUSTMENT_REASONS, MOVEMENT_TYPES, TRANSFER_STATUSES } from "../../models/stock.models.js";
import { amountSchema, quantitySchema } from "../../utils/decimal.js";
import { paginationSchema } from "../../utils/query.js";

// Quantité signée non nulle : "5" entrée, "-2.5" sortie
const signedQuantitySchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === "number" ? String(value) : value.trim().replace(",", ".")))
  .pipe(
    z
      .string()
      .regex(/^-?\d{1,11}(\.\d{1,3})?$/, "Quantité invalide (3 décimales max)")
      .refine((value) => !/^-?0+(\.0+)?$/.test(value), "La quantité ne peut pas être nulle"),
  );

const positiveQuantitySchema = quantitySchema.refine(
  (value) => !/^0+(\.0+)?$/.test(value),
  "La quantité doit être positive",
);

// Une même ligne de produit deux fois dans un document est refusée (source d'erreurs)
function uniqueProducts<T extends { productId: string }>(lines: T[]) {
  return new Set(lines.map((line) => line.productId)).size === lines.length;
}

const notes = z.string().trim().max(2000).nullable().optional();

// --- Consultation
export const listStockQuerySchema = paginationSchema.extend({
  shopId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
  // true : uniquement les produits sous leur seuil d'alerte
  lowStock: z.stringbool().default(false),
});

export const listMovementsQuerySchema = paginationSchema.extend({
  shopId: z.uuid().optional(),
  productId: z.uuid().optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// --- Ajustements
export const createAdjustmentSchema = z.object({
  shopId: z.uuid(),
  reason: z.enum(ADJUSTMENT_REASONS),
  notes,
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: signedQuantitySchema,
        // Coût unitaire d'une entrée (ex. stock d'ouverture) : met à jour le coût moyen
        unitCost: amountSchema.optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine(uniqueProducts, "Un produit apparaît plusieurs fois"),
});

// --- Transferts
export const createTransferSchema = z
  .object({
    fromShopId: z.uuid(),
    toShopId: z.uuid(),
    notes,
    lines: z
      .array(z.object({ productId: z.uuid(), quantity: positiveQuantitySchema }))
      .min(1)
      .max(500)
      .refine(uniqueProducts, "Un produit apparaît plusieurs fois"),
  })
  .refine((value) => value.fromShopId !== value.toShopId, "Les boutiques de départ et d'arrivée doivent différer");

export const receiveTransferSchema = z.object({
  // Facultatif : sans détail, tout ce qui a été expédié est considéré comme reçu
  lines: z
    .array(z.object({ lineId: z.uuid(), quantityReceived: quantitySchema }))
    .max(500)
    .optional(),
});

export const listTransfersQuerySchema = paginationSchema.extend({
  status: z.enum(TRANSFER_STATUSES).optional(),
  shopId: z.uuid().optional(),
});

// --- Inventaires
export const createInventorySchema = z.object({
  shopId: z.uuid(),
  notes,
});

export const setInventoryLinesSchema = z.object({
  lines: z
    .array(z.object({ productId: z.uuid(), countedQuantity: quantitySchema }))
    .min(1)
    .max(1000)
    .refine(uniqueProducts, "Un produit apparaît plusieurs fois"),
});

export const listDocumentsQuerySchema = paginationSchema.extend({
  shopId: z.uuid().optional(),
});

export type ListStockQuery = z.infer<typeof listStockQuerySchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type ReceiveTransferInput = z.infer<typeof receiveTransferSchema>;
export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>;
export type CreateInventoryInput = z.infer<typeof createInventorySchema>;
export type SetInventoryLinesInput = z.infer<typeof setInventoryLinesSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
