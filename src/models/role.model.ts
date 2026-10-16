import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../config/database.js";

/** Rôle propre à une entreprise ; les rôles système sont créés avec l'entreprise. */
export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare code: string;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare isSystem: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare permissions?: NonAttribute<RolePermission[]>;
}

Role.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    code: { type: DataTypes.STRING(40), allowNull: false },
    name: { type: DataTypes.STRING(80), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "roles" },
);

export class RolePermission extends Model<
  InferAttributes<RolePermission>,
  InferCreationAttributes<RolePermission>
> {
  declare roleId: string;
  declare permission: string;
}

RolePermission.init(
  {
    roleId: { type: DataTypes.UUID, primaryKey: true },
    permission: { type: DataTypes.STRING(64), primaryKey: true },
  },
  { sequelize, tableName: "role_permissions", timestamps: false },
);
