import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { GoodsReceipt, GoodsReceiptLine, Product, PurchaseOrder, PurchaseOrderLine } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { compareDecimal, Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "../stock/numbering.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import { applyMovements, loadStockProducts } from "../stock/stock-engine.js";
import { findUsableSupplier, priceLines } from "./purchases.helpers.js";
import type { CreateReceiptInput, ListReceiptsQuery } from "./purchases.schemas.js";

/**
 * Réception de marchandises (RB-06) : brouillon → validée.
 * SEULE la validation augmente le stock, de la quantité réellement reçue, au coût d'achat
 * (qui met à jour le coût moyen pondéré). Une réception liée à une commande ne peut pas
 * dépasser ce qui reste à recevoir.
 */

const LINES_INCLUDE = [
  {
    model: GoodsReceiptLine,
    as: "lines",
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
  },
];

async function findReceipt(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const receipt = await GoodsReceipt.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  const shopIds = await visibleShopIds(access);
  if (!receipt || (shopIds && !shopIds.includes(receipt.shopId))) {
    throw AppError.notFound("Réception introuvable");
  }
  return receipt;
}

export async function getReceipt(access: CompanyAccess, id: string) {
  await findReceipt(access, id);
  return GoodsReceipt.findByPk(id, { include: LINES_INCLUDE });
}

export async function listReceipts(access: CompanyAccess, query: ListReceiptsQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await GoodsReceipt.findAndCountAll({
    where: {
      companyId: access.companyId,
      ...(shopIds && { shopId: { [Op.in]: shopIds } }),
      ...(query.status && { status: query.status }),
      ...(query.supplierId && { supplierId: query.supplierId }),
      ...(query.orderId && { orderId: query.orderId }),
    },
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

/** Commande à laquelle on peut rattacher une réception : même boutique, même fournisseur, en cours. */
async function findReceivableOrder(
  access: CompanyAccess,
  input: CreateReceiptInput,
  transaction: Transaction,
): Promise<PurchaseOrder> {
  const order = await PurchaseOrder.findOne({
    where: { id: input.orderId!, companyId: access.companyId },
    include: [{ model: PurchaseOrderLine, as: "lines" }],
    transaction,
  });
  if (!order) {
    throw AppError.badRequest("Commande inconnue");
  }
  if (order.shopId !== input.shopId || order.supplierId !== input.supplierId) {
    throw AppError.badRequest("La commande concerne une autre boutique ou un autre fournisseur");
  }
  if (!["sent", "partially_received"].includes(order.status)) {
    throw AppError.conflict("Cette commande n'attend plus de livraison");
  }
  return order;
}

export async function createReceipt(access: CompanyAccess, input: CreateReceiptInput, actor: AuditActor) {
  const id = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    const supplier = await findUsableSupplier(access.companyId, input.supplierId, transaction);
    const order = input.orderId ? await findReceivableOrder(access, input, transaction) : null;

    let lines: { productId: string; quantity: string; unitCost: string; orderLineId?: string }[];
    if (input.lines) {
      lines = input.lines.map((line) => {
        if (line.orderLineId) {
          const orderLine = order?.lines?.find((item) => item.id === line.orderLineId);
          if (!orderLine || orderLine.productId !== line.productId) {
            throw AppError.badRequest("Ligne de commande inconnue pour ce produit");
          }
          return line;
        }
        // Réception sur commande : la ligne est rattachée à la ligne de commande du même produit
        const matching = order?.lines?.find((item) => item.productId === line.productId);
        return matching ? { ...line, orderLineId: matching.id } : line;
      });
    } else if (order) {
      // Sans détail : tout le reste à recevoir, au coût prévu à la commande
      lines = order
        .lines!.map((line) => ({
          productId: line.productId,
          quantity: new Decimal(line.quantityOrdered).minus(line.quantityReceived).toFixed(3),
          unitCost: line.unitCost,
          orderLineId: line.id,
        }))
        .filter((line) => compareDecimal(line.quantity, 0) > 0);
      if (lines.length === 0) {
        throw AppError.conflict("Tout a déjà été reçu pour cette commande");
      }
    } else {
      throw AppError.badRequest("Indiquez les lignes reçues");
    }

    await loadStockProducts(
      access.companyId,
      lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );
    const priced = priceLines(access, lines);

    const receipt = await GoodsReceipt.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        supplierId: supplier.id,
        orderId: order?.id ?? null,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.goodsReceipt),
        supplierReference: input.supplierReference ?? null,
        notes: input.notes ?? null,
        total: priced.total,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );
    await GoodsReceiptLine.bulkCreate(
      priced.lines.map((line) => ({
        companyId: access.companyId,
        receiptId: receipt.id,
        productId: line.productId,
        orderLineId: line.orderLineId ?? null,
        quantity: line.quantity,
        unitCost: line.unitCost,
        lineTotal: line.lineTotal,
      })),
      { transaction },
    );
    return receipt.id;
  });
  return getReceipt(access, id);
}

