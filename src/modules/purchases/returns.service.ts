import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { GoodsReceipt, Product, SupplierReturn, SupplierReturnLine } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { lineTotal, roundMoney, sumMoney } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "../stock/numbering.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import { applyMovements, loadStockProducts, negate } from "../stock/stock-engine.js";
import { assertCurrencyAmount, findUsableSupplier } from "./purchases.helpers.js";
import type { CreateReturnInput, ListReturnsQuery } from "./purchases.schemas.js";

/**
 * Retour fournisseur : brouillon → validé. La validation SORT la marchandise du stock
 * (jamais en dessous de zéro). La valeur du retour sert ensuite à négocier un avoir.
 */

const LINES_INCLUDE = [
  {
    model: SupplierReturnLine,
    as: "lines",
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
  },
];

async function findReturn(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const supplierReturn = await SupplierReturn.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  const shopIds = await visibleShopIds(access);
  if (!supplierReturn || (shopIds && !shopIds.includes(supplierReturn.shopId))) {
    throw AppError.notFound("Retour introuvable");
  }
  return supplierReturn;
}

export async function getReturn(access: CompanyAccess, id: string) {
  await findReturn(access, id);
  return SupplierReturn.findByPk(id, { include: LINES_INCLUDE });
}

export async function listReturns(access: CompanyAccess, query: ListReturnsQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await SupplierReturn.findAndCountAll({
    where: {
      companyId: access.companyId,
      ...(shopIds && { shopId: { [Op.in]: shopIds } }),
      ...(query.status && { status: query.status }),
      ...(query.supplierId && { supplierId: query.supplierId }),
    },
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

export async function createReturn(access: CompanyAccess, input: CreateReturnInput, actor: AuditActor) {
  for (const line of input.lines) {
    assertCurrencyAmount(access, line.unitCost, "Valeur unitaire");
  }

  const id = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    const supplier = await findUsableSupplier(access.companyId, input.supplierId, transaction);
    if (input.receiptId) {
      const receipt = await GoodsReceipt.findOne({
        where: { id: input.receiptId, companyId: access.companyId, supplierId: supplier.id, status: "validated" },
        transaction,
      });
      if (!receipt) {
        throw AppError.badRequest("Réception inconnue, non validée ou d'un autre fournisseur");
      }
    }
    await loadStockProducts(
      access.companyId,
      input.lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );

    const supplierReturn = await SupplierReturn.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        supplierId: supplier.id,
        receiptId: input.receiptId ?? null,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.supplierReturn),
        reason: input.reason,
        notes: input.notes ?? null,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );
    await SupplierReturnLine.bulkCreate(
      input.lines.map((line) => ({
        companyId: access.companyId,
        returnId: supplierReturn.id,
        productId: line.productId,
        quantity: line.quantity,
        unitCost: line.unitCost ?? null,
      })),
      { transaction },
    );
    return supplierReturn.id;
  });
  return getReturn(access, id);
}

export async function validateReturn(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const supplierReturn = await findReturn(access, id, transaction, true);
    if (supplierReturn.status !== "draft") {
      throw AppError.conflict("Ce retour n'est plus un brouillon");
    }
    await findOperableShop(access, supplierReturn.shopId, transaction);
    const lines = await SupplierReturnLine.findAll({ where: { returnId: supplierReturn.id }, transaction });
    await loadStockProducts(
      access.companyId,
      lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );

    const movements = await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "supplier_return",
        sourceId: supplierReturn.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      lines.map((line) => ({
        shopId: supplierReturn.shopId,
        productId: line.productId,
        quantity: negate(line.quantity),
        type: "supplier_return" as const,
      })),
    );

    // Valeur figée : celle saisie, sinon le coût moyen au moment de la sortie
    for (const line of lines) {
      const movement = movements.find((item) => item.productId === line.productId)!;
      const unitCost = line.unitCost ?? roundMoney(movement.unitCost, access.currency);
      await line.update(
        { unitCost, lineTotal: lineTotal(line.quantity, unitCost, access.currency) },
        { transaction },
      );
    }
    const total = sumMoney(lines.map((line) => line.lineTotal!));

    await supplierReturn.update(
      { status: "validated", total, validatedAt: new Date(), validatedBy: actor.actorUserId },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: supplierReturn.shopId,
        action: "supplier_return.validate",
        entityType: "supplier_return",
        entityId: supplierReturn.id,
        before: { status: "draft" },
        after: { status: "validated", number: supplierReturn.number, total },
      },
      transaction,
    );
  });
  return getReturn(access, id);
}

export async function cancelReturn(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const supplierReturn = await findReturn(access, id, transaction, true);
    if (supplierReturn.status !== "draft") {
      throw AppError.conflict("Seul un brouillon de retour peut être annulé");
    }
    await supplierReturn.update({ status: "cancelled" }, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: supplierReturn.shopId,
        action: "supplier_return.cancel",
        entityType: "supplier_return",
        entityId: supplierReturn.id,
        before: { status: "draft" },
        after: { status: "cancelled" },
      },
      transaction,
    );
  });
  return getReturn(access, id);
}
