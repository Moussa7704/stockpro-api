import { DataTypes } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Appareils connectés :
 * - session_id : identifiant STABLE d'une session (un appareil), conservé à chaque renouvellement
 *   (chaque renouvellement crée une nouvelle ligne : sans lui, impossible de suivre un appareil) ;
 * - session_started_at : date de connexion de l'appareil ;
 * - user_agent, ip_address : pour reconnaître l'appareil dans la liste ;
 * - revoke_reason : pourquoi la ligne a été fermée. Seul un jeton « rotated » (remplacé au
 *   renouvellement) qui revient trahit un vol ; un appareil déconnecté qui réessaie, non.
 */

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("refresh_tokens", "session_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.addColumn("refresh_tokens", "session_started_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await queryInterface.addColumn("refresh_tokens", "user_agent", { type: DataTypes.STRING(512), allowNull: true }, { transaction });
    await queryInterface.addColumn("refresh_tokens", "ip_address", { type: DataTypes.STRING(64), allowNull: true }, { transaction });
    await queryInterface.addColumn(
      "refresh_tokens",
      "revoke_reason",
      { type: DataTypes.ENUM("rotated", "logout", "revoked", "password_change", "reuse"), allowNull: true },
      { transaction },
    );

    // Sessions existantes : chaque ligne devient sa propre session ; les lignes déjà fermées sont
    // considérées comme remplacées (comportement d'avant : un retour déclenche la protection)
    await queryInterface.sequelize.query(
      `UPDATE refresh_tokens SET session_id = id, session_started_at = created_at,
              revoke_reason = CASE WHEN revoked_at IS NOT NULL THEN 'rotated'::"enum_refresh_tokens_revoke_reason" END`,
      { transaction },
    );
    await queryInterface.changeColumn("refresh_tokens", "session_id", { type: DataTypes.UUID, allowNull: false }, { transaction });
    await queryInterface.changeColumn("refresh_tokens", "session_started_at", { type: DataTypes.DATE, allowNull: false }, { transaction });
    await queryInterface.addIndex("refresh_tokens", ["session_id"], { transaction });
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeIndex("refresh_tokens", ["session_id"], { transaction });
    for (const column of ["session_id", "session_started_at", "user_agent", "ip_address", "revoke_reason"]) {
      await queryInterface.removeColumn("refresh_tokens", column, { transaction });
    }
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_refresh_tokens_revoke_reason";', { transaction });
  });
};
