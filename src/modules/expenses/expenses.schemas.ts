import { z } from "zod";
import { amountSchema } from "../../utils/decimal.js";
import { paginationSchema } from "../../utils/query.js";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional();
const dateSchema = z.iso.date("Date invalide (AAAA-MM-JJ)");

// --- Catégories
export const createExpenseCategorySchema = z.object({ name: z.string().trim().min(2).max(80) });

export const updateExpenseCategorySchema = z
  .object({ name: z.string().trim().min(2).max(80).optional(), archived: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

// --- Dépenses
export const createExpenseSchema = z.object({
  shopId: z.uuid(),
  categoryId: z.uuid(),
  amount: amountSchema.refine((value) => !/^0+(\.0+)?$/.test(value), "Le montant doit être positif"),
  description: z.string().trim().min(2).max(255),
  // Jour de la dépense (par défaut : aujourd'hui dans le fuseau de l'entreprise)
  spentAt: dateSchema.optional(),
  paymentMethodId: z.uuid(),
  // Session de caisse ouverte de la boutique dont le tiroir paie la dépense (espèces uniquement)
  cashSessionId: z.uuid().nullable().optional(),
  supplierId: z.uuid().nullable().optional(),
  reference: optionalText(60),
});

export const cancelExpenseSchema = z.object({ reason: z.string().trim().min(3).max(255) });

export const listExpensesQuerySchema = paginationSchema.extend({
  shopId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  status: z.enum(["recorded", "cancelled"]).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