/** Validation : entrée en stock (CMP mis à jour) et avancement de la commande, en une transaction. */
export async function validateReceipt(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const receipt = await findReceipt(access, id, transaction, true);
    if (receipt.status !== "draft") {
      throw AppError.conflict("Cette réception n'est plus un brouillon");
    }
    await findOperableShop(access, receipt.shopId, transaction);
    const lines = await GoodsReceiptLine.findAll({ where: { receiptId: receipt.id }, transaction });
    await loadStockProducts(
      access.companyId,
      lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );

    if (receipt.orderId) {
      // Commande et lignes verrouillées : deux réceptions simultanées ne dépassent pas la commande
      const order = await PurchaseOrder.findOne({
        where: { id: receipt.orderId, companyId: access.companyId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!order || !["sent", "partially_received"].includes(order.status)) {
        throw AppError.conflict("La commande liée n'attend plus de livraison");
      }
      const orderLines = await PurchaseOrderLine.findAll({
        where: { orderId: order.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const line of lines.filter((item) => item.orderLineId)) {
        const orderLine = orderLines.find((item) => item.id === line.orderLineId)!;
        const received = new Decimal(orderLine.quantityReceived).plus(line.quantity);
        if (received.greaterThan(orderLine.quantityOrdered)) {
          throw AppError.badRequest(
            `On ne peut pas recevoir plus que la quantité commandée (reste : ${new Decimal(orderLine.quantityOrdered).minus(orderLine.quantityReceived).toFixed(3)})`,
          );
        }
        await orderLine.update({ quantityReceived: received.toFixed(3) }, { transaction });
      }
      // Le statut n'avance que si une ligne de la commande a réellement été reçue
      if (lines.some((line) => line.orderLineId)) {
        const complete = orderLines.every((line) => compareDecimal(line.quantityReceived, line.quantityOrdered) >= 0);
        await order.update({ status: complete ? "received" : "partially_received" }, { transaction });
      }
    }

    await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "goods_receipt",
        sourceId: receipt.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      lines.map((line) => ({
        shopId: receipt.shopId,
        productId: line.productId,
        quantity: line.quantity,
        type: "purchase_receipt" as const,
        unitCost: line.unitCost,
      })),
    );

    await receipt.update(
      { status: "validated", validatedAt: new Date(), validatedBy: actor.actorUserId },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: receipt.shopId,
        action: "goods_receipt.validate",
        entityType: "goods_receipt",
        entityId: receipt.id,
        before: { status: "draft" },
        after: { status: "validated", number: receipt.number, total: receipt.total, orderId: receipt.orderId },
      },
      transaction,
    );
  });
  return getReceipt(access, id);
}

export async function cancelReceipt(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const receipt = await findReceipt(access, id, transaction, true);
    if (receipt.status !== "draft") {
      throw AppError.conflict("Seul un brouillon de réception peut être annulé");
    }
    await receipt.update({ status: "cancelled" }, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: receipt.shopId,
        action: "goods_receipt.cancel",
        entityType: "goods_receipt",
        entityId: receipt.id,
        before: { status: "draft" },
        after: { status: "cancelled" },
      },
      transaction,
    );
  });
  return getReceipt(access, id);
}
