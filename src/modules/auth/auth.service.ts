import { UniqueConstraintError } from "sequelize";
import { User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { RegisterInput } from "./auth.schemas.js";

export async function register(input: RegisterInput): Promise<User> {
  try {
    // Le hash du mot de passe est fait par le hook beforeSave du modèle
    return await User.create(input);
  } catch (error) {
    // L'index unique sur email garantit qu'il n'y a pas de doublon, même avec deux requêtes simultanées
    if (error instanceof UniqueConstraintError) {
      throw AppError.conflict("Un compte existe déjà avec cet email");
    }
    throw error;
  }
}
