import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../config/database.js";

/**
 * Catalogue de l'entreprise. Les montants (DECIMAL) sont renvoyés par PostgreSQL sous forme
 * de chaînes ("1500.00") : on les garde ainsi, sans jamais passer par un nombre flottant.
 */

// --- Unités de mesure
export class Unit extends Model<InferAttributes<Unit>, InferCreationAttributes<Unit>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare name: string;
  declare symbol: string;
  declare allowsDecimal: CreationOptional<boolean>;
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Unit.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(40), allowNull: false },
    symbol: { type: DataTypes.STRING(10), allowNull: false },
    allowsDecimal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "units" },
);

// --- Catégories (arborescence)
export class Category extends Model<InferAttributes<Category>, InferCreationAttributes<Category>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare parentId: CreationOptional<string | null>;
  declare name: string;
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Category.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    parentId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING(80), allowNull: false },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "categories" },
);

// --- Fournisseurs
export class Supplier extends Model<InferAttributes<Supplier>, InferCreationAttributes<Supplier>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare name: string;
  declare contactName: CreationOptional<string | null>;
  declare phone: CreationOptional<string | null>;
  declare email: CreationOptional<string | null>;
  declare address: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Supplier.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    contactName: { type: DataTypes.STRING(100), allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "suppliers" },
);

// --- Produits
export const PRODUCT_STATUSES = ["active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export class Product extends Model<InferAttributes<Product>, InferCreationAttributes<Product>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare sku: string;
  declare barcode: CreationOptional<string | null>;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare categoryId: CreationOptional<string | null>;
  declare unitId: string;
  declare salePrice: string;
  declare purchasePriceHint: CreationOptional<string | null>;
  declare alertThreshold: CreationOptional<string>;
  declare status: CreationOptional<ProductStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare category?: NonAttribute<Category | null>;
  declare unit?: NonAttribute<Unit>;
}

Product.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    sku: { type: DataTypes.STRING(64), allowNull: false },
    barcode: { type: DataTypes.STRING(64), allowNull: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    categoryId: { type: DataTypes.UUID, allowNull: true },
    unitId: { type: DataTypes.UUID, allowNull: false },
    salePrice: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    purchasePriceHint: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    alertThreshold: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: "0" },
    status: {
      type: DataTypes.ENUM(...PRODUCT_STATUSES),
      allowNull: false,
      defaultValue: "active",
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "products" },
);
