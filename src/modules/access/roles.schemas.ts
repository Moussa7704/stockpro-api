import { z } from "zod";
import { PERMISSIONS } from "./permissions.js";

// Permissions cochées, sans doublons
const permissions = z
  .array(z.enum(PERMISSIONS, "Permission inconnue"))
  .max(PERMISSIONS.length)
  .transform((list) => [...new Set(list)]);

const description = z
  .string()
  .trim()
  .max(255)
  .transform((value) => value || null)
  .nullable()
  .optional();

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description,
  permissions: permissions.refine((list) => list.length > 0, "Cochez au moins une permission"),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description,
    permissions: permissions.refine((list) => list.length > 0, "Cochez au moins une permission").optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
