import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Membership, MembershipShop, Role, Shop, User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import { SYSTEM_ROLES, type SystemRoleCode } from "../access/permissions.js";
import { findRoleByCode } from "../access/roles.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import * as passwordService from "../auth/password.service.js";
import type { InviteMemberInput, UpdateMemberInput } from "./members.schemas.js";

const MEMBER_INCLUDE = [
  { model: User, as: "user", attributes: ["id", "name", "email", "password"] },
  { model: Role, as: "role", attributes: ["id", "code", "name"] },
  {
    model: Shop,
    as: "shops",
    attributes: ["id", "name", "code"],
    through: { attributes: [] },
  },
];

/** Forme renvoyée au client : jamais le hash du mot de passe, seulement "invitation en attente". */
function toMemberDto(membership: Membership) {
  const user = membership.user!;
  return {
    id: membership.id,
    user: { id: user.id, name: user.name, email: user.email, invitationPending: user.password === null },
    role: { code: membership.role!.code, name: membership.role!.name },
    allShops: membership.allShops,
    shops: (membership.shops ?? []).map((shop) => ({ id: shop.id, name: shop.name, code: shop.code })),
    status: membership.status,
    createdAt: membership.createdAt,
  };
}

/** Résumé pour le journal d'audit. */
function auditSnapshot(membership: Membership, roleCode: string, shopIds: string[]) {
  return { role: roleCode, allShops: membership.allShops, shopIds, status: membership.status };
}

async function findMember(companyId: string, membershipId: string, transaction?: Transaction) {
  // companyId dans le WHERE : un membre d'une autre entreprise donne 404 (RB-01)
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
    include: [{ model: Role, as: "role", where: { code: "owner" }, attributes: [] }],
    transaction,
  });
  if (others === 0) {
    throw AppError.badRequest("L'entreprise doit garder au moins un propriétaire actif");
  }
}

function defaultAllShops(roleCode: string): boolean {
  return SYSTEM_ROLES[roleCode as SystemRoleCode]?.allShopsByDefault ?? false;
}

export async function listMembers(companyId: string) {
  const memberships = await Membership.findAll({
    where: { companyId },
    include: MEMBER_INCLUDE,
    order: [[{ model: User, as: "user" }, "name", "ASC"]],
  });
  return memberships.map(toMemberDto);
}

/**
 * Ajoute une personne à l'entreprise.
 * - compte inexistant : création + invitation à choisir son mot de passe
 * - compte existant (autre entreprise) : simple ajout + email d'accès
 */
export async function inviteMember(access: CompanyAccess, input: InviteMemberInput, actor: AuditActor) {
  const inviter = await User.findByPk(actor.actorUserId ?? "", { attributes: ["name"] });

  const membershipId = await sequelize.transaction(async (transaction) => {
    const role = await findRoleByCode(access.companyId, input.roleCode, transaction);
    const allShops = input.allShops ?? defaultAllShops(role.code);
    const shopIds = allShops ? [] : input.shopIds;
    await assertCompanyShops(access.companyId, shopIds, transaction);

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

  return toMemberDto(await findMember(access.companyId, membershipId));
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
    const membership = await findMember(access.companyId, membershipId, transaction);
    const beforeShopIds = (membership.shops ?? []).map((shop) => shop.id);
    const before = auditSnapshot(membership, membership.role!.code, beforeShopIds);

    const role = input.roleCode
      ? await findRoleByCode(access.companyId, input.roleCode, transaction)
      : membership.role!;
    const allShops = input.allShops ?? membership.allShops;
    const shopIds = allShops ? [] : (input.shopIds ?? beforeShopIds);
    await assertCompanyShops(access.companyId, shopIds, transaction);

    // Retirer le rôle de propriétaire ou désactiver un propriétaire : il doit en rester un autre
    const losesOwnership =
      membership.role!.code === "owner" && (role.code !== "owner" || input.status === "disabled");
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

  return toMemberDto(await findMember(access.companyId, membershipId));
}

/** Renvoie l'invitation d'un membre qui n'a pas encore choisi son mot de passe. */
export async function resendMemberInvitation(access: CompanyAccess, membershipId: string, actor: AuditActor) {
  const membership = await findMember(access.companyId, membershipId);
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
