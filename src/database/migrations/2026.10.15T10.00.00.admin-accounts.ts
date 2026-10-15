import { DataTypes } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Comptes créés par un admin + mot de passe oublié :
 * - users.password devient facultatif (compte invité qui n'a pas encore choisi son mot de passe)
 * - password_tokens : liens à usage unique envoyés par email (invitation / réinitialisation)
 */

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.changeColumn(
      "users",
      "password",
      { type: DataTypes.STRING(255), allowNull: true },
      { transaction },
    );

    await queryInterface.createTable(
      "password_tokens",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        // Crée aussi le type PostgreSQL "enum_password_tokens_purpose"
        purpose: { type: DataTypes.ENUM("invite", "reset"), allowNull: false },
        token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addIndex("password_tokens", ["user_id"], { transaction });
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("password_tokens", { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_password_tokens_purpose";', {
      transaction,
    });

    // Retour à password NOT NULL : impossible tant qu'il reste des comptes invités sans mot de passe.
    // Ils sont supprimés (ils n'ont jamais pu se connecter).
    await queryInterface.sequelize.query("DELETE FROM users WHERE password IS NULL;", {
      transaction,
    });
    await queryInterface.changeColumn(
      "users",
      "password",
      { type: DataTypes.STRING(255), allowNull: false },
      { transaction },
    );
  });
};
