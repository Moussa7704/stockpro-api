import { DataTypes } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Schéma initial : reprend les tables créées jusqu'ici par sequelize.sync().
 * Une migration déjà appliquée ne se modifie plus : tout changement futur = nouvelle migration.
 * Les noms de colonnes sont écrits en snake_case : queryInterface ne connaît pas l'option underscored des modèles.
 */

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

// Clé étrangère vers users : supprimer un utilisateur supprime ses données liées
const userForeignKey = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: "users", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "CASCADE",
};

export const up: Migration = async ({ context: queryInterface }) => {
  // PostgreSQL sait annuler du DDL : si une étape échoue, rien n'est créé
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "users",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        name: { type: DataTypes.STRING(100), allowNull: false },
        email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        password: { type: DataTypes.STRING(255), allowNull: false },
        // Crée aussi le type PostgreSQL "enum_users_role"
        role: {
          type: DataTypes.ENUM("admin", "manager", "employee"),
          allowNull: false,
          defaultValue: "employee",
        },
        ...timestamps,
      },
      { transaction },
    );

    await queryInterface.createTable(
      "refresh_tokens",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: userForeignKey,
        token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await queryInterface.addIndex("refresh_tokens", ["user_id"], { transaction });

    await queryInterface.createTable(
      "user_two_factor",
      {
        user_id: { ...userForeignKey, primaryKey: true },
        secret_encrypted: { type: DataTypes.TEXT, allowNull: false },
        enabled_at: { type: DataTypes.DATE, allowNull: true },
        last_used_step: { type: DataTypes.INTEGER, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );

    await queryInterface.createTable(
      "two_factor_backup_codes",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: userForeignKey,
        code_hash: { type: DataTypes.STRING(64), allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await queryInterface.addIndex("two_factor_backup_codes", ["user_id", "code_hash"], {
      transaction,
    });
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Ordre inverse : d'abord les tables qui dépendent de users
    await queryInterface.dropTable("two_factor_backup_codes", { transaction });
    await queryInterface.dropTable("user_two_factor", { transaction });
    await queryInterface.dropTable("refresh_tokens", { transaction });
    await queryInterface.dropTable("users", { transaction });
    // dropTable ne supprime pas le type ENUM créé avec la table users
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_role";', {
      transaction,
    });
  });
};
