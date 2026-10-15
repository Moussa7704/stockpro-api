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

/** Caisse et clients. Montants et quantités : chaînes décimales, calculs avec decimal.js. */

const id = { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true };
const uuid = (allowNull = false) => ({ type: DataTypes.UUID, allowNull });
const money = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 2), allowNull });
const quantity = (allowNull = false) => ({ type: DataTypes.DECIMAL(14, 3), allowNull });
const timestamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

// --- Moyens de paiement
export const PAYMENT_METHOD_TYPES = ["cash", "mobile_money", "card", "bank", "other"] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export class PaymentMethod extends Model<InferAttributes<PaymentMethod>, InferCreationAttributes<PaymentMethod>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare code: string;
  declare name: string;
  declare type: PaymentMethodType;
  declare active: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PaymentMethod.init(
  {
    id,
    companyId: uuid(),
    code: { type: DataTypes.STRING(30), allowNull: false },
    name: { type: DataTypes.STRING(60), allowNull: false },
    type: { type: DataTypes.ENUM(...PAYMENT_METHOD_TYPES), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps,
  },
  { sequelize, tableName: "payment_methods" },
);

// --- Sessions de caisse
export class CashSession extends Model<InferAttributes<CashSession>, InferCreationAttributes<CashSession>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare cashierId: string;
  declare status: CreationOptional<"open" | "closed">;
  declare openedAt: Date;
  declare openingFloat: string;
  declare closedAt: CreationOptional<Date | null>;
  declare closedBy: CreationOptional<string | null>;
  declare expectedCash: CreationOptional<string | null>;
  declare countedCash: CreationOptional<string | null>;
  declare difference: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

CashSession.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    cashierId: uuid(),
    status: { type: DataTypes.ENUM("open", "closed"), allowNull: false, defaultValue: "open" },
    openedAt: { type: DataTypes.DATE, allowNull: false },
    openingFloat: money(),
    closedAt: { type: DataTypes.DATE, allowNull: true },
    closedBy: uuid(true),
    expectedCash: money(true),
    countedCash: money(true),
    difference: money(true),
    notes: { type: DataTypes.TEXT, allowNull: true },
    ...timestamps,
  },
  { sequelize, tableName: "cash_sessions" },
);

// --- Clients
export class Customer extends Model<InferAttributes<Customer>, InferCreationAttributes<Customer>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare name: string;
  declare phone: CreationOptional<string | null>;
  declare email: CreationOptional<string | null>;
  declare address: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare creditLimit: CreationOptional<string | null>;
  declare balance: CreationOptional<string>;
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Customer.init(
  {
    id,
    companyId: uuid(),
    name: { type: DataTypes.STRING(150), allowNull: false },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    address: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    creditLimit: money(true),
    balance: { ...money(), defaultValue: "0" },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  },
  { sequelize, tableName: "customers" },
);

export const LEDGER_TYPES = ["sale_credit", "sale_cancellation", "payment", "return_credit", "adjustment"] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export class CustomerLedgerEntry extends Model<
  InferAttributes<CustomerLedgerEntry>,
  InferCreationAttributes<CustomerLedgerEntry>
> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare customerId: string;
  declare type: LedgerType;
  declare amount: string;
  declare balanceAfter: string;
  declare sourceType: string;
  declare sourceId: string;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

CustomerLedgerEntry.init(
  {
    id,
    companyId: uuid(),
    customerId: uuid(),
    type: { type: DataTypes.ENUM(...LEDGER_TYPES), allowNull: false },
    amount: money(),
    balanceAfter: money(),
    sourceType: { type: DataTypes.STRING(40), allowNull: false },
    sourceId: uuid(),
    createdBy: uuid(true),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "customer_ledger_entries", updatedAt: false },
);

