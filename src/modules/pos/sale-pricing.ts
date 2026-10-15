import type { Product } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal, roundMoney, sameDecimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { assertCurrencyAmount } from "../purchases/purchases.helpers.js";
import type { CreateSaleInput, Discount } from "./pos.schemas.js";

/**
 * Calcul d'un ticket, entièrement côté serveur (RB-05) : les montants envoyés par le navigateur
 * ne sont jamais repris tels quels. Décimal exact (decimal.js), arrondi à la devise.
 */

export interface PricedLine {
  productId: string;
  quantity: string;
  unitPrice: string;
  gross: string; // quantité × prix
  discount: string; // remise de la ligne + part de la remise du ticket
  lineTotal: string;
}

export interface PricedSale {
  lines: PricedLine[];
  subtotal: string;
  discountTotal: string;
  total: string;
  priceOverrides: { productId: string; catalogPrice: string; appliedPrice: string }[];
}

function discountAmount(base: Decimal, discount: Discount | undefined, currency: string, label: string): Decimal {
  if (!discount) {
    return new Decimal(0);
  }
  const amount =
    discount.type === "amount"
      ? new Decimal(discount.value)
      : new Decimal(roundMoney(base.times(discount.value).dividedBy(100), currency));
  if (amount.greaterThan(base)) {
    throw AppError.badRequest(`${label} : la remise dépasse le montant`);
  }
  return amount;
}

export function priceSale(
  access: CompanyAccess,
  input: CreateSaleInput,
  products: Map<string, Product>,
  maxCashierDiscountPercent: number,
): PricedSale {
  const { currency } = access;
  const priceOverrides: PricedSale["priceOverrides"] = [];

  // 1. Prix et remise de chaque ligne
  const draft = input.lines.map((line) => {
    const product = products.get(line.productId)!;
    const unitPrice = line.unitPrice ?? product.salePrice;
    assertCurrencyAmount(access, unitPrice, "Prix unitaire");
    if (line.discount?.type === "amount") {
      assertCurrencyAmount(access, line.discount.value, "Remise");
    }
    if (!sameDecimal(unitPrice, product.salePrice)) {
      priceOverrides.push({
        productId: product.id,
        catalogPrice: new Decimal(product.salePrice).toFixed(2),
        appliedPrice: new Decimal(unitPrice).toFixed(2),
      });
    }
    const gross = new Decimal(roundMoney(new Decimal(line.quantity).times(unitPrice), currency));
    const lineDiscount = discountAmount(gross, line.discount, currency, `« ${product.name} »`);
    return { line, unitPrice, gross, lineDiscount, net: gross.minus(lineDiscount) };
  });

  // 2. Remise du ticket, répartie au prorata des lignes (utile pour rembourser un retour au juste prix)
  const netTotal = draft.reduce((sum, item) => sum.plus(item.net), new Decimal(0));
  if (input.discount?.type === "amount") {
    assertCurrencyAmount(access, input.discount.value, "Remise");
  }
  const cartDiscount = discountAmount(netTotal, input.discount, currency, "Ticket");
  let allocated = new Decimal(0);
  const lines: PricedLine[] = draft.map((item, index) => {
    const isLast = index === draft.length - 1;
    const share = netTotal.isZero()
      ? new Decimal(0)
      : isLast
        ? cartDiscount.minus(allocated)
        : new Decimal(roundMoney(cartDiscount.times(item.net).dividedBy(netTotal), currency));
    allocated = allocated.plus(share);
    const discount = item.lineDiscount.plus(share);
    return {
      productId: item.line.productId,
      quantity: item.line.quantity,
      unitPrice: new Decimal(item.unitPrice).toFixed(2),
      gross: item.gross.toFixed(2),
      discount: discount.toFixed(2),
      lineTotal: item.gross.minus(discount).toFixed(2),
    };
  });

  const subtotal = lines.reduce((sum, line) => sum.plus(line.gross), new Decimal(0));
  const discountTotal = lines.reduce((sum, line) => sum.plus(line.discount), new Decimal(0));

  // 3. Plafond de remise des caissiers (RB-10) : au-delà, permission sales.discount
  if (discountTotal.greaterThan(0) && !access.permissions.has("sales.discount")) {
    const percent = discountTotal.dividedBy(subtotal).times(100);
    if (percent.greaterThan(maxCashierDiscountPercent)) {
      throw AppError.forbidden(
        `Remise de ${percent.toDecimalPlaces(1).toString()} % : au-delà de ${maxCashierDiscountPercent} %, l'accord d'un gérant est nécessaire`,
      );
    }
  }
  // Prix modifié en caisse : permission sales.price_override (RB-10)
  if (priceOverrides.length > 0 && !access.permissions.has("sales.price_override")) {
    throw AppError.forbidden("Modifier un prix en caisse nécessite l'accord d'un gérant");
  }

  return {
    lines,
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    total: subtotal.minus(discountTotal).toFixed(2),
    priceOverrides,
  };
}

export interface SettledPayment {
  methodId: string;
  amount: string;
  reference?: string;
}

/**
 * Règlement : montants payés, monnaie rendue (uniquement sur les espèces) et reste dû.
 * Ex. total 4 500, client donne 5 000 en espèces → paiement enregistré 4 500, rendu 500.
 */
export function settlePayments(
  total: string,
  payments: { methodId: string; amount: string; reference?: string }[],
  isCash: (methodId: string) => boolean,
): { payments: SettledPayment[]; amountPaid: string; changeGiven: string; balanceDue: string } {
  const paid = payments.reduce((sum, payment) => sum.plus(payment.amount), new Decimal(0));
  let excess = Decimal.max(0, paid.minus(total));
  const change = excess;

  const cashTotal = payments.filter((payment) => isCash(payment.methodId)).reduce((sum, p) => sum.plus(p.amount), new Decimal(0));
  if (excess.greaterThan(cashTotal)) {
    throw AppError.badRequest("Le montant payé dépasse le total : seules les espèces permettent de rendre la monnaie");
  }

  // La monnaie rendue est retirée des paiements en espèces, en partant du dernier
  const settled = payments.map((payment) => ({ ...payment, amount: new Decimal(payment.amount) }));
  for (let index = settled.length - 1; index >= 0 && excess.greaterThan(0); index--) {
    const payment = settled[index]!;
    if (!isCash(payment.methodId)) continue;
    const taken = Decimal.min(payment.amount, excess);
    payment.amount = payment.amount.minus(taken);
    excess = excess.minus(taken);
  }

  const amountPaid = paid.minus(change);
  return {
    payments: settled
      .filter((payment) => payment.amount.greaterThan(0))
      .map((payment) => ({ ...payment, amount: payment.amount.toFixed(2) })),
    amountPaid: amountPaid.toFixed(2),
    changeGiven: change.toFixed(2),
    balanceDue: new Decimal(total).minus(amountPaid).toFixed(2),
  };
}
