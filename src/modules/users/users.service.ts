import { UniqueConstraintError } from "sequelize";
import { sequelize } from "../../config/database.js";
import { User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import * as passwordService from "../auth/password.service.js";
import type { CreateUserInput, UpdateUserInput } from "./users.schemas.js";

async function findUserOrFail(id: string): Promise<User> {
  const user = await User.findByPk(id);
  if (!user) {
    throw AppError.notFound("Utilisateur introuvable");
  }
  return user;
}

async function actorName(actorId: string): Promise<string> {
  const actor = await User.findByPk(actorId, { attributes: ["name"] });
  return actor?.name ?? "Un administrateur";
}

export async function listUsers(): Promise<User[]> {
  return User.findAll({ order: [["createdAt", "DESC"]] });
}

/** Crée un compte sans mot de passe et envoie l'invitation par email. */
export async function createUser(input: CreateUserInput, actorId: string): Promise<User> {
  const invitedBy = await actorName(actorId);

  try {
    // Transaction : si l'email d'invitation ne part pas, le compte n'est pas créé
    return await sequelize.transaction(async (transaction) => {
      const user = await User.create(input, { transaction });
      await passwordService.sendInvitation(user, invitedBy, transaction);
      return user;
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw AppError.conflict("Un compte existe déjà avec cet email");
    }
    throw error;
  }
}

export async function updateUser(id: string, input: UpdateUserInput, actorId: string): Promise<User> {
  // Un admin ne peut pas changer son propre rôle : il reste toujours au moins un admin
  if (id === actorId) {
    throw AppError.badRequest("Vous ne pouvez pas modifier votre propre rôle");
  }

  const user = await findUserOrFail(id);
  await user.update({ role: input.role });
  return user;
}

/** Renvoie l'invitation (lien expiré, email perdu…). L'ancien lien ne fonctionne plus. */
export async function resendInvitation(id: string, actorId: string): Promise<void> {
  const user = await findUserOrFail(id);
  if (user.password !== null) {
    throw AppError.conflict("Ce compte est déjà activé");
  }

  await passwordService.sendInvitation(user, await actorName(actorId));
}
