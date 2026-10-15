import { Op, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Product, StockTransfer, StockTransferLine } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { sameDecimal } from "../../utils/decimal.js";
import { canAccessShop, type CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "./numbering.js";
import { canSeeCosts, findCompanyShop, findOperableShop, visibleShopIds } from "./stock-access.js";
import { applyMovements, loadStockProducts, negate } from "./stock-engine.js";
import type { CreateTransferInput, ListTransfersQuery, ReceiveTransferInput } from "./stock.schemas.js";

/**
 * Transfert entre deux boutiques (RB-02) : brouillon → expédié → reçu (ou annulé avant expédition).
 * Expédition : sortie de la boutique source au coût moyen. Réception : entrée dans la
 * destination à ce même coût. Un écart entre envoyé et reçu reste tracé sur la ligne.
 */

const LINES_INCLUDE = [
  {
    model: StockTransferLine,
    as: "lines",
    include: [{ model: Product, as: "product", attributes: ["id", "sku", "name"] }],
  },
];

/** Un transfert est visible si l'utilisateur a accès à la boutique de départ OU d'arrivée. */
function canSeeTransfer(access: CompanyAccess, transfer: StockTransfer): boolean {
  return canAccessShop(access, transfer.fromShopId) || canAccessShop(access, transfer.toShopId);
}

async function findTransfer(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const transfer = await StockTransfer.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  if (!transfer || !canSeeTransfer(access, transfer)) {
    throw AppError.notFound("Transfert introuvable");
  }
  return transfer;
}

function toDto(access: CompanyAccess, transfer: StockTransfer) {
  const json = transfer.toJSON() as ReturnType<StockTransfer["toJSON"]> & { lines?: Record<string, unknown>[] };
  if (!canSeeCosts(access) && json.lines) {
    json.lines = json.lines.map(({ unitCost: _unitCost, ...line }) => line);
  }
  return json;
}

export async function getTransfer(access: CompanyAccess, id: string) {
  await findTransfer(access, id);
  const transfer = await StockTransfer.findByPk(id, { include: LINES_INCLUDE });
  return toDto(access, transfer!);
}

export async function listTransfers(access: CompanyAccess, query: ListTransfersQuery) {
  const shopIds = await visibleShopIds(access, query.shopId);
  const { rows, count } = await StockTransfer.findAndCountAll({
    where: {
      companyId: access.companyId,
      ...(query.status && { status: query.status }),
      ...(shopIds && { [Op.or]: [{ fromShopId: { [Op.in]: shopIds } }, { toShopId: { [Op.in]: shopIds } }] }),
    },
    order: [["createdAt", "DESC"]],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows, total: count, page: query.page, pageSize: query.pageSize };
}

export async function createTransfer(access: CompanyAccess, input: CreateTransferInput, actor: AuditActor) {
  const transferId = await sequelize.transaction(async (transaction) => {
    // On expédie depuis une boutique de son périmètre, vers n'importe quelle boutique de l'entreprise
    const fromShop = await findOperableShop(access, input.fromShopId, transaction);
    const toShop = await findCompanyShop(access, input.toShopId, transaction);
    await loadStockProducts(
      access.companyId,
      input.lines.map((line) => ({ productId: line.productId, quantities: [line.quantity] })),
      transaction,
    );

    const transfer = await StockTransfer.create(
      {
        companyId: access.companyId,
        number: await nextDocumentNumber(transaction, access.companyId, fromShop, DOCUMENT_TYPES.transfer),
        fromShopId: fromShop.id,
        toShopId: toShop.id,
        notes: input.notes ?? null,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );
    await StockTransferLine.bulkCreate(
      input.lines.map((line) => ({
        companyId: access.companyId,
        transferId: transfer.id,
        productId: line.productId,
        quantitySent: line.quantity,
      })),
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: fromShop.id,
        action: "transfer.create",
        entityType: "stock_transfer",
        entityId: transfer.id,
        after: { number: transfer.number, from: fromShop.code, to: toShop.code, lines: input.lines },
      },
      transaction,
    );
    return transfer.id;
  });
  return getTransfer(access, transferId);
}

/** Expédition : le stock sort de la boutique source (verrouillée, jamais négative). */
export async function shipTransfer(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const transfer = await findTransfer(access, id, transaction, true);
    if (!canAccessShop(access, transfer.fromShopId)) {
      throw AppError.forbidden("Seule la boutique de départ peut expédier ce transfert");
    }
    if (transfer.status !== "draft") {
      throw AppError.conflict("Ce transfert n'est plus un brouillon");
    }
    await findOperableShop(access, transfer.fromShopId, transaction);
    await findCompanyShop(access, transfer.toShopId, transaction);

    const lines = await StockTransferLine.findAll({ where: { transferId: transfer.id }, transaction });
    // Les produits ont pu être archivés depuis la création du brouillon
    await loadStockProducts(
      access.companyId,
      lines.map((line) => ({ productId: line.productId, quantities: [line.quantitySent] })),
      transaction,
    );

    const movements = await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "stock_transfer",
        sourceId: transfer.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      lines.map((line) => ({
        shopId: transfer.fromShopId,
        productId: line.productId,
        quantity: negate(line.quantitySent),
        type: "transfer_out" as const,
      })),
    );

    // Le coût de sortie est figé sur la ligne : la destination recevra au même coût
    for (const line of lines) {
      const movement = movements.find((item) => item.productId === line.productId)!;
      await line.update({ unitCost: movement.unitCost }, { transaction });
    }
    await transfer.update(
      { status: "shipped", shippedAt: new Date(), shippedBy: actor.actorUserId },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: transfer.fromShopId,
        action: "transfer.ship",
        entityType: "stock_transfer",
        entityId: transfer.id,
        before: { status: "draft" },
        after: { status: "shipped" },
      },
      transaction,
    );
  });
  return getTransfer(access, id);
}

