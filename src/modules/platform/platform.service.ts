import { Op, UniqueConstraintError, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Company, Membership, Role, Shop, User } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { createSystemRoles } from "../access/roles.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import { createDefaultUnits } from "../catalog/units.service.js";
import { createDefaultExpenseCategories } from "../expenses/expenses.service.js";
import { createDefaultPaymentMethods } from "../pos/payment-methods.service.js";
import * as passwordService from "../auth/password.service.js";
import type { CreateCompanyInput, UpdateCompanyInput } from "./platform.schemas.js";

const COMPANY_AUDIT_FIELDS: (keyof Company)[] = ["name", "slug", "currency", "timezone", "status"];

// "Boutique Chez Awa & Fils" → "boutique-chez-awa-fils"
function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug.length >= 2 ? slug : "entreprise";
}

/** Premier slug libre : nom, nom-2, nom-3… */
async function availableSlug(base: string, transaction: Transaction): Promise<string> {
  const taken = new Set(
    (
      await Company.findAll({
        where: { slug: { [Op.or]: [base, { [Op.like]: `${base}-%` }] } },
        attributes: ["slug"],
        transaction,
      })
    ).map((company) => company.slug),
  );
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix++) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export async function listCompanies() {
  const companies = await Company.findAll({ order: [["createdAt", "DESC"]] });
  const counts = await Membership.count({
    where: { companyId: companies.map((company) => company.id), status: "active" },
    group: ["company_id"],
  });
  const membersByCompany = new Map(counts.map((row) => [String(row.company_id), Number(row.count)]));

  return companies.map((company) => ({
    ...company.toJSON(),
    activeMembers: membersByCompany.get(company.id) ?? 0,
  }));
}

type MemberRow = Membership & { user: User; role: Role };

/** Membres d'un commerçant, du plus ancien au plus récent ; jamais le hash du mot de passe. */
async function companyMembers(companyId: string, transaction?: Transaction) {
  const memberships = (await Membership.findAll({
    where: { companyId },
    include: [
      { model: User, as: "user", attributes: ["id", "name", "email", "password"] },
      { model: Role, as: "role", attributes: ["code", "name"] },
    ],
    order: [["createdAt", "ASC"]],
    transaction,
  })) as MemberRow[];
  return memberships.map((membership) => ({
    membershipId: membership.id,
    status: membership.status,
    role: { code: membership.role.code, name: membership.role.name },
    user: {
      id: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      // Compte pas encore activé : le mot de passe n'a jamais été choisi
      invitationPending: membership.user.password === null,
    },
  }));
}

/** Fiche d'un commerçant : boutiques, membres et propriétaire (le premier propriétaire actif). */
export async function getCompany(id: string) {
  const company = await Company.findByPk(id, {
    include: [{ model: Shop, as: "shops", attributes: ["id", "name", "code", "archivedAt"] }],
  });
  if (!company) {
    throw AppError.notFound("Entreprise introuvable");
  }
  const members = await companyMembers(id);
  const owner = members.find((member) => member.role.code === "owner" && member.status === "active");
  return { ...company.toJSON(), members, owner: owner?.user ?? null };
}

/**
 * Renvoie l'invitation du propriétaire qui n'a pas encore choisi son mot de passe (email perdu,
 * lien expiré). Un nouveau lien remplace l'ancien.
 */
export async function resendOwnerInvitation(id: string, actor: AuditActor) {
  const company = await Company.findByPk(id);
  if (!company) {
    throw AppError.notFound("Entreprise introuvable");
  }
  if (company.status !== "active") {
    throw AppError.conflict("Commerçant suspendu : réactivez-le avant de renvoyer l'invitation");
  }
  const owner = (await companyMembers(id)).find((member) => member.role.code === "owner" && member.status === "active");
  if (!owner) {
    throw AppError.notFound("Ce commerçant n'a pas de propriétaire actif");
  }
  if (!owner.user.invitationPending) {
    throw AppError.conflict("Le propriétaire a déjà activé son compte");
  }

  const user = (await User.findByPk(owner.user.id))!;
  await sequelize.transaction(async (transaction) => {
    await recordAudit(
      {
        ...actor,
        companyId: company.id,
        action: "company.owner_invite",
        entityType: "company",
        entityId: company.id,
        after: { owner: user.email },
      },
      transaction,
    );
    // Dans la transaction : si l'email ne part pas, ni lien ni trace d'audit
    await passwordService.sendInvitation(user, { invitedBy: "StockPro", companyName: company.name }, transaction);
  });
  return { sentTo: user.email };
}

/**
 * Crée un commerçant : entreprise + rôles système + première boutique + propriétaire.
 * Le propriétaire reçoit une invitation (compte neuf) ou un email d'accès (compte existant).
 * Tout est dans une transaction : si l'email ne part pas, rien n'est créé.
 */
export async function createCompany(input: CreateCompanyInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const slug = input.slug ?? (await availableSlug(slugify(input.name), transaction));
      const company = await Company.create(
        { name: input.name, slug, currency: input.currency, timezone: input.timezone },
        { transaction },
      );

      const roles = await createSystemRoles(company.id, transaction);
      await createDefaultUnits(company.id, transaction);
      await createDefaultPaymentMethods(company.id, transaction);
      await createDefaultExpenseCategories(company.id, transaction);
      const shop = await Shop.create(
        { companyId: company.id, name: input.shopName, code: "BTQ1" },
        { transaction },
      );

      // Un utilisateur peut déjà exister (membre d'une autre entreprise) : on le réutilise
      let owner = await User.findOne({ where: { email: input.owner.email }, transaction });
      const isNewUser = !owner;
      owner ??= await User.create({ name: input.owner.name, email: input.owner.email }, { transaction });

      await Membership.create(
        { companyId: company.id, userId: owner.id, roleId: roles.owner.id, allShops: true },
        { transaction },
      );

      await recordAudit(
        {
          ...actor,
          companyId: company.id,
          action: "company.create",
          entityType: "company",
          entityId: company.id,
          after: { ...pick(company, COMPANY_AUDIT_FIELDS), owner: owner.email, shop: shop.code },
        },
        transaction,
      );

      const sender = { invitedBy: "StockPro", companyName: company.name };
      if (isNewUser || owner.password === null) {
        await passwordService.sendInvitation(owner, sender, transaction);
      } else {
        await passwordService.notifyCompanyAccess(owner, sender);
      }

      return { company, shop, owner };
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw AppError.conflict("Cet identifiant d'entreprise (slug) est déjà utilisé");
    }
    throw error;
  }
}

/** Renommer ou suspendre un commerçant. Suspendu : plus aucun membre ne peut y accéder. */
export async function updateCompany(id: string, input: UpdateCompanyInput, actor: AuditActor) {
  return sequelize.transaction(async (transaction) => {
    const company = await Company.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!company) {
      throw AppError.notFound("Entreprise introuvable");
    }

    const before = pick(company, COMPANY_AUDIT_FIELDS);
    await company.update(input, { transaction });

    await recordAudit(
      {
        ...actor,
        companyId: company.id,
        action: input.status && input.status !== before.status ? `company.${input.status === "suspended" ? "suspend" : "reactivate"}` : "company.update",
        entityType: "company",
        entityId: company.id,
        before,
        after: pick(company, COMPANY_AUDIT_FIELDS),
      },
      transaction,
    );

    return company;
  });
}
