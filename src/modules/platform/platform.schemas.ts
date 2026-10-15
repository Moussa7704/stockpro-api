import { z } from "zod";
import { COMPANY_STATUSES } from "../../models/company.model.js";
import { emailSchema, nameSchema } from "../auth/auth.schemas.js";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lettres minuscules, chiffres et tirets uniquement")
  .min(2)
  .max(60);

// Fuseau IANA reconnu par le moteur JavaScript (ex. Africa/Abidjan, Africa/Dakar)
export const timezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Fuseau horaire inconnu");

export const createCompanySchema = z.object({
  name: z.string().trim().min(2).max(150),
  // Facultatif : sinon généré à partir du nom
  slug: slugSchema.optional(),
  // Une seule devise en V1 (décision D-01)
  currency: z.literal("XOF").default("XOF"),
  timezone: timezoneSchema.default("Africa/Abidjan"),
  // Première boutique, créée avec l'entreprise
  shopName: z.string().trim().min(2).max(120).default("Boutique principale"),
  owner: z.object({
    name: nameSchema,
    email: emailSchema,
  }),
});

export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    status: z.enum(COMPANY_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
