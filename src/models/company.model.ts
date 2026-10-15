import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

export const COMPANY_STATUSES = ["active", "suspended"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** Paramètres libres de l'entreprise (ex. plafond de remise des caissiers). */
export interface CompanySettings {
  maxCashierDiscountPercent?: number;
}

/** Commerçant abonné (tenant) : toutes les données métier lui sont rattachées par company_id. */
export class Company extends Model<InferAttributes<Company>, InferCreationAttributes<Company>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare slug: string;
  declare currency: CreationOptional<string>;
  declare timezone: CreationOptional<string>;
  declare status: CreationOptional<CompanyStatus>;
  declare settings: CreationOptional<CompanySettings>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Company.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    slug: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "XOF" },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Africa/Abidjan" },
    status: {
      type: DataTypes.ENUM(...COMPANY_STATUSES),
      allowNull: false,
      defaultValue: "active",
    },
    settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "companies" },
);
