import { z } from "zod";
import {
  INVOICE_STATUSES,
  ORDER_STATUSES,
  RECEIPT_STATUSES,
  SUPPLIER_PAYMENT_METHODS,
} from "../../models/purchases.models.js";
import { amountSchema, quantitySchema } from "../../utils/decimal.js";
import { paginationSchema } from "../../utils/query.js";

const positiveQuantity = quantitySchema.refine((value) => !/^0+(\.0+)?$/.test(value), "La quantité doit être positive");
const positiveAmount = amountSchema.refine((value) => !/^0+(\.0+)?$/.test(value), "Le montant doit être positif");
const notes = z.string().trim().max(2000).nullable().optional();
const isoDate = z.iso.date("Date attendue au format AAAA-MM-JJ");

function uniqueProducts<T extends { productId: string }>(lines: T[]) {
  return new Set(lines.map((line) => line.productId)).size === lines.length;
}

const pricedLines = z
  .array(z.object({ productId: z.uuid(), quantity: positiveQuantity, unitCost: amountSchema }))
  .min(1)
  .max(500)
  .refine(uniqueProducts, "Un produit apparaît plusieurs fois");

// --- Bons de commande
export const createOrderSchema = z.object({
  shopId: z.uuid(),
  supplierId: z.uuid(),
  expectedAt: isoDate.nullable().optional(),
  notes,
  lines: pricedLines,
});

export const updateOrderSchema = z
  .object({ expectedAt: isoDate.nullable().optional(), notes, lines: pricedLines.optional() })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

export const listOrdersQuerySchema = paginationSchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  shopId: z.uuid().optional(),
});

// --- Réceptions
export const createReceiptSchema = z.object({
  shopId: z.uuid(),
  supplierId: z.uuid(),
  orderId: z.uuid().optional(),
  supplierReference: z.string().trim().max(60).nullable().optional(),
  notes,
  // Facultatif quand la réception suit une commande : on reprend alors tout le reste à recevoir
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: positiveQuantity,
        unitCost: amountSchema,
        orderLineId: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine(uniqueProducts, "Un produit apparaît plusieurs fois")
    .optional(),
});

export const listReceiptsQuerySchema = paginationSchema.extend({
  status: z.enum(RECEIPT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  shopId: z.uuid().optional(),
});

// --- Retours fournisseurs
export const createReturnSchema = z.object({
  shopId: z.uuid(),
  supplierId: z.uuid(),
  receiptId: z.uuid().optional(),
  reason: z.string().trim().min(3).max(255),
  notes,
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: positiveQuantity,
        // Valeur unitaire du retour ; sinon le coût moyen du stock au moment de la validation
        unitCost: amountSchema.optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine(uniqueProducts, "Un produit apparaît plusieurs fois"),
});

export const listReturnsQuerySchema = paginationSchema.extend({
  status: z.enum(RECEIPT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  shopId: z.uuid().optional(),
});

// --- Factures et paiements fournisseurs
export const createInvoiceSchema = z
  .object({
    supplierId: z.uuid(),
    receiptId: z.uuid().optional(),
    reference: z.string().trim().min(1).max(60),
    invoiceDate: isoDate,
    dueDate: isoDate.nullable().optional(),
    total: positiveAmount,
    notes,
  })
  .refine((value) => !value.dueDate || value.dueDate >= value.invoiceDate, "L'échéance précède la date de facture");

export const createSupplierPaymentSchema = z.object({
  amount: positiveAmount,
  method: z.enum(SUPPLIER_PAYMENT_METHODS),
  paidAt: isoDate.optional(),
  reference: z.string().trim().max(60).nullable().optional(),
  notes,
});

export const listInvoicesQuerySchema = paginationSchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  // true : uniquement les factures échues et non soldées
  overdue: z.stringbool().default(false),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;
export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type ListReturnsQuery = z.infer<typeof listReturnsQuerySchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type CreateSupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
