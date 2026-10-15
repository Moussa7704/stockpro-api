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

const fields = {
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{6,20}$/, "Téléphone invalide")
    // On stocke sans espaces : "+221 77 000 00 00" et "+221770000000" sont le même client
    .transform((value) => value.replace(/\s/g, ""))
    .nullable()
    .optional(),
  email: z.email().trim().toLowerCase().nullable().optional().or(z.literal("").transform(() => null)),
  address: optionalText(255),
  notes: optionalText(2000),
  // null : aucun crédit autorisé ; sinon dette maximale du client
  creditLimit: amountSchema.nullable().optional(),
};

export const createCustomerSchema = z.object({ name: z.string().trim().min(2).max(150), ...fields });

export const updateCustomerSchema = z
  .object({ name: z.string().trim().min(2).max(150).optional(), ...fields, archived: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

export const listCustomersQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  // true : uniquement les clients qui doivent de l'argent
  withDebt: z.stringbool().default(false),
  includeArchived: z.stringbool().default(false),
});

// --- Règlements de dette
export const createCustomerPaymentSchema = z.object({
  shopId: z.uuid(),
  paymentMethodId: z.uuid(),
  amount: amountSchema.refine((value) => !/^0+(\.0+)?$/.test(value), "Le montant doit être positif"),
  reference: optionalText(60),
  notes: optionalText(2000),
});

// --- Relevé et impayés
const dateSchema = z.iso.date("Date invalide (AAAA-MM-JJ)");

export const statementQuerySchema = z
  .object({ from: dateSchema, to: dateSchema })
  .refine((value) => value.from <= value.to, { message: "La date de début doit précéder la date de fin", path: ["to"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 366, {
    message: "Période limitée à un an",
    path: ["from"],
  });

export const debtorsQuerySchema = paginationSchema.extend({
  // Ignorer les petites dettes (ex. reliquats de quelques francs)
  minAmount: amountSchema.optional(),
});

export type CreateCustomerPaymentInput = z.infer<typeof createCustomerPaymentSchema>;
export type StatementQuery = z.infer<typeof statementQuerySchema>;
export type DebtorsQuery = z.infer<typeof debtorsQuerySchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
