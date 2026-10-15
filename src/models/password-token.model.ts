import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

export const PASSWORD_TOKEN_PURPOSES = ["invite", "reset"] as const;
export type PasswordTokenPurpose = (typeof PASSWORD_TOKEN_PURPOSES)[number];

/**
 * Jeton à usage unique envoyé par email dans un lien pour définir un mot de passe :
 * - invite : compte créé par un admin, l'utilisateur choisit son premier mot de passe
 * - reset : mot de passe oublié
 * Seule l'empreinte HMAC du jeton est stockée.
 */
export class PasswordToken extends Model<
  InferAttributes<PasswordToken>,
  InferCreationAttributes<PasswordToken>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare purpose: PasswordTokenPurpose;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare usedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PasswordToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    purpose: {
      type: DataTypes.ENUM(...PASSWORD_TOKEN_PURPOSES),
      allowNull: false,
    },
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    usedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: "password_tokens",
  },
);
