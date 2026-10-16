import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Membership, MembershipPermission, MembershipShop, Role, RolePermission, Shop, User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import {
  OWNER_ROLE_CODE,
  assertCanDelegate,
  assertCanManage,
  canManage,
  effectivePermissions,
  grantablePermissions,
  type MemberPower,
} from "../access/delegation.js";
import { SYSTEM_ROLES, isPermission, type Permission, type SystemRoleCode } from "../access/permissions.js";
import { findRoleByCode } from "../access/roles.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import * as passwordService from "../auth/password.service.js";
import type { InviteMemberInput, SetMemberPermissionsInput, UpdateMemberInput } from "./members.schemas.js";

const MEMBER_INCLUDE = [
  { model: User, as: "user", attributes: ["id", "name", "email", "password"] },
  {
    model: Role,
    as: "role",
    attributes: ["id", "code", "name"],
    include: [{ model: RolePermission, as: "permissions", attributes: ["permission"] }],
  },
  {
    model: Shop,
    as: "shops",
    attributes: ["id", "name", "code", "archivedAt"],
    through: { attributes: [] },
  },
  { model: MembershipPermission, as: "permissionOverrides", attributes: ["permission", "effect"] },
];

const sorted = (permissions: Iterable<string>) => [...permissions].sort();
const rolePermissionsOf = (role: Role) => (role.permissions ?? []).map((item) => item.permission);

function overridesOf(membership: Membership) {
  const overrides = membership.permissionOverrides ?? [];
  return {
    grants: sorted(overrides.filter((item) => item.effect === "grant").map((item) => item.permission)),
    revokes: sorted(overrides.filter((item) => item.effect === "revoke").map((item) => item.permission)),
  };
}

/** Pouvoir d'un membre (rôle, ajouts/retraits, boutiques actives) pour les règles de délégation. */
function powerOf(
  role: Role,
  overrides: { permission: string; effect: "grant" | "revoke" }[],
  allShops: boolean,
  shopIds: string[],
): MemberPower {
  return {
    roleCode: role.code,
    permissions: effectivePermissions(role.code, rolePermissionsOf(role), overrides),
    allShops,
    shopIds,
  };
}

const activeShopIds = (membership: Membership) =>
  (membership.shops ?? []).filter((shop) => !shop.archivedAt).map((shop) => shop.id);

const currentPower = (membership: Membership) =>
  powerOf(membership.role!, membership.permissionOverrides ?? [], membership.allShops, activeShopIds(membership));

/** Forme renvoyée au client : jamais le hash du mot de passe, seulement "invitation en attente". */
function toMemberDto(membership: Membership, actor: CompanyAccess) {
  const user = membership.user!;
  const power = currentPower(membership);
  return {
    id: membership.id,
    user: { id: user.id, name: user.name, email: user.email, invitationPending: user.password === null },
    role: { code: membership.role!.code, name: membership.role!.name },
    allShops: membership.allShops,
    shops: (membership.shops ?? []).map((shop) => ({ id: shop.id, name: shop.name, code: shop.code })),
    status: membership.status,
    // Ajustements propres à ce membre, et droits qui en résultent
    permissionOverrides: overridesOf(membership),
    permissions: sorted(power.permissions),
    // L'utilisateur connecté peut-il modifier ce membre ? (jamais lui-même)
    editable: membership.id !== actor.membershipId && canManage(actor, power),
    createdAt: membership.createdAt,
  };
}

/** Résumé pour le journal d'audit. */
function auditSnapshot(membership: Membership, roleCode: string, shopIds: string[]) {
  return { role: roleCode, allShops: membership.allShops, shopIds, status: membership.status };
}

async function findMember(companyId: string, membershipId: string, transaction?: Transaction, lock = false) {
  // companyId dans le WHERE : un membre d'une autre entreprise donne 404 (RB-01)
  if (lock && transaction) {
    // Verrou sur la ligne seule (FOR UPDATE est interdit avec les jointures externes de l'include)
    await Membership.findOne({ where: { id: membershipId, companyId }, attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE });
  }
  const membership = await Membership.findOne({
    where: { id: membershipId, companyId },
    include: MEMBER_INCLUDE,
    transaction,
  });
  if (!membership) {
    throw AppError.notFound("Membre introuvable");
  }
  return membership;
}

/** Les boutiques doivent toutes appartenir à l'entreprise et être actives. */
async function assertCompanyShops(companyId: string, shopIds: string[], transaction: Transaction) {
  if (shopIds.length === 0) {
    return;
  }
  const count = await Shop.count({
    where: { companyId, id: { [Op.in]: shopIds }, archivedAt: null },
    transaction,
  });
  if (count !== shopIds.length) {
    throw AppError.badRequest("Boutique inconnue ou archivée");
  }
}

