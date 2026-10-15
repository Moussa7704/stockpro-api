import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { InventoryCount, InventoryCountLine, Product } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "./numbering.js";
import { findOperableShop, visibleShopIds } from "./stock-access.js";
import { applyMovements, loadStockProducts, lockLevels } from "./stock-engine.js";
import type { CreateInventoryInput, ListDocumentsQuery, SetInventoryLinesInput } from "./stock.schemas.js";

/**
 * Inventaire physique : brouillon (on saisit les quantités comptées) → validé.
 * À la validation, l'écart est calculé avec le stock DU MOMENT (ventes faites pendant le
 * comptage comprises) et corrigé par un mouvement "inventory_adjustment" tracé.
 */

const LINES_INCLUDE = [
  {
    model: InventoryCountLine,
    as: "lines",
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
  },
];

async function findInventory(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const inventory = await InventoryCount.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  if (!inventory || !((await visibleShopIds(access)) ?? [inventory.shopId]).includes(inventory.shopId)) {
    throw AppError.notFound("Inventaire introuvable");
  }
  return inventory;
}

function assertDraft(inventory: InventoryCount) {
  if (inventory.status !== "draft") {
    throw AppError.conflict("Cet inventaire n'est plus un brouillon");
  }
}

export async function getInventory(access: CompanyAccess, id: string) {
  await findInventory(access, id);
  return InventoryCount.findByPk(id, { include: LINES_INCLUDE });
}

export async function listInventories(access: CompanyAccess, query: ListDocumentsQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await InventoryCount.findAndCountAll({
    where: { companyId: access.companyId, ...(shopIds && { shopId: { [Op.in]: shopIds } }) },
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

export async function createInventory(access: CompanyAccess, input: CreateInventoryInput, actor: AuditActor) {
  const id = await sequelize.transaction(async (transaction) => {
    const shop = await findOperableShop(access, input.shopId, transaction);
    const inventory = await InventoryCount.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        number: await nextDocumentNumber(transaction, access.companyId, shop, DOCUMENT_TYPES.inventory),
        notes: input.notes ?? null,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "inventory.create",
        entityType: "inventory_count",
        entityId: inventory.id,
        after: { number: inventory.number },
      },
      transaction,
    );
    return inventory.id;
  });
  return getInventory(access, id);
}

/** Enregistre ou corrige des quantités comptées (le comptage peut se faire en plusieurs fois). */
export async function setInventoryLines(
  access: CompanyAccess,
  id: string,
  input: SetInventoryLinesInput,
  _actor: AuditActor,
) {
  await sequelize.transaction(async (transaction) => {
    const inventory = await findInventory(access, id, transaction, true);
    assertDraft(inventory);
    await loadStockProducts(
      access.companyId,
      input.lines.map((line) => ({ productId: line.productId, quantities: [line.countedQuantity] })),
      transaction,
    );

    for (const line of input.lines) {
      await sequelize.query(
        `INSERT INTO inventory_count_lines
           (id, company_id, inventory_id, product_id, counted_quantity, created_at, updated_at)
         VALUES (gen_random_uuid(), :companyId, :inventoryId, :productId, :counted, now(), now())
         ON CONFLICT (inventory_id, product_id)
           DO UPDATE SET counted_quantity = EXCLUDED.counted_quantity, updated_at = now()`,
        {
          replacements: {
            companyId: access.companyId,
            inventoryId: inventory.id,
            productId: line.productId,
            counted: line.countedQuantity,
          },
          transaction,
        },
      );
    }
  });
  return getInventory(access, id);
}

export async function validateInventory(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const inventory = await findInventory(access, id, transaction, true);
    assertDraft(inventory);
    await findOperableShop(access, inventory.shopId, transaction);

    const lines = await InventoryCountLine.findAll({ where: { inventoryId: inventory.id }, transaction });
    if (lines.length === 0) {
      throw AppError.badRequest("Aucune quantité comptée : rien à valider");
    }

    // Verrouille les soldes concernés : aucune vente ne peut les modifier pendant la validation
    const levels = await lockLevels(
      access.companyId,
      lines.map((line) => ({ shopId: inventory.shopId, productId: line.productId })),
      transaction,
    );

    const adjustments: { productId: string; quantity: string }[] = [];
    for (const line of lines) {
      const expected = levels.get(`${inventory.shopId}:${line.productId}`)!.quantity;
      await line.update({ expectedQuantity: expected }, { transaction });
      // Écart calculé par PostgreSQL (décimal exact) : compté − théorique
      const [rows] = (await sequelize.query("SELECT CAST(:counted AS numeric) - CAST(:expected AS numeric) AS delta", {
        replacements: { counted: line.countedQuantity, expected },
        transaction,
      })) as [{ delta: string }[], unknown];
      const delta = rows[0]!.delta;
      if (!/^-?0+(\.0+)?$/.test(delta)) {
        adjustments.push({ productId: line.productId, quantity: delta });
      }
    }

    await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "inventory_count",
        sourceId: inventory.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      adjustments.map((adjustment) => ({
        shopId: inventory.shopId,
        productId: adjustment.productId,
        quantity: adjustment.quantity,
        type: "inventory_adjustment" as const,
      })),
    );

    await inventory.update(
      { status: "validated", validatedAt: new Date(), validatedBy: actor.actorUserId },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: inventory.shopId,
        action: "inventory.validate",
        entityType: "inventory_count",
        entityId: inventory.id,
        before: { status: "draft" },
        after: { status: "validated", countedLines: lines.length, adjustments },
      },
      transaction,
    );
  });
  return getInventory(access, id);
}

export async function cancelInventory(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const inventory = await findInventory(access, id, transaction, true);
    assertDraft(inventory);
    await inventory.update({ status: "cancelled" }, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: inventory.shopId,
        action: "inventory.cancel",
        entityType: "inventory_count",
        entityId: inventory.id,
        before: { status: "draft" },
        after: { status: "cancelled" },
      },
      transaction,
    );
  });
  return getInventory(access, id);
}
