import { z } from "zod";
import { PAYMENT_METHOD_TYPES } from "../../models/pos.models.js";
import { amountSchema, quantitySchema } from "../../utils/decimal.js";
import { paginationSchema } from "../../utils/query.js";

const positiveQuantity = quantitySchema.refine((value) => !/^0+(\.0+)?$/.test(value), "La quantité doit être positive");
const positiveAmount = amountSchema.refine((value) => !/^0+(\.0+)?$/.test(value), "Le montant doit être positif");

// Remise : montant (ex. 500 FCFA) ou pourcentage (ex. 10 %)
const discountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("amount"), value: amountSchema }),
  z.object({
    type: z.literal("percent"),
    value: amountSchema.refine((value) => Number(value) <= 100, "Pourcentage entre 0 et 100"),
  }),
]);

// --- Moyens de paiement
export const createPaymentMethodSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,30}$/, "Code : lettres minuscules, chiffres et _"),
  name: z.string().trim().min(2).max(60),
  type: z.enum(PAYMENT_METHOD_TYPES),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const updatePaymentMethodSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

// --- Sessions de caisse
export const openSessionSchema = z.object({
  shopId: z.uuid(),
  openingFloat: amountSchema,
});

export const closeSessionSchema = z.object({
  countedCash: amountSchema,
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const listSessionsQuerySchema = paginationSchema.extend({
  shopId: z.uuid().optional(),
  status: z.enum(["open", "closed"]).optional(),
});

// --- Ventes
export const createSaleSchema = z.object({
  shopId: z.uuid(),
  customerId: z.uuid().nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: positiveQuantity,
        // Prix différent du prix catalogue : permission sales.price_override
        unitPrice: amountSchema.optional(),
        discount: discountSchema.optional(),
      }),
    )
    .min(1)
    .max(300)
    .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length, "Un produit apparaît plusieurs fois"),
  // Remise sur l'ensemble du ticket, répartie sur les lignes
  discount: discountSchema.optional(),
  // Vide : vente entièrement à crédit (client obligatoire)
  payments: z
    .array(z.object({ methodId: z.uuid(), amount: positiveAmount, reference: z.string().trim().max(60).optional() }))
    .max(10)
    .default([]),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3).max(255),
});

export const listSalesQuerySchema = paginationSchema.extend({
  shopId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  status: z.enum(["completed", "cancelled"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// --- Retours clients
export const createSaleReturnSchema = z
  .object({
    saleId: z.uuid(),
    reason: z.string().trim().min(3).max(255),
    lines: z
      .array(z.object({ saleLineId: z.uuid(), quantity: positiveQuantity, restock: z.boolean().default(true) }))
      .min(1)
      .max(300)
      .refine((lines) => new Set(lines.map((line) => line.saleLineId)).size === lines.length, "Une ligne apparaît plusieurs fois"),
    refundTo: z.enum(["method", "customer_account"]),
    refundMethodId: z.uuid().optional(),
  })
  .refine((value) => value.refundTo !== "method" || !!value.refundMethodId, "Indiquez le moyen de remboursement");

export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;
export type OpenSessionInput = z.infer<typeof openSessionSchema>;
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;
export type CreateSaleReturnInput = z.infer<typeof createSaleReturnSchema>;
export type Discount = z.infer<typeof discountSchema>;