// --- Ventes
export class Sale extends Model<InferAttributes<Sale>, InferCreationAttributes<Sale>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare cashSessionId: string;
  declare customerId: CreationOptional<string | null>;
  declare number: string;
  declare status: CreationOptional<"completed" | "cancelled">;
  declare subtotal: string;
  declare discountTotal: string;
  declare total: string;
  declare amountPaid: string;
  declare changeGiven: CreationOptional<string>;
  declare balanceDue: CreationOptional<string>;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare cancelledAt: CreationOptional<Date | null>;
  declare cancelledBy: CreationOptional<string | null>;
  declare cancelReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare lines?: NonAttribute<SaleLine[]>;
  declare payments?: NonAttribute<SalePayment[]>;
  declare customer?: NonAttribute<Customer | null>;
}

Sale.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    cashSessionId: uuid(),
    customerId: uuid(true),
    number: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.ENUM("completed", "cancelled"), allowNull: false, defaultValue: "completed" },
    subtotal: money(),
    discountTotal: money(),
    total: money(),
    amountPaid: money(),
    changeGiven: { ...money(), defaultValue: "0" },
    balanceDue: { ...money(), defaultValue: "0" },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: uuid(),
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    cancelledBy: uuid(true),
    cancelReason: { type: DataTypes.STRING(255), allowNull: true },
    ...timestamps,
  },
  { sequelize, tableName: "sales" },
);

export class SaleLine extends Model<InferAttributes<SaleLine>, InferCreationAttributes<SaleLine>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare saleId: string;
  declare productId: string;
  declare quantity: string;
  declare unitPrice: string;
  declare discount: CreationOptional<string>;
  declare lineTotal: string;
  declare unitCost: string;
  declare returnedQuantity: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
}

SaleLine.init(
  {
    id,
    companyId: uuid(),
    saleId: uuid(),
    productId: uuid(),
    quantity: quantity(),
    unitPrice: money(),
    discount: { ...money(), defaultValue: "0" },
    lineTotal: money(),
    unitCost: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    returnedQuantity: { ...quantity(), defaultValue: "0" },
    ...timestamps,
  },
  { sequelize, tableName: "sale_lines" },
);

export class SalePayment extends Model<InferAttributes<SalePayment>, InferCreationAttributes<SalePayment>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare saleId: string;
  declare paymentMethodId: string;
  declare cashSessionId: string;
  declare amount: string;
  declare reference: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;

  declare paymentMethod?: NonAttribute<PaymentMethod>;
}

SalePayment.init(
  {
    id,
    companyId: uuid(),
    saleId: uuid(),
    paymentMethodId: uuid(),
    cashSessionId: uuid(),
    amount: money(),
    reference: { type: DataTypes.STRING(60), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "sale_payments", updatedAt: false },
);

// --- Retours clients
export class SaleReturn extends Model<InferAttributes<SaleReturn>, InferCreationAttributes<SaleReturn>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare saleId: string;
  declare cashSessionId: CreationOptional<string | null>;
  declare number: string;
  declare reason: string;
  declare refundAmount: string;
  declare refundTo: "method" | "customer_account";
  declare refundMethodId: CreationOptional<string | null>;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;

  declare lines?: NonAttribute<SaleReturnLine[]>;
}

SaleReturn.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    saleId: uuid(),
    cashSessionId: uuid(true),
    number: { type: DataTypes.STRING(40), allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: false },
    refundAmount: money(),
    refundTo: { type: DataTypes.ENUM("method", "customer_account"), allowNull: false },
    refundMethodId: uuid(true),
    createdBy: uuid(),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "sale_returns", updatedAt: false },
);

export class SaleReturnLine extends Model<InferAttributes<SaleReturnLine>, InferCreationAttributes<SaleReturnLine>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare returnId: string;
  declare saleLineId: string;
  declare productId: string;
  declare quantity: string;
  declare restock: boolean;
  declare refundAmount: string;
  declare createdAt: CreationOptional<Date>;
}

SaleReturnLine.init(
  {
    id,
    companyId: uuid(),
    returnId: uuid(),
    saleLineId: uuid(),
    productId: uuid(),
    quantity: quantity(),
    restock: { type: DataTypes.BOOLEAN, allowNull: false },
    refundAmount: money(),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "sale_return_lines", updatedAt: false },
);
