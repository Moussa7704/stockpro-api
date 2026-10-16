import type { Transaction } from "sequelize";
import { Company, Membership, MembershipPermission, Role, RolePermission, Shop } from "../../models/index.js";
import { effectivePermissions } from "./delegation.js";
import type { Permission } from "./permissions.js";

/**
 * Droits d'un utilisateur dans son entreprise active, relus en base à chaque requête.
 * Sert de base à toutes les vérifications d'accès (RB-01, RB-07).
 */
export interface CompanyAccess {
  companyId: string;
  companyName: string;
  currency: string; // ex. XOF : fixe le nombre de décimales des montants
  membershipId: string;
  roleCode: string;
  roleName: string;
  permissions: Set<Permission>;
  allShops: boolean;
  // Boutiques autorisées (non archivées) quand allShops = false
  shopIds: string[];
}

export interface CompanySummary {
  id: string;
  name: string;
  slug: string;
  role: { code: string; name: string };
}

/** null si l'utilisateur n'a pas (ou plus) accès à cette entreprise : appartenance ou entreprise désactivée. */
export async function loadCompanyAccess(
  userId: string,
  companyId: string,
  transaction?: Transaction,
): Promise<CompanyAccess | null> {
  const membership = await Membership.findOne({
    where: { userId, companyId, status: "active" },
    include: [
      {
        model: Company,
        as: "company",
        where: { status: "active" },
        attributes: ["id", "name", "currency"],
      },
      {
        model: Role,
        as: "role",
        attributes: ["code", "name"],
        include: [{ model: RolePermission, as: "permissions", attributes: ["permission"] }],
      },
      {
        model: Shop,
        as: "shops",
        attributes: ["id"],
        where: { archivedAt: null },
        through: { attributes: [] },
        required: false,
      },
      { model: MembershipPermission, as: "permissionOverrides", attributes: ["permission", "effect"] },
    ],
    transaction,
  });

  if (!membership?.company || !membership.role) {
    return null;
  }

  return {
    companyId,
    companyName: membership.company.name,
    currency: membership.company.currency,
    membershipId: membership.id,
    roleCode: membership.role.code,
    roleName: membership.role.name,
    // Rôle + permissions ajoutées − permissions retirées à ce membre
    permissions: effectivePermissions(
      membership.role.code,
      (membership.role.permissions ?? []).map((item) => item.permission),
      membership.permissionOverrides ?? [],
    ),
    allShops: membership.allShops,
    shopIds: (membership.shops ?? []).map((shop) => shop.id),
  };
}

/** Entreprises (actives) auxquelles l'utilisateur a accès, pour le sélecteur d'entreprise. */
export async function listUserCompanies(userId: string): Promise<CompanySummary[]> {
  const memberships = await Membership.findAll({
    where: { userId, status: "active" },
    include: [
      { model: Company, as: "company", where: { status: "active" }, attributes: ["id", "name", "slug"] },
      { model: Role, as: "role", attributes: ["code", "name"] },
    ],
    order: [[{ model: Company, as: "company" }, "name", "ASC"]],
  });

  return memberships.map((membership) => ({
    id: membership.company!.id,
    name: membership.company!.name,
    slug: membership.company!.slug,
    role: { code: membership.role!.code, name: membership.role!.name },
  }));
}

/** Entreprise choisie automatiquement à la connexion : seulement s'il n'y en a qu'une. */
export async function defaultCompanyId(userId: string): Promise<string | null> {
  const companies = await listUserCompanies(userId);
  return companies.length === 1 ? companies[0]!.id : null;
}

export function canAccessShop(access: CompanyAccess, shopId: string): boolean {
  return access.allShops || access.shopIds.includes(shopId);
}
