import type { Transaction } from "sequelize";
import { Supplier } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { currencyDecimals, lineTotal, significantDecimals, sumMoney } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";

/** Fournisseur de l'entreprise et non archivé (sinon 400 : on ne révèle rien d'une autre entreprise). */
export async function findUsableSupplier(
  companyId: string,
  supplierId: string,
  transaction?: Transaction,
): Promise<Supplier> {
  const supplier = await Supplier.findOne({ where: { id: supplierId, companyId }, transaction });
  if (!supplier || supplier.archivedAt) {
    throw AppError.badRequest("Fournisseur inconnu ou archivé");
  }
  return supplier;
}

/** Montant compatible avec la devise de l'entreprise (FCFA : sans décimales). */
export function assertCurrencyAmount(access: CompanyAccess, amount: string | null | undefined, label: string) {
  if (amount && significantDecimals(amount) > currencyDecimals(access.currency)) {
    throw AppError.badRequest(`${label} : pas de décimales en ${access.currency}`);
  }
}

/** Lignes chiffrées : total de chaque ligne (quantité × coût, arrondi à la devise) et total général. */
export function priceLines<T extends { quantity: string; unitCost: string }>(access: CompanyAccess, lines: T[]) {
  const priced = lines.map((line) => {
    assertCurrencyAmount(access, line.unitCost, "Coût unitaire");
    return { ...line, lineTotal: lineTotal(line.quantity, line.unitCost, access.currency) };
  });
  return { lines: priced, total: sumMoney(priced.map((line) => line.lineTotal)) };
}
