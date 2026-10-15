import { QueryTypes, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";

/**
 * Numérotation des documents sans trou (RB-09) : BTQ1-TR-2026-000001.
 * Le compteur est incrémenté dans la transaction du document : sa ligne reste verrouillée
 * jusqu'au COMMIT, donc deux documents simultanés ne reçoivent jamais le même numéro, et un
 * document annulé (ROLLBACK) ne consomme pas de numéro.
 */

export const DOCUMENT_TYPES = {
  adjustment: "AJ",
  transfer: "TR",
  inventory: "INV",
  purchaseOrder: "BC",
  goodsReceipt: "REC",
  supplierReturn: "RF",
  ticket: "T",
  saleReturn: "RT",
} as const;

export async function nextDocumentNumber(
  transaction: Transaction,
  companyId: string,
  shop: { id: string; code: string },
  docType: string,
): Promise<string> {
  // Année civile UTC (D-06 : les entreprises actuelles sont en Afrique de l'Ouest, UTC+0)
  const year = new Date().getUTCFullYear();
  const [row] = await sequelize.query<{ last_number: number }>(
    `INSERT INTO document_sequences (company_id, shop_id, doc_type, year, last_number)
     VALUES (:companyId, :shopId, :docType, :year, 1)
     ON CONFLICT (company_id, shop_id, doc_type, year)
       DO UPDATE SET last_number = document_sequences.last_number + 1
     RETURNING last_number`,
    {
      replacements: { companyId, shopId: shop.id, docType, year },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return `${shop.code}-${docType}-${year}-${String(row!.last_number).padStart(6, "0")}`;
}
