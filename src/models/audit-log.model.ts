import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/**
 * Journal des opérations sensibles (RB-07), en ajout seul : jamais modifié ni supprimé.
 * company_id null = action au niveau de la plateforme (administrateur SaaS).
 */
export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<string>;
  declare companyId: CreationOptional<string | null>;
  declare shopId: CreationOptional<string | null>;
  declare actorUserId: CreationOptional<string | null>;
  declare action: string;
  declare entityType: CreationOptional<string | null>;
  declare entityId: CreationOptional<string | null>;
  declare before: CreationOptional<Record<string, unknown> | null>;
  declare after: CreationOptional<Record<string, unknown> | null>;
  declare ip: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

AuditLog.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: true },
    shopId: { type: DataTypes.UUID, allowNull: true },
    actorUserId: { type: DataTypes.UUID, allowNull: true },
    action: { type: DataTypes.STRING(80), allowNull: false },
    entityType: { type: DataTypes.STRING(60), allowNull: true },
    entityId: { type: DataTypes.STRING(64), allowNull: true },
    before: { type: DataTypes.JSONB, allowNull: true },
    after: { type: DataTypes.JSONB, allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "audit_logs", updatedAt: false },
);
