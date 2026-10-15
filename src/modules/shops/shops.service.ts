import { Op, UniqueConstraintError } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Shop } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { canAccessShop, type CompanyAccess } from "../access/access.service.js";
import { pick, recordAudit, type AuditActor } from "../audit/audit.service.js";
import type { CreateShopInput, UpdateShopInput } from "./shops.schemas.js";

const AUDIT_FIELDS: (keyof Shop)[] = ["name", "code", "address", "phone", "archivedAt"];

/**
 * Boutique de l'entreprise active, visible par l'utilisateur.
 * Une boutique d'une autre entreprise (ou hors de son périmètre) donne 404 :
 * on ne révèle pas qu'elle existe (RB-01).
 */
export async function findAccessibleShop(access: CompanyAccess, id: string): Promise<Shop> {
  const shop = await Shop.findOne({ where: { id, companyId: access.companyId } });
  if (!shop || !canAccessShop(access, shop.id)) {
    throw AppError.notFound("Boutique introuvable");
  }
  return shop;
}

export async function listShops(access: CompanyAccess, includeArchived: boolean): Promise<Shop[]> {
  return Shop.findAll({
    where: {
      companyId: access.companyId,
      // Les archivées ne sont visibles que de ceux qui gèrent l'entreprise
      ...(!(includeArchived && access.permissions.has("company.manage")) && { archivedAt: null }),
      ...(!access.allShops && { id: { [Op.in]: access.shopIds } }),
    },
    order: [["name", "ASC"]],
  });
}

function conflictOnDuplicateCode(error: unknown): never {
  if (error instanceof UniqueConstraintError) {
    throw AppError.conflict("Ce code de boutique est déjà utilisé dans l'entreprise");
  }
  throw error;
}

export async function createShop(access: CompanyAccess, input: CreateShopInput, actor: AuditActor) {
  try {
    return await sequelize.transaction(async (transaction) => {
      // companyId vient des droits (token vérifié), jamais du corps de la requête
      const shop = await Shop.create({ ...input, companyId: access.companyId }, { transaction });
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          shopId: shop.id,
          action: "shop.create",
          entityType: "shop",
          entityId: shop.id,
          after: pick(shop, AUDIT_FIELDS),
        },
        transaction,
      );
      return shop;
    });
  } catch (error) {
    conflictOnDuplicateCode(error);
  }
}

export async function updateShop(
  access: CompanyAccess,
  id: string,
  input: UpdateShopInput,
  actor: AuditActor,
) {
  const shop = await findAccessibleShop(access, id);
  const { archived, ...fields } = input;

  try {
    return await sequelize.transaction(async (transaction) => {
      const before = pick(shop, AUDIT_FIELDS);
      await shop.update(
        {
          ...fields,
          // Archiver plutôt que supprimer (RB-11) : l'historique de la boutique reste intact
          ...(archived !== undefined && { archivedAt: archived ? (shop.archivedAt ?? new Date()) : null }),
        },
        { transaction },
      );

      const action =
        archived === true && !before.archivedAt
          ? "shop.archive"
          : archived === false && before.archivedAt
            ? "shop.restore"
            : "shop.update";
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          shopId: shop.id,
          action,
          entityType: "shop",
          entityId: shop.id,
          before,
          after: pick(shop, AUDIT_FIELDS),
        },
        transaction,
      );
      return shop;
    });
  } catch (error) {
    conflictOnDuplicateCode(error);
  }
}
