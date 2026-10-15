import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../config/database.js";
import type { Product, Supplier } from "./catalog.models.js";

/** Achats (RB-06). Montants et quantités : chaînes décimales, calculées avec decimal.js. */

const id = { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true };
const uuid = (allowNull = false) => ({ type: DataTypes.UUID, allowNull });
const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 2), allowNull });
const quantity = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 3), allowNull });
const timestamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

// --- Bons de commande
export const ORDER_STATUSES = ["draft", "sent", "partially_received", "received", "closed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export class PurchaseOrder extends Model<InferAttributes<PurchaseOrder>, InferCreationAttributes<PurchaseOrder>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare supplierId: string;
  declare number: string;
  declare status: CreationOptional<OrderStatus>;
  declare expectedAt: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare total: CreationOptional<string>;
  declare createdBy: string;
  declare sentAt: CreationOptional<Date | null>;
  declare closedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare lines?: NonAttribute<PurchaseOrderLine[]>;
  declare supplier?: NonAttribute<Supplier>;
}

PurchaseOrder.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    supplierId: uuid(),
    number: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.ENUM(...ORDER_STATUSES), allowNull: false, defaultValue: "draft" },
    expectedAt: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    total: { ...money(), defaultValue: "0" },
    createdBy: uuid(),
    sentAt: { type: DataTypes.DATE, allowNull: true },
    closedAt: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  },
  { sequelize, tableName: "purchase_orders" },
);

export class PurchaseOrderLine extends Model<
  InferAttributes<PurchaseOrderLine>,
  InferCreationAttributes<PurchaseOrderLine>
> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare orderId: string;
  declare productId: string;
  declare quantityOrdered: string;
  declare quantityReceived: CreationOptional<string>;
  declare unitCost: string;
  declare lineTotal: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

PurchaseOrderLine.init(
  {
    id,
    companyId: uuid(),
    orderId: uuid(),
    productId: uuid(),
    quantityOrdered: quantity(),
    quantityReceived: { ...quantity(), defaultValue: "0" },
    unitCost: money(),
    lineTotal: money(),
    ...timestamps,
  },
  { sequelize, tableName: "purchase_order_lines" },
);

// --- Réceptions
export const RECEIPT_STATUSES = ["draft", "validated", "cancelled"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export class GoodsReceipt extends Model<InferAttributes<GoodsReceipt>, InferCreationAttributes<GoodsReceipt>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare supplierId: string;
  declare orderId: CreationOptional<string | null>;
  declare number: string;
  declare status: CreationOptional<ReceiptStatus>;
  declare supplierReference: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare total: CreationOptional<string>;
  declare createdBy: string;
  declare validatedAt: CreationOptional<Date | null>;
  declare validatedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare lines?: NonAttribute<GoodsReceiptLine[]>;
}

GoodsReceipt.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    supplierId: uuid(),
    orderId: uuid(true),
    number: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.ENUM(...RECEIPT_STATUSES), allowNull: false, defaultValue: "draft" },
    supplierReference: { type: DataTypes.STRING(60), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    total: { ...money(), defaultValue: "0" },
    createdBy: uuid(),
    validatedAt: { type: DataTypes.DATE, allowNull: true },
    validatedBy: uuid(true),
    ...timestamps,
  },
  { sequelize, tableName: "goods_receipts" },
);

export class GoodsReceiptLine extends Model<InferAttributes<GoodsReceiptLine>, InferCreationAttributes<GoodsReceiptLine>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare receiptId: string;
  declare productId: string;
  declare orderLineId: CreationOptional<string | null>;
  declare quantity: string;
  declare unitCost: string;
  declare lineTotal: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

GoodsReceiptLine.init(
  {
    id,
    companyId: uuid(),
    receiptId: uuid(),
    productId: uuid(),
    orderLineId: uuid(true),
    quantity: quantity(),
    unitCost: money(),
    lineTotal: money(),
    ...timestamps,
  },
  { sequelize, tableName: "goods_receipt_lines" },
);

// --- Retours fournisseurs
export class SupplierReturn extends Model<InferAttributes<SupplierReturn>, InferCreationAttributes<SupplierReturn>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare supplierId: string;
  declare receiptId: CreationOptional<string | null>;
  declare number: string;
  declare status: CreationOptional<ReceiptStatus>;
  declare reason: string;
  declare notes: CreationOptional<string | null>;
  declare total: CreationOptional<string>;
  declare createdBy: string;
  declare validatedAt: CreationOptional<Date | null>;
  declare validatedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare lines?: NonAttribute<SupplierReturnLine[]>;
}

