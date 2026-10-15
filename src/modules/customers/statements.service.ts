import { QueryTypes } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Company } from "../../models/index.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import type { DebtorsQuery, StatementQuery } from "./customers.schemas.js";
import { findCustomer } from "./customers.service.js";

/**
 * Relevé de compte client et suivi des impayés. Les bornes de dates sont des jours du fuseau de
 * l'entreprise (stockage en UTC) : "du 1er au 31" couvre bien ces journées à Dakar ou Abidjan.
 */

async function companyTimezone(companyId: string): Promise<string> {
  const company = await Company.findByPk(companyId, { attributes: ["timezone"] });
  return company!.timezone;
}

interface StatementRow {
  id: string;
  type: string;
  amount: string;
  balance_after: string;
  source_type: string;
  source_id: string;
  reference: string | null;
  created_at: Date;
}

export async function getStatement(access: CompanyAccess, customerId: string, query: StatementQuery) {
  const customer = await findCustomer(access.companyId, customerId);
  const timezone = await companyTimezone(access.companyId);
  // [début du jour "from", début du lendemain de "to"[ dans le fuseau de l'entreprise
  const replacements = { companyId: access.companyId, customerId, from: query.from, to: query.to, timezone };
  const range = `e.created_at >= (CAST(:from AS date)::timestamp AT TIME ZONE :timezone)
                 AND e.created_at < ((CAST(:to AS date) + 1)::timestamp AT TIME ZONE :timezone)`;

  const [opening] = await sequelize.query<{ amount: string }>(
    `SELECT COALESCE(sum(e.amount), 0) AS amount FROM customer_ledger_entries e
     WHERE e.company_id = :companyId AND e.customer_id = :customerId
       AND e.created_at < (CAST(:from AS date)::timestamp AT TIME ZONE :timezone)`,
    { replacements, type: QueryTypes.SELECT },
  );
  // Référence lisible : n° de ticket, n° de retour ou moyen de paiement du règlement
  const rows = await sequelize.query<StatementRow>(
    `SELECT e.id, e.type, e.amount, e.balance_after, e.source_type, e.source_id, e.created_at,
            COALESCE(s.number, r.number, pm.name) AS reference
     FROM customer_ledger_entries e
     LEFT JOIN sales s ON e.source_type = 'sale' AND s.id = e.source_id
     LEFT JOIN sale_returns r ON e.source_type = 'sale_return' AND r.id = e.source_id
     LEFT JOIN customer_payments p ON e.source_type = 'customer_payment' AND p.id = e.source_id
     LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
     WHERE e.company_id = :companyId AND e.customer_id = :customerId AND ${range}
     ORDER BY e.created_at, e.id`,
    { replacements, type: QueryTypes.SELECT },
  );

  const openingBalance = new Decimal(opening!.amount);
  let debits = new Decimal(0);
  let credits = new Decimal(0);
  for (const row of rows) {
    const amount = new Decimal(row.amount);
    if (amount.isPositive()) {
      debits = debits.plus(amount);
    } else {
      credits = credits.minus(amount);
    }
  }

  return {
    customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email },
    currency: access.currency,
    timezone,
    from: query.from,
    to: query.to,
    openingBalance: openingBalance.toFixed(2),
    totalDebits: debits.toFixed(2),
    totalCredits: credits.toFixed(2),
    closingBalance: openingBalance.plus(debits).minus(credits).toFixed(2),
    entries: rows.map((row) => ({
      id: row.id,
      date: row.created_at,
      type: row.type,
      reference: row.reference,
      sourceType: row.source_type,
      sourceId: row.source_id,
      // Débit : ce que le client doit en plus ; crédit : ce qui réduit sa dette
      debit: new Decimal(row.amount).isPositive() ? new Decimal(row.amount).toFixed(2) : "0.00",
      credit: new Decimal(row.amount).isNegative() ? new Decimal(row.amount).negated().toFixed(2) : "0.00",
      balance: new Decimal(row.balance_after).toFixed(2),
    })),
  };
}

