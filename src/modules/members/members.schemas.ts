import { z } from "zod";
import { MEMBERSHIP_STATUSES } from "../../models/membership.model.js";
import { PERMISSIONS } from "../access/permissions.js";
import { emailSchema, nameSchema } from "../auth/auth.schemas.js";

const roleCode = z.string().trim().min(1).max(40);
// Sans doublons : [a, a] devient [a]
const shopIds = z
  .array(z.uuid("Identifiant de boutique invalide"))
  .max(200)
  .transform((ids) => [...new Set(ids)]);

export const inviteMemberSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  roleCode,
  // Facultatif : sinon la valeur par défaut du rôle (propriétaire et comptable voient tout)
  allShops: z.boolean().optional(),
  shopIds: shopIds.default([]),
});

export const updateMemberSchema = z
  .object({
    roleCode: roleCode.optional(),
    allShops: z.boolean().optional(),
    shopIds: shopIds.optional(),
    status: z.enum(MEMBERSHIP_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Aucune modification");

// Liste de permissions sans doublons
const permissionList = z
  .array(z.enum(PERMISSIONS, "Permission inconnue"))
  .max(PERMISSIONS.length)
  .transform((permissions) => [...new Set(permissions)]);

/** Ajustements d'un membre par rapport à son rôle : remplace les précédents (listes vides = rôle seul). */
export const setMemberPermissionsSchema = z
  .object({ grants: permissionList.default([]), revokes: permissionList.default([]) })
  .refine((value) => !value.grants.some((permission) => value.revokes.includes(permission)), {
    message: "Une permission ne peut pas être à la fois ajoutée et retirée",
    path: ["revokes"],
  });

export type SetMemberPermissionsInput = z.infer<typeof setMemberPermissionsSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
