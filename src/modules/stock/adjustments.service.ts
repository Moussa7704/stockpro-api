import { Op } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Product, StockAdjustment, StockMovement } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { currencyDecimals, significantDecimals } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "./numbering.js";
import { findOperableShop, visibleShopIds } from "./stock-access.js";
import { applyMovements, isNegative, loadStockProducts } from "./stock-engine.js";
import type { CreateAdjustmentInput, ListDocumentsQuery } from "./stock.schemas.js";

/**
 * Ajustement manuel (stock d'ouverture, perte, casse, vol, péremption, correction…).
 * Une pièce numérotée + un mouvement par ligne, dans une seule transaction.
 */
export async function createAdjustment(access: CompanyAccess, input: CreateAdjustmentInput, actor: AuditActor) {
  for (const line of input.lines) {
    if (line.unitCost !== undefined && isNegative(line.quantity)) {
      throw AppError.badRequest("Un coût unitaire ne s'indique que pour une entrée de stock");
    }
    if (line.unitCost && significantDecimals(line.unitCost) > currencyDecimals(access.currency)) {
      throw AppError.badRequest(`Coût unitaire : pas de décimales en ${access.currency}`);
    }
  }

  const adjustmentId = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    await loadStockProducts(
      access.companyId,
      input.lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );

    const adjustment = await StockAdjustment.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.adjustment),
        reason: input.reason,
        notes: input.notes ?? null,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );

    const movements = await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "stock_adjustment",
        sourceId: adjustment.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      input.lines.map((line) => ({
        shopId: shop.id,
        productId: line.productId,
        quantity: line.quantity,
        type: "adjustment" as const,
        unitCost: line.unitCost,
      })),
    );

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "stock.adjust",
        entityType: "stock_adjustment",
        entityId: adjustment.id,
        after: {
          number: adjustment.number,
          reason: adjustment.reason,
          lines: movements.map((movement) => ({
            productId: movement.productId,
            quantity: movement.quantity,
            balanceAfter: movement.balanceAfter,
          })),
        },
      },
      transaction,
    );
    return adjustment.id;
  });

  return getAdjustment(access, adjustmentId);
}

export async function getAdjustment(access: CompanyAccess, id: string) {
  const adjustment = await StockAdjustment.findOne({ where: { id, companyId: access.companyId } });
  // Hors de son périmètre de boutiques : introuvable
  if (!adjustment || !((await visibleShopIds(access)) ?? [adjustment.shopId]).includes(adjustment.shopId)) {
    throw AppError.notFound("Ajustement introuvable");
  }
  const movements = await StockMovement.findAll({
    where: { companyId: access.companyId, sourceType: "stock_adjustment", sourceId: id },
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
    order: [["createdAt", "ASC"]],
  });
  return {
    ...adjustment.toJSON(),
    lines: movements.map((movement) => ({
      product: movement.product,
      quantity: movement.quantity,
      balanceAfter: movement.balanceAfter,
    })),
  };
}

export async function listAdjustments(access: CompanyAccess, query: ListDocumentsQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await StockAdjustment.findAndCountAll({
    where: { companyId: access.companyId, ...(shopIds && { shopId: { [Op.in]: shopIds } }) },
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}
