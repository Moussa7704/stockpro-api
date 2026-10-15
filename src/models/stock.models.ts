import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../config/database.js";
import type { Product } from "./catalog.models.js";
import type { Shop } from "./shop.model.js";

/**
 * Stock. Quantités (DECIMAL 14,3) et coûts (DECIMAL 14,4) restent des chaînes : aucun calcul
 * en flottant. Les modifications passent toutes par src/modules/stock/stock-engine.ts.
 */

// --- Solde par boutique × produit
export class StockLevel extends Model<InferAttributes<StockLevel>, InferCreationAttributes<StockLevel>> {
  declare shopId: string;
  declare productId: string;
  declare companyId: string;
  declare quantity: CreationOptional<string>;
  // Coût moyen pondéré (CMP) de la boutique : sert à valoriser le stock et les sorties
  declare averageCost: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
  declare shop?: NonAttribute<Shop>;
}

StockLevel.init(
  {
    shopId: { type: DataTypes.UUID, primaryKey: true },
    productId: { type: DataTypes.UUID, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: "0" },
    averageCost: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: "0" },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "stock_levels" },
);

// --- Journal des mouvements (ajout seul)
export const MOVEMENT_TYPES = [
  "adjustment",
  "inventory_adjustment",
  "transfer_out",
  "transfer_in",
  "purchase_receipt",
  "supplier_return",
  "sale",
  "customer_return",
  "sale_cancellation",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export class StockMovement extends Model<InferAttributes<StockMovement>, InferCreationAttributes<StockMovement>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare productId: string;
  declare type: MovementType;
  declare quantity: string; // signée : + entrée, − sortie
  declare unitCost: string; // coût figé au moment du mouvement
  declare balanceAfter: string;
  declare sourceType: string;
  declare sourceId: string;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

StockMovement.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    shopId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.ENUM(...MOVEMENT_TYPES), allowNull: false },
    quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    unitCost: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    balanceAfter: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    sourceType: { type: DataTypes.STRING(40), allowNull: false },
    sourceId: { type: DataTypes.UUID, allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "stock_movements", updatedAt: false },
);

// --- Ajustement manuel (pièce justificative)
export const ADJUSTMENT_REASONS = [
  "opening_balance",
  "correction",
  "loss",
  "damage",
  "theft",
  "expired",
  "gift",
  "other",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export class StockAdjustment extends Model<InferAttributes<StockAdjustment>, InferCreationAttributes<StockAdjustment>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare number: string;
  declare reason: AdjustmentReason;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

StockAdjustment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    shopId: { type: DataTypes.UUID, allowNull: false },
    number: { type: DataTypes.STRING(40), allowNull: false },
    reason: { type: DataTypes.ENUM(...ADJUSTMENT_REASONS), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "stock_adjustments" },
);

// --- Transferts entre boutiques
export const TRANSFER_STATUSES = ["draft", "shipped", "received", "cancelled"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export class StockTransfer extends Model<InferAttributes<StockTransfer>, InferCreationAttributes<StockTransfer>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare number: string;
  declare fromShopId: string;
  declare toShopId: string;
  declare status: CreationOptional<TransferStatus>;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare shippedAt: CreationOptional<Date | null>;
  declare shippedBy: CreationOptional<string | null>;
  declare receivedAt: CreationOptional<Date | null>;
  declare receivedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare lines?: NonAttribute<StockTransferLine[]>;
}

StockTransfer.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    number: { type: DataTypes.STRING(40), allowNull: false },
    fromShopId: { type: DataTypes.UUID, allowNull: false },
    toShopId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.ENUM(...TRANSFER_STATUSES), allowNull: false, defaultValue: "draft" },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    shippedAt: { type: DataTypes.DATE, allowNull: true },
    shippedBy: { type: DataTypes.UUID, allowNull: true },
    receivedAt: { type: DataTypes.DATE, allowNull: true },
    receivedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "stock_transfers" },
);

export class StockTransferLine extends Model<
  InferAttributes<StockTransferLine>,
  InferCreationAttributes<StockTransferLine>
> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare transferId: string;
  declare productId: string;
  declare quantitySent: string;
  declare quantityReceived: CreationOptional<string | null>;
  declare unitCost: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

StockTransferLine.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    transferId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    quantitySent: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    quantityReceived: { type: DataTypes.DECIMAL(14, 3), allowNull: true },
    unitCost: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "stock_transfer_lines" },
);

// --- Inventaires
export const INVENTORY_STATUSES = ["draft", "validated", "cancelled"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export class InventoryCount extends Model<InferAttributes<InventoryCount>, InferCreationAttributes<InventoryCount>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare number: string;
  declare status: CreationOptional<InventoryStatus>;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare validatedAt: CreationOptional<Date | null>;
  declare validatedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare lines?: NonAttribute<InventoryCountLine[]>;
}

InventoryCount.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    shopId: { type: DataTypes.UUID, allowNull: false },
    number: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.ENUM(...INVENTORY_STATUSES), allowNull: false, defaultValue: "draft" },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    validatedAt: { type: DataTypes.DATE, allowNull: true },
    validatedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "inventory_counts" },
);

export class InventoryCountLine extends Model<
  InferAttributes<InventoryCountLine>,
  InferCreationAttributes<InventoryCountLine>
> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare inventoryId: string;
  declare productId: string;
  declare countedQuantity: string;
  declare expectedQuantity: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

InventoryCountLine.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    inventoryId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    countedQuantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    expectedQuantity: { type: DataTypes.DECIMAL(14, 3), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "inventory_count_lines" },
);
