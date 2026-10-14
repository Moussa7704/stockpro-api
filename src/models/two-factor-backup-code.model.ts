import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/**
 * Code de secours 2FA, utilisable une seule fois (si le téléphone est perdu).
 * Seule son empreinte HMAC est stockée, comme pour les refresh tokens.
 */
export class TwoFactorBackupCode extends Model<
  InferAttributes<TwoFactorBackupCode>,
  InferCreationAttributes<TwoFactorBackupCode>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare codeHash: string;
  declare usedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

TwoFactorBackupCode.init(
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
    codeHash: {
      type: DataTypes.STRING(64),
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
    tableName: "two_factor_backup_codes",
    indexes: [{ fields: ["user_id", "code_hash"] }],
  },
);
