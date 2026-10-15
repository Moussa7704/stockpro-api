import type { Transaction } from "sequelize";
import { Role, RolePermission } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { SYSTEM_ROLES, SYSTEM_ROLE_CODES, type SystemRoleCode } from "./permissions.js";

/** Crée les rôles système (propriétaire, gérant…) et leurs permissions pour une nouvelle entreprise. */
export async function createSystemRoles(
  companyId: string,
  transaction: Transaction,
): Promise<Record<SystemRoleCode, Role>> {
  const roles = {} as Record<SystemRoleCode, Role>;

  for (const code of SYSTEM_ROLE_CODES) {
    const definition = SYSTEM_ROLES[code];
    const role = await Role.create(
      { companyId, code, name: definition.name, isSystem: true },
      { transaction },
    );
    await RolePermission.bulkCreate(
      definition.permissions.map((permission) => ({ roleId: role.id, permission })),
      { transaction },
    );
    roles[code] = role;
  }

  return roles;
}

/** Rôle de l'entreprise par son code ; 400 s'il n'existe pas (dans CETTE entreprise). */
export async function findRoleByCode(
  companyId: string,
  code: string,
  transaction?: Transaction,
): Promise<Role> {
  const role = await Role.findOne({ where: { companyId, code }, transaction });
  if (!role) {
    throw AppError.badRequest(`Rôle inconnu : ${code}`);
  }
  return role;
}

export async function listRoles(companyId: string) {
  const roles = await Role.findAll({
    where: { companyId },
    include: [{ model: RolePermission, as: "permissions", attributes: ["permission"] }],
    order: [["name", "ASC"]],
  });

  return roles.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    isSystem: role.isSystem,
    permissions: (role.permissions ?? []).map((item) => item.permission).sort(),
  }));
}
