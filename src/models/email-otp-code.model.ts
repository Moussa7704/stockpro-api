import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/**
 * Code OTP envoyé par email lors d'une connexion (une ligne = une tentative de connexion).
 * - challengeId : identifiant du challengeToken renvoyé au client, le code n'est valable que pour lui
 * - codeHash : empreinte HMAC du code, jamais le code en clair
 * - attempts / resendCount : limites d'essais et de renvois, stockées en base
 */
export class EmailOtpCode extends Model<
  InferAttributes<EmailOtpCode>,
  InferCreationAttributes<EmailOtpCode>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare challengeId: string;
  declare codeHash: string;
  declare expiresAt: Date;
  declare attempts: CreationOptional<number>;
  declare resendCount: CreationOptional<number>;
  declare lastSentAt: Date;
  declare consumedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

EmailOtpCode.init(
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
    challengeId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
    },
    codeHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    resendCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastSentAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    consumedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: "email_otp_codes",
  },
);
