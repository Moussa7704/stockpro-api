/** Mise en forme lisible des montants et quantités (tickets, exports), sans passer par des flottants. */

// "1500.00" → "1 500" (FCFA), "1500.50" → "1 500,50" (autres devises)
export function formatAmount(value: string, currency: string): string {
  const negative = value.startsWith("-");
  const [integer = "0", fraction = "00"] = (negative ? value.slice(1) : value).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const formatted = currency === "XOF" ? grouped : `${grouped},${fraction.padEnd(2, "0").slice(0, 2)}`;
  return negative ? `-${formatted}` : formatted;
}

// "2.500" → "2,5" ; "3.000" → "3"
export function formatQuantity(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "").replace(".", ",") : value;
}

export function currencyLabel(currency: string): string {
  return currency === "XOF" ? "FCFA" : currency;
}
