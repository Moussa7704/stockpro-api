import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

/** Boutique ou magasin d'une entreprise : chacune a son propre stock (RB-02). */
export class Shop extends Model<InferAttributes<Shop>, InferCreationAttributes<Shop>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare name: string;
  // Court et unique dans l'entreprise : sert dans les numéros de documents (BTQ1-T-2026-000123)
  declare code: string;
  declare address: CreationOptional<string | null>;
  declare phone: CreationOptional<string | null>;
  // Archivée plutôt que supprimée (RB-11)
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Shop.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    code: { type: DataTypes.STRING(20), allowNull: false },
    address: { type: DataTypes.STRING(255), allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "shops" },
);
