import { Company, Shop, User } from "../../models/index.js";
import type { CompanyAccess } from "../access/access.service.js";
import { getSale } from "./sales.service.js";

/**
 * Ticket de caisse : données structurées (pour une mise en page côté front) et version texte
 * pour une imprimante thermique 80 mm (42 caractères par ligne).
 */

const WIDTH = 42;

// "1500.00" → "1 500" (FCFA) sans passer par un nombre flottant
function formatAmount(value: string, currency: string): string {
  const [integer = "0", fraction = "00"] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return currency === "XOF" ? grouped : `${grouped},${fraction}`;
}

function formatQuantity(value: string): string {
  return value.replace(/\.?0+$/, "").replace(".", ",");
}

function leftRight(left: string, right: string): string {
  const space = Math.max(1, WIDTH - left.length - right.length);
  return `${left}${" ".repeat(space)}${right}`.slice(0, Math.max(WIDTH, left.length + right.length + 1));
}

function center(text: string): string {
  const padding = Math.max(0, Math.floor((WIDTH - text.length) / 2));
  return `${" ".repeat(padding)}${text}`;
}

interface TicketLine {
  name: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
}

export async function buildTicket(access: CompanyAccess, saleId: string) {
  const sale = (await getSale(access, saleId)) as Record<string, unknown> & {
    number: string;
    status: string;
    shopId: string;
    createdBy: string;
    createdAt: Date;
    subtotal: string;
    discountTotal: string;
    total: string;
    amountPaid: string;
    changeGiven: string;
    balanceDue: string;
    customer: { name: string } | null;
    lines: { quantity: string; unitPrice: string; discount: string; lineTotal: string; product: { name: string } }[];
    payments: { amount: string; paymentMethod: { name: string } }[];
  };
  const [company, shop, cashier] = await Promise.all([
    Company.findByPk(access.companyId, { attributes: ["name", "currency"] }),
    Shop.findByPk(sale.shopId, { attributes: ["name", "address", "phone"] }),
    User.findByPk(sale.createdBy, { attributes: ["name"] }),
  ]);
  const currency = company!.currency;

  const lines: TicketLine[] = sale.lines.map((line) => ({
    name: line.product.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discount: line.discount,
    total: line.lineTotal,
  }));

  const date = new Date(sale.createdAt);
  const text = [
    center(company!.name),
    center(shop!.name),
    ...(shop!.address ? [center(shop!.address)] : []),
    ...(shop!.phone ? [center(`Tél. ${shop!.phone}`)] : []),
    "-".repeat(WIDTH),
    `Ticket ${sale.number}`,
    `${date.toLocaleDateString("fr-FR")} ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`,
    `Caisse : ${cashier?.name ?? ""}`,
    ...(sale.customer ? [`Client : ${sale.customer.name}`] : []),
    ...(sale.status === "cancelled" ? [center("*** VENTE ANNULÉE ***")] : []),
    "-".repeat(WIDTH),
    ...lines.flatMap((line) => [
      line.name.slice(0, WIDTH),
      leftRight(
        `  ${formatQuantity(line.quantity)} x ${formatAmount(line.unitPrice, currency)}`,
        formatAmount(line.total, currency),
      ),
      ...(Number(line.discount) > 0 ? [`  dont remise -${formatAmount(line.discount, currency)}`] : []),
    ]),
    "-".repeat(WIDTH),
    ...(Number(sale.discountTotal) > 0
      ? [
          leftRight("Sous-total", formatAmount(sale.subtotal, currency)),
          leftRight("Remises", `-${formatAmount(sale.discountTotal, currency)}`),
        ]
      : []),
    leftRight(`TOTAL ${currency === "XOF" ? "FCFA" : currency}`, formatAmount(sale.total, currency)),
    ...sale.payments.map((payment) => leftRight(payment.paymentMethod.name, formatAmount(payment.amount, currency))),
    ...(Number(sale.changeGiven) > 0 ? [leftRight("Monnaie rendue", formatAmount(sale.changeGiven, currency))] : []),
    ...(Number(sale.balanceDue) > 0 ? [leftRight("Reste dû (crédit)", formatAmount(sale.balanceDue, currency))] : []),
    "-".repeat(WIDTH),
    center("Merci de votre visite !"),
  ]
    // Une imprimante 80 mm coupe au-delà de 42 caractères : on tronque nous-mêmes, proprement
    .map((line) => line.slice(0, WIDTH))
    .join("\n");

  return {
    company: company!.name,
    shop: { name: shop!.name, address: shop!.address, phone: shop!.phone },
    number: sale.number,
    status: sale.status,
    date: sale.createdAt,
    cashier: cashier?.name ?? null,
    customer: sale.customer?.name ?? null,
    currency,
    lines,
    subtotal: sale.subtotal,
    discountTotal: sale.discountTotal,
    total: sale.total,
    payments: sale.payments.map((payment) => ({ method: payment.paymentMethod.name, amount: payment.amount })),
    changeGiven: sale.changeGiven,
    balanceDue: sale.balanceDue,
    text,
  };
}
