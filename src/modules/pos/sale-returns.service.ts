import { sequelize } from "../../config/database.js";
import { SaleLine, SaleReturn, SaleReturnLine, Shop } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal, roundMoney } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { postLedgerEntry } from "../customers/customers.service.js";
import { DOCUMENT_TYPES, nextDocumentNumber } from "../stock/numbering.js";
import { findOperableShop } from "../stock/stock-access.js";
import { applyMovements, loadStockProducts, negate } from "../stock/stock-engine.js";
import { findOpenSession } from "./cash-sessions.service.js";
import { loadActiveMethods } from "./payment-methods.service.js";
import type { CreateSaleReturnInput } from "./pos.schemas.js";
import { findSale } from "./sales.service.js";

/**
 * Retour client (RB-04, RB-05) : toujours lié aux lignes de la vente d'origine, jamais plus
 * que ce qui a été vendu (moins ce qui a déjà été retourné). Remboursé au prix réellement payé
 * (remises comprises), par un moyen de paiement ou sur le compte du client. L'article revient
 * en stock (au coût d'origine) seulement s'il est réintégrable.
 */
export async function createSaleReturn(access: CompanyAccess, input: CreateSaleReturnInput, actor: AuditActor) {
  const userId = actor.actorUserId!;

  const returnId = await sequelize.transaction(async (transaction) => {
    const sale = await findSale(access, input.saleId, transaction, true);
    if (sale.status !== "completed") {
      throw AppError.conflict("On ne retourne pas les articles d'une vente annulée");
    }
    const shop = await findOperableShop(access, sale.shopId, transaction);

    // Lignes verrouillées : deux retours simultanés ne dépassent pas la quantité vendue
    const saleLines = await SaleLine.findAll({
      where: { saleId: sale.id, companyId: access.companyId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const items = input.lines.map((line) => {
      const saleLine = saleLines.find((item) => item.id === line.saleLineId);
      if (!saleLine) {
        throw AppError.badRequest("Ligne de vente inconnue");
      }
      const returnable = new Decimal(saleLine.quantity).minus(saleLine.returnedQuantity);
      if (new Decimal(line.quantity).greaterThan(returnable)) {
        throw AppError.badRequest(`Quantité retournable dépassée (reste : ${returnable.toFixed(3)})`);
      }
      // Remboursement au prix réellement payé : total de la ligne × part retournée
      const refund = roundMoney(
        new Decimal(saleLine.lineTotal).times(line.quantity).dividedBy(saleLine.quantity),
        access.currency,
      );
      return { line, saleLine, refund };
    });
    await loadStockProducts(
      access.companyId,
      items.map((item) => ({ productId: item.saleLine.productId, quantities: [item.line.quantity] })),
      transaction,
      { allowArchived: true },
    );
    const refundTotal = items.reduce((sum, item) => sum.plus(item.refund), new Decimal(0)).toFixed(2);

    // Remboursement : en espèces → depuis le tiroir de SA session ouverte ; ou sur le compte client
    let cashSessionId: string | null = null;
    if (input.refundTo === "method") {
      const methods = await loadActiveMethods(access.companyId, [input.refundMethodId!], transaction);
      const session = await findOpenSession(access, userId, shop.id, transaction);
      if (methods.get(input.refundMethodId!)!.type === "cash" && !session) {
        throw AppError.conflict("Ouvrez une session de caisse pour rembourser en espèces");
      }
      cashSessionId = session?.id ?? null;
    } else if (!sale.customerId) {
      throw AppError.badRequest("Cette vente n'a pas de client : remboursez par un moyen de paiement");
    }

    const saleReturn = await SaleReturn.create(
      {
        companyId: access.companyId,
        shopId: shop.id,
        saleId: sale.id,
        cashSessionId,
        number: await nextDocumentNumber(transaction, access.companyId, shop as Shop, DOCUMENT_TYPES.saleReturn),
        reason: input.reason,
        refundAmount: refundTotal,
        refundTo: input.refundTo,
        refundMethodId: input.refundTo === "method" ? input.refundMethodId! : null,
        createdBy: userId,
      },
      { transaction },
    );
    await SaleReturnLine.bulkCreate(
      items.map((item) => ({
        companyId: access.companyId,
        returnId: saleReturn.id,
        saleLineId: item.saleLine.id,
        productId: item.saleLine.productId,
        quantity: item.line.quantity,
        restock: item.line.restock,
        refundAmount: item.refund,
      })),
      { transaction },
    );
    for (const item of items) {
      await item.saleLine.update(
        { returnedQuantity: new Decimal(item.saleLine.returnedQuantity).plus(item.line.quantity).toFixed(3) },
        { transaction },
      );
    }

    // Réintégration en stock des seuls articles revendables, au coût d'origine de la vente
    const restocked = items.filter((item) => item.line.restock);
    if (restocked.length > 0) {
      await applyMovements(
        { companyId: access.companyId, sourceType: "sale_return", sourceId: saleReturn.id, createdBy: userId, transaction },
        restocked.map((item) => ({
          shopId: shop.id,
          productId: item.saleLine.productId,
          quantity: item.line.quantity,
          type: "customer_return" as const,
          unitCost: item.saleLine.unitCost,
        })),
      );
    }

    if (input.refundTo === "customer_account" && new Decimal(refundTotal).greaterThan(0)) {
      await postLedgerEntry(transaction, {
        companyId: access.companyId,
        customerId: sale.customerId!,
        type: "return_credit",
        amount: negate(refundTotal),
        sourceType: "sale_return",
        sourceId: saleReturn.id,
        createdBy: userId,
      });
    }

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        shopId: shop.id,
        action: "sale.return",
        entityType: "sale_return",
        entityId: saleReturn.id,
        after: {
          number: saleReturn.number,
          sale: sale.number,
          refundAmount: refundTotal,
          refundTo: input.refundTo,
          lines: items.map((item) => ({ productId: item.saleLine.productId, quantity: item.line.quantity, restock: item.line.restock })),
        },
      },
      transaction,
    );
    return saleReturn.id;
  });

  return getSaleReturn(access, returnId);
}

export async function getSaleReturn(access: CompanyAccess, id: string) {
  const saleReturn = await SaleReturn.findOne({
    where: { id, companyId: access.companyId },
    include: [{ model: SaleReturnLine, as: "lines" }],
  });
  if (!saleReturn) {
    throw AppError.notFound("Retour introuvable");
  }
  // Le retour suit la visibilité de sa vente (boutiques du périmètre)
  await findSale(access, saleReturn.saleId);
  return saleReturn;
}
