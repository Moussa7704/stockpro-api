import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "./access.service.js";
import { PERMISSIONS, isPermission, type Permission } from "./permissions.js";

/**
 * Règles de délégation des droits. Principe : personne ne peut donner plus de pouvoir qu'il n'en a.
 * - on n'accorde (ou ne retire) que des permissions qu'on possède soi-même ;
 * - on ne gère qu'un membre "inclus" dans ses propres droits : toutes ses permissions et toutes
 *   ses boutiques sont aussi les nôtres (un gérant ne touche ni au propriétaire ni au comptable) ;
 * - on ne donne accès qu'à ses propres boutiques ;
 * - seul un propriétaire attribue le rôle de propriétaire ou modifie un propriétaire ;
 * - le propriétaire a toujours toutes les permissions (ajouts et retraits ne s'appliquent pas à lui).
 * La règle "on ne modifie pas ses propres droits" est vérifiée par les services appelants.
 */

export const OWNER_ROLE_CODE = "owner";

/** Droits effectifs : permissions du rôle + ajouts − retraits (le propriétaire a toujours tout). */
export function effectivePermissions(
  roleCode: string,
  rolePermissions: string[],
  overrides: { permission: string; effect: "grant" | "revoke" }[],
): Set<Permission> {
  if (roleCode === OWNER_ROLE_CODE) {
    return new Set(PERMISSIONS);
  }
  const permissions = new Set(rolePermissions.filter(isPermission));
  for (const override of overrides) {
    if (!isPermission(override.permission)) continue;
    if (override.effect === "grant") permissions.add(override.permission);
    else permissions.delete(override.permission);
  }
  return permissions;
}

/** Pouvoir d'un membre : ce qu'il peut faire et où. */
export interface MemberPower {
  roleCode: string;
  permissions: Set<Permission>;
  allShops: boolean;
  shopIds: string[];
}

const isOwner = (access: CompanyAccess) => access.roleCode === OWNER_ROLE_CODE;

const listOf = (permissions: Iterable<Permission>) => [...permissions].sort().join(", ");

/**
 * Le membre (dans l'état donné) doit être entièrement inclus dans les droits de l'acteur.
 * À vérifier sur l'état AVANT modification (puis-je toucher à ce membre ?) et APRÈS
 * (le résultat reste-t-il dans mes droits ?).
 */
export function assertCanManage(actor: CompanyAccess, target: MemberPower): void {
  if (isOwner(actor)) {
    return;
  }
  if (target.roleCode === OWNER_ROLE_CODE) {
    throw AppError.forbidden("Seul un propriétaire peut attribuer ce rôle ou modifier un propriétaire");
  }
  const missing = [...target.permissions].filter((permission) => !actor.permissions.has(permission));
  if (missing.length > 0) {
    throw AppError.forbidden(`Vous ne pouvez pas donner des droits que vous n'avez pas : ${listOf(missing)}`);
  }
  if (!actor.allShops) {
    if (target.allShops) {
      throw AppError.forbidden("Vous ne pouvez pas donner accès à toutes les boutiques");
    }
    const outside = target.shopIds.filter((shopId) => !actor.shopIds.includes(shopId));
    if (outside.length > 0) {
      throw AppError.forbidden("Vous ne pouvez donner accès qu'à vos propres boutiques");
    }
  }
}

/** Les permissions ajoutées ou retirées doivent toutes appartenir à l'acteur. */
export function assertCanDelegate(actor: CompanyAccess, changed: Iterable<Permission>): void {
  if (isOwner(actor)) {
    return;
  }
  const missing = [...changed].filter((permission) => !actor.permissions.has(permission));
  if (missing.length > 0) {
    throw AppError.forbidden(`Vous ne pouvez pas accorder ou retirer des droits que vous n'avez pas : ${listOf(missing)}`);
  }
}

/** Version booléenne de assertCanManage : pour indiquer au front ce qui est modifiable. */
export function canManage(actor: CompanyAccess, target: MemberPower): boolean {
  try {
    assertCanManage(actor, target);
    return true;
  } catch {
    return false;
  }
}

/** Permissions que l'acteur peut accorder (cases à cocher actives côté front). */
export function grantablePermissions(actor: CompanyAccess): Permission[] {
  return PERMISSIONS.filter((permission) => isOwner(actor) || actor.permissions.has(permission));
}
