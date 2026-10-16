import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../config/database.js";
import type { Company } from "./company.model.js";
import type { Role } from "./role.model.js";
import type { Shop } from "./shop.model.js";
import type { User } from "./user.model.js";

export const MEMBERSHIP_STATUSES = ["active", "disabled"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Appartenance d'un utilisateur à une entreprise, avec un rôle.
 * Un même compte peut appartenir à plusieurs entreprises (décision D-03).
 */
export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  declare id: CreationOptional<string>;
  declare companyId: string;
  declare userId: string;
  declare roleId: string;
  // true : toutes les boutiques de l'entreprise ; false : seulement celles de membership_shops
  declare allShops: CreationOptional<boolean>;
  declare status: CreationOptional<MembershipStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  // Associations chargées avec include
  declare company?: NonAttribute<Company>;
  declare user?: NonAttribute<User>;
  declare role?: NonAttribute<Role>;
  declare shops?: NonAttribute<Shop[]>;
  declare permissionOverrides?: NonAttribute<MembershipPermission[]>;
}

Membership.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    roleId: { type: DataTypes.UUID, allowNull: false },
    allShops: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: {
      type: DataTypes.ENUM(...MEMBERSHIP_STATUSES),
      allowNull: false,
      defaultValue: "active",
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "memberships" },
);

/** Boutiques autorisées pour une appartenance (quand allShops = false). */
export class MembershipShop extends Model<
  InferAttributes<MembershipShop>,
  InferCreationAttributes<MembershipShop>
> {
  declare membershipId: string;
  declare shopId: string;
  declare companyId: string;
  declare createdAt: CreationOptional<Date>;
}

MembershipShop.init(
  {
    membershipId: { type: DataTypes.UUID, primaryKey: true },
    shopId: { type: DataTypes.UUID, primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "membership_shops", updatedAt: false },
);

export const PERMISSION_EFFECTS = ["grant", "revoke"] as const;
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number];

/**
 * Permission ajoutée (grant) ou retirée (revoke) à un membre, en plus de son rôle.
 * Droits effectifs = permissions du rôle + ajouts − retraits.
 */
export class MembershipPermission extends Model<
  InferAttributes<MembershipPermission>,
  InferCreationAttributes<MembershipPermission>
> {
  declare membershipId: string;
  declare permission: string;
  declare companyId: string;
  declare effect: PermissionEffect;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

MembershipPermission.init(
  {
    membershipId: { type: DataTypes.UUID, primaryKey: true },
    permission: { type: DataTypes.STRING(64), primaryKey: true },
    companyId: { type: DataTypes.UUID, allowNull: false },
    effect: { type: DataTypes.ENUM(...PERMISSION_EFFECTS), allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "membership_permissions", updatedAt: false },
);
