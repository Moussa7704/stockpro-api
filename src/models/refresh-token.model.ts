import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/**
 * Une ligne = une session ouverte (un appareil connecté).
 * On ne stocke jamais le token lui-même, seulement son empreinte SHA-256 :
 * une fuite de la base ne permet pas de se connecter.
 */
export class RefreshToken extends Model<
  InferAttributes<RefreshToken>,
  InferCreationAttributes<RefreshToken>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  // Entreprise active de la session (null : aucune choisie, ou administrateur SaaS)
  declare companyId: CreationOptional<string | null>;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare revokedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

RefreshToken.init(
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
    companyId: {
      type: DataTypes.UUID,
      allowNull: true,
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
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: "refresh_tokens",
    indexes: [{ fields: ["user_id"] }],
  },
);
