import type { Migration } from "../migrator.js";

/**
 * Le gérant paramètre l'espace de l'entreprise : le rôle système « Gérant » des entreprises
 * existantes reçoit company.manage (les nouvelles entreprises l'ont via SYSTEM_ROLES).
 * Le propriétaire peut toujours le retirer à un gérant précis (droits ajustés par membre).
 */

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT id, 'company.manage' FROM roles WHERE code = 'manager' AND is_system
     ON CONFLICT DO NOTHING;`,
  );
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `DELETE FROM role_permissions rp USING roles r
     WHERE rp.role_id = r.id AND r.code = 'manager' AND r.is_system AND rp.permission = 'company.manage';`,
  );
};
