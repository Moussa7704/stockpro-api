import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../config/database.js";
import type { PaymentMethod } from "./pos.models.js";

const id = { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true };
const uuid = (allowNull = false) => ({ type: DataTypes.UUID, allowNull });
const money = { type: DataTypes.DECIMAL(14, 2), allowNull: false };

// --- Règlements de dette client (ajout seul)
export class CustomerPayment extends Model<InferAttributes<CustomerPayment>, InferCreationAttributes<CustomerPayment>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare customerId: string;
  declare shopId: string;
  declare paymentMethodId: string;
  declare cashSessionId: CreationOptional<string | null>;
  declare amount: string;
  declare reference: CreationOptional<string | null>;
  declare notes: CreationOptional<string | null>;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;

  declare paymentMethod?: NonAttribute<PaymentMethod>;
}

CustomerPayment.init(
  {
    id,
    companyId: uuid(),
    customerId: uuid(),
    shopId: uuid(),
    paymentMethodId: uuid(),
    cashSessionId: uuid(true),
    amount: money,
    reference: { type: DataTypes.STRING(60), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdBy: uuid(),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "customer_payments", updatedAt: false },
);

// --- Dépenses
export class ExpenseCategory extends Model<InferAttributes<ExpenseCategory>, InferCreationAttributes<ExpenseCategory>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare name: string;
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ExpenseCategory.init(
  {
    id,
    companyId: uuid(),
    name: { type: DataTypes.STRING(80), allowNull: false },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "expense_categories" },
);

export class Expense extends Model<InferAttributes<Expense>, InferCreationAttributes<Expense>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare shopId: string;
  declare categoryId: string;
  declare number: string;
  declare amount: string;
  declare description: string;
  declare spentAt: string;
  declare paymentMethodId: string;
  declare cashSessionId: CreationOptional<string | null>;
  declare supplierId: CreationOptional<string | null>;
  declare reference: CreationOptional<string | null>;
  declare status: CreationOptional<"recorded" | "cancelled">;
  declare createdBy: string;
  declare cancelledAt: CreationOptional<Date | null>;
  declare cancelledBy: CreationOptional<string | null>;
  declare cancelReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare category?: NonAttribute<ExpenseCategory>;
  declare paymentMethod?: NonAttribute<PaymentMethod>;
}

Expense.init(
  {
    id,
    companyId: uuid(),
    shopId: uuid(),
    categoryId: uuid(),
    number: { type: DataTypes.STRING(40), allowNull: false },
    amount: money,
    description: { type: DataTypes.STRING(255), allowNull: false },
    spentAt: { type: DataTypes.DATEONLY, allowNull: false },
    paymentMethodId: uuid(),
    cashSessionId: uuid(true),
    supplierId: uuid(true),
    reference: { type: DataTypes.STRING(60), allowNull: true },
    status: { type: DataTypes.ENUM("recorded", "cancelled"), allowNull: false, defaultValue: "recorded" },
    createdBy: uuid(),
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    cancelledBy: uuid(true),
    cancelReason: { type: DataTypes.STRING(255), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "expenses" },
);
