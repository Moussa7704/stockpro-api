import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Product, PurchaseOrder, PurchaseOrderLine, Supplier } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "../stock/numbering.js";
import { findOperableShop, visibleShopIds } from "../stock/stock-access.js";
import { loadStockProducts } from "../stock/stock-engine.js";
import { findUsableSupplier, priceLines } from "./purchases.helpers.js";
import type { CreateOrderInput, ListOrdersQuery, UpdateOrderInput } from "./purchases.schemas.js";

/**
 * Bon de commande (RB-06) : draft → sent → partially_received → received (ou closed / cancelled).
 * Une commande n'augmente JAMAIS le stock : seules les réceptions validées le font.
 */

const ORDER_INCLUDE = [
  {
    model: PurchaseOrderLine,
    as: "lines",
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
  },
  { model: Supplier, as: "supplier", attributes: ["id", "name"] },
];

export async function findOrder(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const order = await PurchaseOrder.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  const shopIds = await visibleShopIds(access);
  if (!order || (shopIds && !shopIds.includes(order.shopId))) {
    throw AppError.notFound("Commande introuvable");
  }
  return order;
}

/** Commande avec ses lignes et le reste à recevoir de chaque ligne. */
export async function getOrder(access: CompanyAccess, id: string) {
  await findOrder(access, id);
  const order = await PurchaseOrder.findByPk(id, { include: ORDER_INCLUDE });
  return {
    ...order!.toJSON(),
    lines: order!.lines!.map((line) => ({
      ...line.toJSON(),
      quantityRemaining: new Decimal(line.quantityOrdered).minus(line.quantityReceived).toFixed(3),
    })),
  };
}

export async function listOrders(access: CompanyAccess, query: ListOrdersQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await PurchaseOrder.findAndCountAll({
    where: {
      companyId: access.companyId,
      ...(shopIds && { shopId: { [Op.in]: shopIds } }),
      ...(query.status && { status: query.status }),
      ...(query.supplierId && { supplierId: query.supplierId }),
    },
    include: [{ model: Supplier, as: "supplier", attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

async function replaceLines(
  access: CompanyAccess,
  orderId: string,
  lines: CreateOrderInput["lines"],
  transaction: Transaction,
): Promise<string> {
  await loadStockProducts(
    access.companyId,
    lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
    transaction,
  );
  const priced = priceLines(access, lines);
  await PurchaseOrderLine.destroy({ where: { orderId }, transaction });
  await PurchaseOrderLine.bulkCreate(
    priced.lines.map((line) => ({
      companyId: access.companyId,
      orderId,
      productId: line.productId,
      quantityOrdered: line.quantity,
      unitCost: line.unitCost,
      lineTotal: line.lineTotal,
    })),
    { transaction },
  );
  return priced.total;
}

export async function createOrder(access: CompanyAccess, input: CreateOrderInput, actor: AuditActor) {
  const id = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    const supplier = await findUsableSupplier(access.companyId, input.supplierId, transaction);
    const order = await PurchaseOrder.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        supplierId: supplier.id,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.purchaseOrder),
        expectedAt: input.expectedAt ?? null,
        notes: input.notes ?? null,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );
    const total = await replaceLines(access, order.id, input.lines, transaction);
    await order.update({ total }, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "purchase_order.create",
        entityType: "purchase_order",
        entityId: order.id,
        after: { number: order.number, supplier: supplier.name, total },
      },
      transaction,
    );
    return order.id;
  });
  return getOrder(access, id);
}

/** Modification d'un brouillon uniquement (une commande envoyée engage le fournisseur). */
export async function updateOrder(access: CompanyAccess, id: string, input: UpdateOrderInput, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const order = await findOrder(access, id, transaction, true);
    if (order.status !== "draft") {
      throw AppError.conflict("Seul un brouillon de commande est modifiable");
    }
    const before = { total: order.total, expectedAt: order.expectedAt };
    const total = input.lines ? await replaceLines(access, order.id, input.lines, transaction) : order.total;
    await order.update(
      {
        total,
        ...(input.expectedAt !== undefined && { expectedAt: input.expectedAt }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: order.shopId,
        action: "purchase_order.update",
        entityType: "purchase_order",
        entityId: order.id,
        before,
        after: { total: order.total, expectedAt: order.expectedAt },
      },
      transaction,
    );
  });
  return getOrder(access, id);
}

/** Changement de statut simple : envoyer, annuler, clôturer. */
async function transition(
  access: CompanyAccess,
  id: string,
  actor: AuditActor,
  allowed: string[],
  next: "sent" | "cancelled" | "closed",
  error: string,
) {
  await sequelize.transaction(async (transaction) => {
    const order = await findOrder(access, id, transaction, true);
    if (!allowed.includes(order.status)) {
      throw AppError.conflict(error);
    }
    const before = order.status;
    await order.update(
      {
        status: next,
        ...(next === "sent" && { sentAt: new Date() }),
        ...(next === "closed" && { closedAt: new Date() }),
      },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: order.shopId,
        action: `purchase_order.${next === "sent" ? "send" : next === "cancelled" ? "cancel" : "close"}`,
        entityType: "purchase_order",
        entityId: order.id,
        before: { status: before },
        after: { status: next },
      },
      transaction,
    );
  });
  return getOrder(access, id);
}

export const sendOrder = (access: CompanyAccess, id: string, actor: AuditActor) =>
  transition(access, id, actor, ["draft"], "sent", "Seul un brouillon peut être envoyé");

// Annulation : rien n'a encore été reçu (après une réception, on clôture)
export const cancelOrder = (access: CompanyAccess, id: string, actor: AuditActor) =>
  transition(access, id, actor, ["draft", "sent"], "cancelled", "Une commande déjà (partiellement) reçue se clôture, elle ne s'annule pas");

// Clôture : le reste ne sera pas livré
export const closeOrder = (access: CompanyAccess, id: string, actor: AuditActor) =>
  transition(access, id, actor, ["partially_received"], "closed", "Seule une commande partiellement reçue peut être clôturée");
