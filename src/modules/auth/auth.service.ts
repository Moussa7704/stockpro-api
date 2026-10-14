import { UniqueConstraintError } from "sequelize";
import { User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { signAccessToken } from "../../utils/jwt.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";

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

export async function login(input: LoginInput): Promise<{ user: User; accessToken: string }> {
  const user = await User.findOne({ where: { email: input.email } });

  // Même message si l'email est inconnu ou si le mot de passe est faux
  if (!user || !(await user.comparePassword(input.password))) {
    throw AppError.unauthorized("Email ou mot de passe incorrect");
  }

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  return { user, accessToken };
}

export async function getMe(userId: string): Promise<User> {
  const user = await User.findByPk(userId);

  // Le token peut être encore valide alors que le compte a été supprimé
  if (!user) {
    throw AppError.unauthorized("Utilisateur introuvable");
  }

  return user;
}