SupplierReturn.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    supplierId: uuid(),
    receiptId: uuid(true),
    number: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.ENUM(...RECEIPT_STATUSES), allowNull: false, defaultValue: "draft" },
    reason: { type: DataTypes.STRING(255), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    total: { ...money(), defaultValue: "0" },
    createdBy: uuid(),
    validatedAt: { type: DataTypes.DATE, allowNull: true },
    validatedBy: uuid(true),
    ...timestamps,
  },
  { sequelize, tableName: "supplier_returns" },
);

export class SupplierReturnLine extends Model<
  InferAttributes<SupplierReturnLine>,
  InferCreationAttributes<SupplierReturnLine>
> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare returnId: string;
  declare productId: string;
  declare quantity: string;
  declare unitCost: CreationOptional<string | null>;
  declare lineTotal: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

SupplierReturnLine.init(
  {
    id,
    companyId: uuid(),
    returnId: uuid(),
    productId: uuid(),
    quantity: quantity(),
    unitCost: money(true),
    lineTotal: money(true),
    ...timestamps,
  },
  { sequelize, tableName: "supplier_return_lines" },
);

// --- Factures et paiements fournisseurs
export const INVOICE_STATUSES = ["unpaid", "partially_paid", "paid", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const SUPPLIER_PAYMENT_METHODS = ["cash", "bank_transfer", "mobile_money", "check", "other"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

export class SupplierInvoice extends Model<InferAttributes<SupplierInvoice>, InferCreationAttributes<SupplierInvoice>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare supplierId: string;
  declare receiptId: CreationOptional<string | null>;
  declare reference: string;
  declare invoiceDate: string;
  declare dueDate: CreationOptional<string | null>;
  declare total: string;
  declare amountPaid: CreationOptional<string>;
  declare status: CreationOptional<InvoiceStatus>;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare payments?: NonAttribute<SupplierPayment[]>;
  declare supplier?: NonAttribute<Supplier>;
}

SupplierInvoice.init(
  {
    id,
    companyId: uuid(),
    supplierId: uuid(),
    receiptId: uuid(true),
    reference: { type: DataTypes.STRING(60), allowNull: false },
    invoiceDate: { type: DataTypes.DATEONLY, allowNull: false },
    dueDate: { type: DataTypes.DATEONLY, allowNull: true },
    total: money(),
    amountPaid: { ...money(), defaultValue: "0" },
    status: { type: DataTypes.ENUM(...INVOICE_STATUSES), allowNull: false, defaultValue: "unpaid" },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: uuid(),
    ...timestamps,
  },
  { sequelize, tableName: "supplier_invoices" },
);

export class SupplierPayment extends Model<InferAttributes<SupplierPayment>, InferCreationAttributes<SupplierPayment>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare supplierId: string;
  declare invoiceId: string;
  declare amount: string;
  declare method: SupplierPaymentMethod;
  declare paidAt: string;
  declare reference: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;
}

SupplierPayment.init(
  {
    id,
    companyId: uuid(),
    supplierId: uuid(),
    invoiceId: uuid(),
    amount: money(),
    method: { type: DataTypes.ENUM(...SUPPLIER_PAYMENT_METHODS), allowNull: false },
    paidAt: { type: DataTypes.DATEONLY, allowNull: false },
    reference: { type: DataTypes.STRING(60), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: uuid(),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "supplier_payments", updatedAt: false },
);

// --- Idempotence
export class IdempotencyKey extends Model<InferAttributes<IdempotencyKey>, InferCreationAttributes<IdempotencyKey>> {
  declare companyId: string;
  declare key: string;
  declare userId: string;
  declare requestHash: string;
  declare status: "processing" | "completed";
  declare responseStatus: CreationOptional<number | null>;
  declare responseBody: CreationOptional<object | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

IdempotencyKey.init(
  {
    companyId: { type: DataTypes.UUID, primaryKey: true },
    key: { type: DataTypes.STRING(100), primaryKey: true },
    userId: uuid(),
    requestHash: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.ENUM("processing", "completed"), allowNull: false },
    responseStatus: { type: DataTypes.INTEGER, allowNull: true },
    responseBody: { type: DataTypes.JSONB, allowNull: true },
    ...timestamps,
  },
  { sequelize, tableName: "idempotency_keys" },
);
