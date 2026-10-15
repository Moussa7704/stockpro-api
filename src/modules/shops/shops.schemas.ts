import { z } from "zod";

// Court, en majuscules : sert dans les numéros de documents (BTQ1-T-2026-000123)
const shopCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, "2 à 10 lettres majuscules ou chiffres");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional();

export const createShopSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: shopCode,
  address: optionalText(255),
  phone: optionalText(30),
});

export const updateShopSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    code: shopCode.optional(),
    address: optionalText(255),
    phone: optionalText(30),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

export const listShopsQuerySchema = z.object({
  includeArchived: z.stringbool().default(false),
});

export type CreateShopInput = z.infer<typeof createShopSchema>;
export type UpdateShopInput = z.infer<typeof updateShopSchema>;