async function setMemberShops(membership: Membership, shopIds: string[], transaction: Transaction) {
  await MembershipShop.destroy({ where: { membershipId: membership.id }, transaction });
  await MembershipShop.bulkCreate(
    shopIds.map((shopId) => ({ membershipId: membership.id, shopId, companyId: membership.companyId })),
    { transaction },
  );
}

/** Il doit toujours rester au moins un propriétaire actif dans l'entreprise. */
async function assertAnotherActiveOwner(membership: Membership, transaction: Transaction) {
  const others = await Membership.count({
    where: { companyId: membership.companyId, status: "active", id: { [Op.ne]: membership.id } },
    include: [{ model: Role, as: "role", where: { code: OWNER_ROLE_CODE }, attributes: [] }],
    transaction,
  });
  if (others === 0) {
    throw AppError.badRequest("L'entreprise doit garder au moins un propriétaire actif");
  }
}

function defaultAllShops(roleCode: string): boolean {
  return SYSTEM_ROLES[roleCode as SystemRoleCode]?.allShopsByDefault ?? false;
}

/** Rôle avec ses permissions (pour calculer le pouvoir qu'il confère). */
async function findRoleWithPermissions(companyId: string, code: string, transaction: Transaction) {
  const role = await findRoleByCode(companyId, code, transaction);
  await role.reload({ include: [{ model: RolePermission, as: "permissions", attributes: ["permission"] }], transaction });
  return role;
}

export async function listMembers(access: CompanyAccess) {
  const memberships = await Membership.findAll({
    where: { companyId: access.companyId },
    include: MEMBER_INCLUDE,
    order: [[{ model: User, as: "user" }, "name", "ASC"]],
  });
  return memberships.map((membership) => toMemberDto(membership, access));
}

/**
 * Ajoute une personne à l'entreprise.
 * - compte inexistant : création + invitation à choisir son mot de passe
 * - compte existant (autre entreprise) : simple ajout + email d'accès
 * Délégation : le rôle et les boutiques attribués doivent rester dans les droits de l'inviteur.
 */
export async function inviteMember(access: CompanyAccess, input: InviteMemberInput, actor: AuditActor) {
  const inviter = await User.findByPk(actor.actorUserId ?? "", { attributes: ["name"] });

  const membershipId = await sequelize.transaction(async (transaction) => {
    const role = await findRoleWithPermissions(access.companyId, input.roleCode, transaction);
    const allShops = input.allShops ?? (defaultAllShops(role.code) && access.allShops);
    const shopIds = allShops ? [] : input.shopIds;
    await assertCompanyShops(access.companyId, shopIds, transaction);
    assertCanManage(access, powerOf(role, [], allShops, shopIds));

    let user = await User.findOne({ where: { email: input.email }, transaction });
    const isNewUser = !user;
    user ??= await User.create({ name: input.name, email: input.email }, { transaction });

    const existing = await Membership.findOne({
      where: { companyId: access.companyId, userId: user.id },
      transaction,
    });
    if (existing) {
      throw AppError.conflict("Cette personne fait déjà partie de l'entreprise");
    }

    const membership = await Membership.create(
      { companyId: access.companyId, userId: user.id, roleId: role.id, allShops },
      { transaction },
    );
    await setMemberShops(membership, shopIds, transaction);

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "member.invite",
        entityType: "membership",
        entityId: membership.id,
        after: { email: user.email, ...auditSnapshot(membership, role.code, shopIds) },
      },
      transaction,
    );

    // Dans la transaction : si l'email ne part pas, l'ajout est annulé
    const sender = { invitedBy: inviter?.name ?? "Un administrateur", companyName: access.companyName };
    if (isNewUser || user.password === null) {
      await passwordService.sendInvitation(user, sender, transaction);
    } else {
      await passwordService.notifyCompanyAccess(user, sender);
    }

    return membership.id;
  });

  return toMemberDto(await findMember(access.companyId, membershipId), access);
}

export async function updateMember(
  access: CompanyAccess,
  membershipId: string,
  input: UpdateMemberInput,
  actor: AuditActor,
) {
  // On ne modifie pas ses propres droits (ni se désactiver, ni se retirer le rôle de propriétaire)
  if (membershipId === access.membershipId) {
    throw AppError.badRequest("Vous ne pouvez pas modifier vos propres droits");
  }

  await sequelize.transaction(async (transaction) => {
    const membership = await findMember(access.companyId, membershipId, transaction, true);
    // Puis-je toucher à ce membre ?
    assertCanManage(access, currentPower(membership));

    const beforeShopIds = (membership.shops ?? []).map((shop) => shop.id);
    const before = auditSnapshot(membership, membership.role!.code, beforeShopIds);

    const role = input.roleCode
      ? await findRoleWithPermissions(access.companyId, input.roleCode, transaction)
      : membership.role!;
    const allShops = input.allShops ?? membership.allShops;
    const shopIds = allShops ? [] : (input.shopIds ?? beforeShopIds);
    await assertCompanyShops(access.companyId, shopIds, transaction);
    // Le résultat reste-t-il dans mes droits ?
    assertCanManage(access, powerOf(role, membership.permissionOverrides ?? [], allShops, shopIds));

    // Retirer le rôle de propriétaire ou désactiver un propriétaire : il doit en rester un autre
    const losesOwnership =
      membership.role!.code === OWNER_ROLE_CODE && (role.code !== OWNER_ROLE_CODE || input.status === "disabled");
    if (losesOwnership && membership.status === "active") {
      await assertAnotherActiveOwner(membership, transaction);
    }

    await membership.update(
      { roleId: role.id, allShops, ...(input.status && { status: input.status }) },
      { transaction },
    );
    await setMemberShops(membership, shopIds, transaction);

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: input.status === "disabled" && before.status === "active" ? "member.disable" : "member.update",
        entityType: "membership",
        entityId: membership.id,
        before,
        after: auditSnapshot(membership, role.code, shopIds),
      },
      transaction,
    );
  });

  return toMemberDto(await findMember(access.companyId, membershipId), access);
}

