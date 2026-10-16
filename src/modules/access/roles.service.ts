import { Op, UniqueConstraintError, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Membership, Role, RolePermission } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import type { CompanyAccess } from "./access.service.js";
import { OWNER_ROLE_CODE, assertCanDelegate } from "./delegation.js";
import { PERMISSION_GROUPS, SYSTEM_ROLES, SYSTEM_ROLE_CODES, isPermission, type Permission, type SystemRoleCode } from "./permissions.js";
import type { CreateRoleInput, UpdateRoleInput } from "./roles.schemas.js";

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

const permissionsOf = (role: Role) => (role.permissions ?? []).map((item) => item.permission).filter(isPermission).sort();

/** Un non-propriétaire ne touche qu'aux rôles entièrement inclus dans ses propres droits. */
function canEditRole(access: CompanyAccess, role: Role): boolean {
  if (role.code === OWNER_ROLE_CODE) return false;
  if (access.roleCode === OWNER_ROLE_CODE) return true;
  return permissionsOf(role).every((permission) => access.permissions.has(permission));
}

export async function listRoles(access: CompanyAccess) {
  const roles = await Role.findAll({
    where: { companyId: access.companyId },
    include: [{ model: RolePermission, as: "permissions", attributes: ["permission"] }],
    order: [
      ["isSystem", "DESC"],
      ["name", "ASC"],
    ],
  });
  const counts = await Membership.count({
    where: { companyId: access.companyId, roleId: { [Op.in]: roles.map((role) => role.id) } },
    group: ["roleId"],
  });
  const memberCount = new Map(counts.map((row) => [row.roleId as string, Number(row.count)]));

  return roles.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: permissionsOf(role),
    memberCount: memberCount.get(role.id) ?? 0,
    // Modifiable par l'utilisateur connecté (le rôle propriétaire ne l'est jamais)
    editable: access.permissions.has("roles.manage") && canEditRole(access, role),
  }));
}

/** Catalogue des permissions, groupées et libellées, pour construire les cases à cocher. */
export function permissionCatalog() {
  return PERMISSION_GROUPS;
}

/** "Vendeur senior" → "vendeur_senior" ; jamais un code de rôle système. */
function roleCodeFrom(name: string): string {
  const code = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return code.length >= 2 ? code : "role";
}

async function availableRoleCode(companyId: string, name: string, transaction: Transaction): Promise<string> {
  const base = roleCodeFrom(name);
  for (let suffix = 1; suffix < 100; suffix++) {
    const code = suffix === 1 ? base : `${base}_${suffix}`;
    const reserved = (SYSTEM_ROLE_CODES as readonly string[]).includes(code);
    if (!reserved && !(await Role.findOne({ where: { companyId, code }, attributes: ["id"], transaction }))) {
      return code;
    }
  }
  throw AppError.conflict("Choisissez un autre nom de rôle");
}

async function findCompanyRole(companyId: string, id: string, transaction?: Transaction, lock = false) {
  if (lock && transaction) {
    // Verrou sur la ligne seule (FOR UPDATE est interdit avec la jointure externe des permissions)
    await Role.findOne({ where: { id, companyId }, attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE });
  }
  const role = await Role.findOne({
    where: { id, companyId },
    include: [{ model: RolePermission, as: "permissions", attributes: ["permission"] }],
    transaction,
  });
  if (!role) {
    throw AppError.notFound("Rôle introuvable");
  }
  return role;
}

async function setRolePermissions(role: Role, permissions: Permission[], transaction: Transaction) {
  await RolePermission.destroy({ where: { roleId: role.id }, transaction });
  await RolePermission.bulkCreate(
    permissions.map((permission) => ({ roleId: role.id, permission })),
    { transaction },
  );
}

const DUPLICATE_NAME = "Un rôle porte déjà ce nom";

