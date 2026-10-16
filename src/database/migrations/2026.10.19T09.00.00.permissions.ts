import { DataTypes } from "sequelize";
import type { Migration } from "../migrator.js";

/**
 * Gestion fine des droits :
 * - membership_permissions : permissions ajoutées (grant) ou retirées (revoke) à UN membre, en plus de son rôle
 * - roles.description : rôles personnalisés décrits pour l'équipe
 * - entreprises existantes : le propriétaire reçoit roles.manage, le gérant users.manage (délégation)
 */

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const sql = (query: string) => queryInterface.sequelize.query(query, { transaction });

    await queryInterface.createTable(
      "membership_permissions",
      {
        membership_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        permission: { type: DataTypes.STRING(64), primaryKey: true, allowNull: false },
        company_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: "companies", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        effect: { type: DataTypes.ENUM("grant", "revoke"), allowNull: false },
        created_by: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL",
        },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );
    // Même entreprise que l'appartenance (RB-01) ; supprimée avec elle
    await sql(
      `ALTER TABLE membership_permissions ADD CONSTRAINT membership_permissions_membership_id_same_company_fkey
         FOREIGN KEY (company_id, membership_id) REFERENCES memberships (company_id, id)
         ON UPDATE CASCADE ON DELETE CASCADE;`,
    );

    await queryInterface.addColumn("roles", "description", { type: DataTypes.STRING(255), allowNull: true }, { transaction });

    await sql(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT id, 'roles.manage' FROM roles WHERE code = 'owner' AND is_system
       ON CONFLICT DO NOTHING;
       INSERT INTO role_permissions (role_id, permission)
       SELECT id, 'users.manage' FROM roles WHERE code = 'manager' AND is_system
       ON CONFLICT DO NOTHING;`,
    );
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DELETE FROM role_permissions WHERE permission = 'roles.manage';
       DELETE FROM role_permissions rp USING roles r
       WHERE rp.role_id = r.id AND r.code = 'manager' AND r.is_system AND rp.permission = 'users.manage';`,
      { transaction },
    );
    await queryInterface.removeColumn("roles", "description", { transaction });
    await queryInterface.dropTable("membership_permissions", { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_membership_permissions_effect";', { transaction });
  });
};