/** Détail des droits d'un membre, pour l'écran "permissions" (cases à cocher). */
export async function getMemberPermissions(access: CompanyAccess, membershipId: string) {
  const membership = await findMember(access.companyId, membershipId);
  const power = currentPower(membership);
  return {
    memberId: membership.id,
    role: { code: membership.role!.code, name: membership.role!.name, permissions: sorted(rolePermissionsOf(membership.role!)) },
    ...overridesOf(membership),
    permissions: sorted(power.permissions),
    editable:
      membership.id !== access.membershipId && membership.role!.code !== OWNER_ROLE_CODE && canManage(access, power),
    // Ce que l'utilisateur connecté a le droit d'accorder ou de retirer
    grantable: grantablePermissions(access),
  };
}

/**
 * Remplace les ajustements de droits d'un membre (ajouts et retraits par rapport à son rôle).
 * Ex. un gérant accorde la caisse (sales.create, cash_sessions.manage) à un gestionnaire de stock.
 */
export async function setMemberPermissions(
  access: CompanyAccess,
  membershipId: string,
  input: SetMemberPermissionsInput,
  actor: AuditActor,
) {
  if (membershipId === access.membershipId) {
    throw AppError.badRequest("Vous ne pouvez pas modifier vos propres droits");
  }

  await sequelize.transaction(async (transaction) => {
    const membership = await findMember(access.companyId, membershipId, transaction, true);
    if (membership.role!.code === OWNER_ROLE_CODE) {
      throw AppError.badRequest("Le propriétaire a toujours toutes les permissions");
    }
    assertCanManage(access, currentPower(membership));

    // Ajouter ce que le rôle donne déjà, ou retirer ce qu'il ne donne pas, n'a pas de sens : ignoré
    const rolePermissions = new Set(rolePermissionsOf(membership.role!));
    const grants = input.grants.filter((permission) => !rolePermissions.has(permission));
    const revokes = input.revokes.filter((permission) => rolePermissions.has(permission));

    // Seules les permissions dont l'état change doivent appartenir à l'acteur
    const before = overridesOf(membership);
    const changed = new Set<Permission>();
    const symmetricDifference = (a: string[], b: string[]) => [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))];
    for (const permission of [...symmetricDifference(before.grants, grants), ...symmetricDifference(before.revokes, revokes)]) {
      if (isPermission(permission)) changed.add(permission);
    }
    assertCanDelegate(access, changed);

    const overrides = [
      ...grants.map((permission) => ({ permission, effect: "grant" as const })),
      ...revokes.map((permission) => ({ permission, effect: "revoke" as const })),
    ];
    assertCanManage(access, powerOf(membership.role!, overrides, membership.allShops, activeShopIds(membership)));

    await MembershipPermission.destroy({ where: { membershipId: membership.id }, transaction });
    await MembershipPermission.bulkCreate(
      overrides.map((override) => ({
        ...override,
        membershipId: membership.id,
        companyId: access.companyId,
        createdBy: actor.actorUserId,
      })),
      { transaction },
    );

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "member.permissions_update",
        entityType: "membership",
        entityId: membership.id,
        before,
        after: { grants: sorted(grants), revokes: sorted(revokes) },
      },
      transaction,
    );
  });

  return getMemberPermissions(access, membershipId);
}

/** Renvoie l'invitation d'un membre qui n'a pas encore choisi son mot de passe. */
export async function resendMemberInvitation(access: CompanyAccess, membershipId: string, actor: AuditActor) {
  const membership = await findMember(access.companyId, membershipId);
  assertCanManage(access, currentPower(membership));
  const user = await User.findByPk(membership.userId);
  if (!user || user.password !== null) {
    throw AppError.conflict("Ce compte est déjà activé");
  }

  const inviter = await User.findByPk(actor.actorUserId ?? "", { attributes: ["name"] });
  await passwordService.sendInvitation(user, {
    invitedBy: inviter?.name ?? "Un administrateur",
    companyName: access.companyName,
  });
}
