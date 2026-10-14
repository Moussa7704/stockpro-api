import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/**
 * Configuration TOTP d'un utilisateur (au plus une ligne par utilisateur).
 * - enabledAt = null : setup commencé mais pas encore confirmé par un premier code
 * - secretEncrypted : secret TOTP chiffré (AES-256-GCM), jamais stocké en clair
 * - lastUsedStep : dernière fenêtre de 30 s utilisée, pour refuser un code déjà utilisé (anti-rejeu)
 */
export class UserTwoFactor extends Model<
  InferAttributes<UserTwoFactor>,
  InferCreationAttributes<UserTwoFactor>
> {
  declare userId: string;
  declare secretEncrypted: string;
  declare enabledAt: CreationOptional<Date | null>;
  declare lastUsedStep: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

UserTwoFactor.init(
  {
    userId: {
      type: DataTypes.UUID,
      primaryKey: true,
    },
    secretEncrypted: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    enabledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastUsedStep: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: "user_two_factor",
  },
);
