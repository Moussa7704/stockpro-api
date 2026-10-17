import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/** Pourquoi une ligne a été fermée : seul un jeton « rotated » qui revient trahit un vol. */
export const REVOKE_REASONS = ["rotated", "logout", "revoked", "password_change", "reuse"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/**
 * Une ligne = un jeton de session. Chaque renouvellement remplace la ligne (rotation) en gardant
 * le même sessionId : une session (un appareil connecté) = la ligne active d'un sessionId.
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
  declare revokeReason: CreationOptional<RevokeReason | null>;
  // Identifiant stable de l'appareil, conservé à chaque renouvellement
  declare sessionId: CreationOptional<string>;
  declare sessionStartedAt: CreationOptional<Date>;
  declare userAgent: CreationOptional<string | null>;
  declare ipAddress: CreationOptional<string | null>;
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
    revokeReason: { type: DataTypes.ENUM(...REVOKE_REASONS), allowNull: true },
    // Par défaut : une nouvelle session (un renouvellement passe ceux de la session d'origine)
    sessionId: { type: DataTypes.UUID, allowNull: false, defaultValue: DataTypes.UUIDV4 },
    sessionStartedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: "refresh_tokens",
    indexes: [{ fields: ["user_id"] }, { fields: ["session_id"] }],
  },
);