async function assertNameAvailable(companyId: string, name: string, exceptId: string | null, transaction: Transaction) {
  const existing = await Role.findOne({
    where: {
      companyId,
      ...(exceptId && { id: { [Op.ne]: exceptId } }),
      [Op.and]: [sequelize.where(sequelize.fn("lower", sequelize.col("name")), name.toLowerCase())],
    },
    attributes: ["id"],
    transaction,
  });
  if (existing) {
    throw AppError.conflict(DUPLICATE_NAME);
  }
}

/** Rôle personnalisé : un nom et des permissions cochées, jamais au-delà des droits du créateur. */
export async function createRole(access: CompanyAccess, input: CreateRoleInput, actor: AuditActor) {
  assertCanDelegate(access, input.permissions);
  try {
    const id = await sequelize.transaction(async (transaction) => {
      await assertNameAvailable(access.companyId, input.name, null, transaction);
      const role = await Role.create(
        {
          companyId: access.companyId,
          code: await availableRoleCode(access.companyId, input.name, transaction),
          name: input.name,
          description: input.description ?? null,
          isSystem: false,
        },
        { transaction },
      );
      await setRolePermissions(role, input.permissions, transaction);
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "role.create",
          entityType: "role",
          entityId: role.id,
          after: { code: role.code, name: role.name, permissions: [...input.permissions].sort() },
        },
        transaction,
      );
      return role.id;
    });
    return (await listRoles(access)).find((role) => role.id === id)!;
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw AppError.conflict(DUPLICATE_NAME);
    throw error;
  }
}

/**
 * Modifie un rôle (système ou personnalisé, jamais celui de propriétaire). Les nouveaux droits
 * s'appliquent immédiatement à tous les membres qui ont ce rôle.
 */
export async function updateRole(access: CompanyAccess, id: string, input: UpdateRoleInput, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const role = await findCompanyRole(access.companyId, id, transaction, true);
    if (role.code === OWNER_ROLE_CODE) {
      throw AppError.badRequest("Le rôle de propriétaire a toujours toutes les permissions : il n'est pas modifiable");
    }
    if (!canEditRole(access, role)) {
      throw AppError.forbidden("Ce rôle a des droits que vous n'avez pas : vous ne pouvez pas le modifier");
    }
    const before = { name: role.name, description: role.description, permissions: permissionsOf(role) };

    if (input.permissions) {
      // Seules les permissions ajoutées ou retirées doivent appartenir à l'acteur
      const changed = [
        ...input.permissions.filter((permission) => !before.permissions.includes(permission)),
        ...before.permissions.filter((permission) => !input.permissions!.includes(permission)),
      ];
      assertCanDelegate(access, changed);
      await setRolePermissions(role, input.permissions, transaction);
    }
    if (input.name !== undefined) {
      await assertNameAvailable(access.companyId, input.name, role.id, transaction);
    }
    await role.update(
      {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
      },
      { transaction },
    );

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "role.update",
        entityType: "role",
        entityId: role.id,
        before,
        after: {
          name: role.name,
          description: role.description,
          permissions: input.permissions ? [...input.permissions].sort() : before.permissions,
        },
      },
      transaction,
    );
  });
  return (await listRoles(access)).find((role) => role.id === id)!;
}

/** Supprime un rôle personnalisé que plus personne n'utilise. */
export async function deleteRole(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const role = await findCompanyRole(access.companyId, id, transaction, true);
    if (role.isSystem) {
      throw AppError.badRequest("Les rôles de base ne peuvent pas être supprimés");
    }
    if (!canEditRole(access, role)) {
      throw AppError.forbidden("Ce rôle a des droits que vous n'avez pas : vous ne pouvez pas le supprimer");
    }
    const members = await Membership.count({ where: { companyId: access.companyId, roleId: role.id }, transaction });
    if (members > 0) {
      throw AppError.conflict(`Ce rôle est attribué à ${members} membre(s) : changez d'abord leur rôle`);
    }
    await RolePermission.destroy({ where: { roleId: role.id }, transaction });
    await role.destroy({ transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "role.delete",
        entityType: "role",
        entityId: role.id,
        before: { code: role.code, name: role.name, permissions: permissionsOf(role) },
      },
      transaction,
    );
  });
}