const BUCKETS = ["current", "days31To60", "days61To90", "over90"] as const;
type Aging = Record<(typeof BUCKETS)[number], string>;

const emptyAging = (): Record<(typeof BUCKETS)[number], Decimal> => ({
  current: new Decimal(0),
  days31To60: new Decimal(0),
  days61To90: new Decimal(0),
  over90: new Decimal(0),
});

/**
 * Clients débiteurs avec l'ancienneté de leur dette. Les règlements soldent d'abord les dettes
 * les plus anciennes (FIFO) : la dette restante correspond donc aux débits les plus récents.
 */
export async function listDebtors(access: CompanyAccess, query: DebtorsQuery) {
  const replacements = {
    companyId: access.companyId,
    minAmount: query.minAmount ?? "0",
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
  const debtorsFilter = `c.company_id = :companyId AND c.balance > 0 AND c.balance >= :minAmount`;

  const [totals] = await sequelize.query<{ count: string; amount: string }>(
    `SELECT count(*) AS count, COALESCE(sum(c.balance), 0) AS amount FROM customers c WHERE ${debtorsFilter}`,
    { replacements, type: QueryTypes.SELECT },
  );
  const customers = await sequelize.query<{
    id: string;
    name: string;
    phone: string | null;
    balance: string;
    credit_limit: string | null;
    archived_at: Date | null;
  }>(
    `SELECT c.id, c.name, c.phone, c.balance, c.credit_limit, c.archived_at FROM customers c
     WHERE ${debtorsFilter} ORDER BY c.balance DESC, c.name LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT },
  );

  const ids = customers.map((customer) => customer.id);
  const portions =
    ids.length === 0
      ? []
      : await sequelize.query<{ customer_id: string; amount: string; age_days: number; created_at: Date }>(
          // newer = débits plus récents ; la part non couverte par eux est la dette restante de ce débit
          `WITH debits AS (
             SELECT e.customer_id, e.amount, e.created_at,
                    COALESCE(sum(e.amount) OVER (
                      PARTITION BY e.customer_id ORDER BY e.created_at DESC, e.id DESC
                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS newer
             FROM customer_ledger_entries e
             WHERE e.company_id = :companyId AND e.amount > 0 AND e.customer_id IN (:ids)
           )
           SELECT d.customer_id, d.created_at,
                  LEAST(d.amount, c.balance - d.newer) AS amount,
                  floor(EXTRACT(EPOCH FROM now() - d.created_at) / 86400)::int AS age_days
           FROM debits d JOIN customers c ON c.id = d.customer_id
           WHERE d.newer < c.balance`,
          { replacements: { ...replacements, ids }, type: QueryTypes.SELECT },
        );

  const items = customers.map((customer) => {
    const aging = emptyAging();
    let oldest: Date | null = null;
    for (const portion of portions.filter((row) => row.customer_id === customer.id)) {
      const bucket = portion.age_days <= 30 ? "current" : portion.age_days <= 60 ? "days31To60" : portion.age_days <= 90 ? "days61To90" : "over90";
      aging[bucket] = aging[bucket].plus(portion.amount);
      if (!oldest || portion.created_at < oldest) {
        oldest = portion.created_at;
      }
    }
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      balance: new Decimal(customer.balance).toFixed(2),
      creditLimit: customer.credit_limit,
      archived: customer.archived_at !== null,
      oldestUnpaidAt: oldest,
      aging: Object.fromEntries(BUCKETS.map((bucket) => [bucket, aging[bucket].toFixed(2)])) as Aging,
    };
  });

  return {
    items,
    total: Number(totals!.count),
    totalDebt: new Decimal(totals!.amount).toFixed(2),
    page: query.page,
    pageSize: query.pageSize,
  };
}