/** Réception : seules les quantités réellement reçues entrent en stock ; les écarts sont tracés. */
export async function receiveTransfer(
  access: CompanyAccess,
  id: string,
  input: ReceiveTransferInput,
  actor: AuditActor,
) {
  await sequelize.transaction(async (transaction) => {
    const transfer = await findTransfer(access, id, transaction, true);
    if (!canAccessShop(access, transfer.toShopId)) {
      throw AppError.forbidden("Seule la boutique d'arrivée peut réceptionner ce transfert");
    }
    if (transfer.status !== "shipped") {
      throw AppError.conflict("Ce transfert n'est pas en cours d'acheminement");
    }

    const lines = await StockTransferLine.findAll({ where: { transferId: transfer.id }, transaction });
    const received = new Map((input.lines ?? []).map((line) => [line.lineId, line.quantityReceived]));
    for (const lineId of received.keys()) {
      if (!lines.some((line) => line.id === lineId)) {
        throw AppError.badRequest("Ligne de transfert inconnue");
      }
    }

    const discrepancies: { productId: string; sent: string; received: string }[] = [];
    for (const line of lines) {
      const quantityReceived = received.get(line.id) ?? line.quantitySent;
      // Comparaison exacte en SQL : jamais plus que ce qui a été expédié
      const [check] = (await sequelize.query("SELECT CAST(:received AS numeric) <= CAST(:sent AS numeric) AS ok", {
        replacements: { received: quantityReceived, sent: line.quantitySent },
        transaction,
      })) as [{ ok: boolean }[], unknown];
      if (!check[0]!.ok) {
        throw AppError.badRequest("On ne peut pas recevoir plus que la quantité expédiée");
      }
      await line.update({ quantityReceived }, { transaction });
      if (!sameDecimal(quantityReceived, line.quantitySent)) {
        discrepancies.push({ productId: line.productId, sent: line.quantitySent, received: quantityReceived });
      }
    }

    // Un produit archivé pendant l'acheminement est quand même reçu : la marchandise est là
    await loadStockProducts(
      access.companyId,
      lines.map((line) => ({ productId: line.productId, quantities: [line.quantityReceived!] })),
      transaction,
      { allowArchived: true },
    );

    await applyMovements(
      {
        companyId: access.companyId,
        sourceType: "stock_transfer",
        sourceId: transfer.id,
        createdBy: actor.actorUserId,
        transaction,
      },
      lines
        .filter((line) => !sameDecimal(line.quantityReceived, "0"))
        .map((line) => ({
          shopId: transfer.toShopId,
          productId: line.productId,
          quantity: line.quantityReceived!,
          type: "transfer_in" as const,
          unitCost: line.unitCost ?? undefined,
        })),
    );

    await transfer.update(
      { status: "received", receivedAt: new Date(), receivedBy: actor.actorUserId },
      { transaction },
    );
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: transfer.toShopId,
        action: discrepancies.length > 0 ? "transfer.receive_with_discrepancy" : "transfer.receive",
        entityType: "stock_transfer",
        entityId: transfer.id,
        before: { status: "shipped" },
        after: { status: "received", ...(discrepancies.length > 0 && { discrepancies }) },
      },
      transaction,
    );
  });
  return getTransfer(access, id);
}

/** Annulation : uniquement avant expédition (après, le stock a déjà bougé). */
export async function cancelTransfer(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const transfer = await findTransfer(access, id, transaction, true);
    if (!canAccessShop(access, transfer.fromShopId)) {
      throw AppError.forbidden("Seule la boutique de départ peut annuler ce transfert");
    }
    if (transfer.status !== "draft") {
      throw AppError.conflict("Seul un brouillon peut être annulé");
    }
    await transfer.update({ status: "cancelled" }, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: transfer.fromShopId,
        action: "transfer.cancel",
        entityType: "stock_transfer",
        entityId: transfer.id,
        before: { status: "draft" },
        after: { status: "cancelled" },
      },
      transaction,
    );
  });
  return getTransfer(access, id);
}
