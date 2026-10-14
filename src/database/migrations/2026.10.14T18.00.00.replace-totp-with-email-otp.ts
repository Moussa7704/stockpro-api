import { DataTypes } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * La 2FA par application (TOTP) est remplacée par un code OTP envoyé par email à chaque connexion :
 * suppression des tables TOTP, création de email_otp_codes.
 */

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

const userForeignKey = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: "users", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "CASCADE",
};

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("two_factor_backup_codes", { transaction });
    await queryInterface.dropTable("user_two_factor", { transaction });

    await queryInterface.createTable(
      "email_otp_codes",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: userForeignKey,
        challenge_id: { type: DataTypes.UUID, allowNull: false, unique: true },
        code_hash: { type: DataTypes.STRING(64), allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        resend_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        last_sent_at: { type: DataTypes.DATE, allowNull: false },
        consumed_at: { type: DataTypes.DATE, allowNull: true },
        ...timestamps,
      },
      { transaction },
    );
    await queryInterface.addIndex("email_otp_codes", ["user_id"], { transaction });
  });
};

// Retour arrière : recrée les tables TOTP vides (les données supprimées ne reviennent pas)
export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("email_otp_codes", { transaction });

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
