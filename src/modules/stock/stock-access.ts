import type { Transaction } from "sequelize";
import { Shop } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { canAccessShop, type CompanyAccess } from "../access/access.service.js";

/** Les coûts (CMP, valeur du stock) révèlent la marge : réservés à ceux qui la gèrent. */
export function canSeeCosts(access: CompanyAccess): boolean {
  return access.permissions.has("reports.view") || access.permissions.has("stock.adjust");
}

/**
 * Boutique où l'utilisateur peut agir : de l'entreprise, dans son périmètre, non archivée.
 * Hors périmètre ou autre entreprise : 404, comme si elle n'existait pas (RB-01).
 */
export async function findOperableShop(
  access: CompanyAccess,
  shopId: string,
  transaction?: Transaction,
): Promise<Shop> {
  const shop = await Shop.findOne({ where: { id: shopId, companyId: access.companyId }, transaction });
  if (!shop || !canAccessShop(access, shop.id)) {
    throw AppError.notFound("Boutique introuvable");
  }
  if (shop.archivedAt) {
    throw AppError.badRequest("Cette boutique est archivée");
  }
  return shop;
}

/** Boutique de l'entreprise (même hors périmètre) : ex. destination d'un transfert. */
export async function findCompanyShop(access: CompanyAccess, shopId: string, transaction?: Transaction): Promise<Shop> {
  const shop = await Shop.findOne({ where: { id: shopId, companyId: access.companyId }, transaction });
  if (!shop) {
    throw AppError.notFound("Boutique introuvable");
  }
  if (shop.archivedAt) {
    throw AppError.badRequest("Cette boutique est archivée");
  }
  return shop;
}

/**
 * Filtre SQL des boutiques visibles : null = toutes (accès à toute l'entreprise),
 * sinon la liste (éventuellement vide) des boutiques autorisées.
 * Une boutique demandée explicitement est vérifiée en base : une boutique d'une autre
 * entreprise donne 404 même pour un propriétaire qui voit "toutes" ses boutiques (RB-01).
 */
export async function visibleShopIds(access: CompanyAccess, requestedShopId?: string): Promise<string[] | null> {
  if (requestedShopId) {
    const shop = await Shop.findOne({ where: { id: requestedShopId, companyId: access.companyId }, attributes: ["id"] });
    if (!shop || !canAccessShop(access, shop.id)) {
      throw AppError.notFound("Boutique introuvable");
    }
    return [shop.id];
  }
  return access.allShops ? null : access.shopIds;
}
