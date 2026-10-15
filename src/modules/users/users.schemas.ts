import { z } from "zod";
import { USER_ROLES } from "../../models/user.model.js";
import { emailSchema, nameSchema } from "../auth/auth.schemas.js";

const roleSchema = z.enum(USER_ROLES);

// L'admin ne choisit pas de mot de passe : l'utilisateur le définit via le lien d'invitation
export const createUserSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: roleSchema,
});

export const updateUserSchema = z.object({
  role: roleSchema,
});

export const userIdParamsSchema = z.object({
  id: z.uuid("Identifiant invalide"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
