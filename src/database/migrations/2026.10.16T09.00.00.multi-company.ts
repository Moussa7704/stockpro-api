import { DataTypes, type QueryInterface, type Transaction } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Socle multi-entreprise (cahier des charges §5.2) :
 * - companies, shops, roles + role_permissions, memberships + membership_shops, audit_logs
 * - users.role disparaît : le rôle dépend de l'entreprise (memberships.role_id) ;
 *   users.is_platform_admin désigne l'administrateur SaaS
 * - refresh_tokens.company_id : entreprise active de la session
 *
 * Isolation (RB-01) : UNIQUE (company_id, id) sur chaque table d'entreprise, et clés étrangères
 * composites (company_id, x_id) → la base refuse de relier deux entreprises différentes.
 */

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

const companyForeignKey = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: "companies", key: "id" },
  onUpdate: "CASCADE",
  // On n'efface jamais une entreprise qui a des données : on la suspend
  onDelete: "RESTRICT",
};

async function addCompanyScopedUnique(
  queryInterface: QueryInterface,
  table: string,
  transaction: Transaction,
): Promise<void> {
  // Cible des clés étrangères composites (company_id, id)
  await queryInterface.addConstraint(table, {
    type: "unique",
    fields: ["company_id", "id"],
    name: `${table}_company_id_id_key`,
    transaction,
  });
}

async function addCompositeForeignKey(
  queryInterface: QueryInterface,
  table: string,
  column: string,
  target: string,
  onDelete: "RESTRICT" | "CASCADE",
  transaction: Transaction,
): Promise<void> {
  // En SQL : addConstraint de Sequelize ne gère pas les clés étrangères sur plusieurs colonnes
  await queryInterface.sequelize.query(
    `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${column}_same_company_fkey"
       FOREIGN KEY ("company_id", "${column}") REFERENCES "${target}" ("company_id", "id")
       ON UPDATE CASCADE ON DELETE ${onDelete};`,
    { transaction },
  );
}

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // --- users : administrateur SaaS au lieu d'un rôle global
    await queryInterface.addColumn(
      "users",
      "is_platform_admin",
      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      { transaction },
    );
    // Les anciens "admin" globaux deviennent administrateurs de la plateforme
    await queryInterface.sequelize.query(
      "UPDATE users SET is_platform_admin = true WHERE role = 'admin';",
      { transaction },
    );
    await queryInterface.removeColumn("users", "role", { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_role";', { transaction });

    // --- companies
    await queryInterface.createTable(
      "companies",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        name: { type: DataTypes.STRING(150), allowNull: false },
        slug: { type: DataTypes.STRING(60), allowNull: false, unique: true },
        currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "XOF" },
        timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Africa/Abidjan" },
        status: {
          type: DataTypes.ENUM("active", "suspended"),
          allowNull: false,
          defaultValue: "active",
        },
        settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        ...timestamps,
      },
      { transaction },
    );

    // --- shops
    await queryInterface.createTable(
      "shops",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        name: { type: DataTypes.STRING(120), allowNull: false },
        code: { type: DataTypes.STRING(20), allowNull: false },
        address: { type: DataTypes.STRING(255), allowNull: true },
        phone: { type: DataTypes.STRING(30), allowNull: true },
        archived_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await addCompanyScopedUnique(queryInterface, "shops", transaction);
    await queryInterface.addConstraint("shops", {
      type: "unique",
      fields: ["company_id", "code"],
      name: "shops_company_id_code_key",
      transaction,
    });

    // --- roles + permissions
    await queryInterface.createTable(
      "roles",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        code: { type: DataTypes.STRING(40), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ...timestamps,
      },
      { transaction },
    );
    await addCompanyScopedUnique(queryInterface, "roles", transaction);
    await queryInterface.addConstraint("roles", {
      type: "unique",
      fields: ["company_id", "code"],
      name: "roles_company_id_code_key",
      transaction,
    });

    await queryInterface.createTable(
      "role_permissions",
      {
        role_id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          references: { model: "roles", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        permission: { type: DataTypes.STRING(64), primaryKey: true, allowNull: false },
      },
      { transaction },
    );

    // --- memberships : un utilisateur dans une entreprise, avec un rôle
    await queryInterface.createTable(
      "memberships",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: companyForeignKey,
        user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        role_id: { type: DataTypes.UUID, allowNull: false },
        all_shops: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        status: {
          type: DataTypes.ENUM("active", "disabled"),
          allowNull: false,
          defaultValue: "active",
        },
        ...timestamps,
      },
      { transaction },
    );
    await addCompanyScopedUnique(queryInterface, "memberships", transaction);
    await queryInterface.addConstraint("memberships", {
      type: "unique",
      fields: ["company_id", "user_id"],
      name: "memberships_company_id_user_id_key",
      transaction,
    });
    await queryInterface.addIndex("memberships", ["user_id"], { transaction });
    // Le rôle doit appartenir à la même entreprise que l'appartenance
    await addCompositeForeignKey(queryInterface, "memberships", "role_id", "roles", "RESTRICT", transaction);

    // --- membership_shops : boutiques autorisées (si all_shops = false)
    await queryInterface.createTable(
      "membership_shops",
      {
        membership_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        shop_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        company_id: { type: DataTypes.UUID, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await addCompositeForeignKey(
      queryInterface,
      "membership_shops",
      "membership_id",
      "memberships",
      "CASCADE",
      transaction,
    );
    await addCompositeForeignKey(queryInterface, "membership_shops", "shop_id", "shops", "RESTRICT", transaction);

    // --- audit_logs : journal en ajout seul (RB-07)
    await queryInterface.createTable(
      "audit_logs",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        // null = action de la plateforme (administrateur SaaS)
        company_id: { ...companyForeignKey, allowNull: true },
        shop_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: "shops", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        actor_user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL",
        },
        action: { type: DataTypes.STRING(80), allowNull: false },
        entity_type: { type: DataTypes.STRING(60), allowNull: true },
        entity_id: { type: DataTypes.STRING(64), allowNull: true },
        before: { type: DataTypes.JSONB, allowNull: true },
        after: { type: DataTypes.JSONB, allowNull: true },
        ip: { type: DataTypes.STRING(64), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addIndex("audit_logs", ["company_id", "created_at"], { transaction });
    await queryInterface.addIndex("audit_logs", ["entity_type", "entity_id"], { transaction });

    // --- refresh_tokens : entreprise active de la session
    await queryInterface.addColumn(
      "refresh_tokens",
      "company_id",
      {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: "companies", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn("refresh_tokens", "company_id", { transaction });
    await queryInterface.dropTable("audit_logs", { transaction });
    await queryInterface.dropTable("membership_shops", { transaction });
    await queryInterface.dropTable("memberships", { transaction });
    await queryInterface.dropTable("role_permissions", { transaction });
    await queryInterface.dropTable("roles", { transaction });
    await queryInterface.dropTable("shops", { transaction });
    await queryInterface.dropTable("companies", { transaction });
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_companies_status"; DROP TYPE IF EXISTS "enum_memberships_status";',
      { transaction },
    );

    // Retour au rôle global sur users
    await queryInterface.addColumn(
      "users",
      "role",
      {
        type: DataTypes.ENUM("admin", "manager", "employee"),
        allowNull: false,
        defaultValue: "employee",
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      "UPDATE users SET role = 'admin' WHERE is_platform_admin = true;",
      { transaction },
    );
    await queryInterface.removeColumn("users", "is_platform_admin", { transaction });
  });
};
