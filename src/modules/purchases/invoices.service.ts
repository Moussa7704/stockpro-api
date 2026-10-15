import { Op, QueryTypes, type Transaction, type WhereOptions } from "sequelize";
import { sequelize } from "../../config/database.js";
import { GoodsReceipt, Supplier, SupplierInvoice, SupplierPayment } from "../../models/index.js";
import { AppError } from "../../utils/app-error.js";
import { Decimal } from "../../utils/decimal.js";
import type { CompanyAccess } from "../access/access.service.js";
import { recordAudit, type AuditActor } from "../audit/audit.service.js";
import { rethrowAsConflict } from "../catalog/catalog.helpers.js";
import { assertCurrencyAmount } from "./purchases.helpers.js";
import type { CreateInvoiceInput, CreateSupplierPaymentInput, ListInvoicesQuery } from "./purchases.schemas.js";

/**
 * Factures fournisseurs et paiements (RB-06) : suivis séparément des commandes et réceptions.
 * La dette d'un fournisseur = total facturé − payé, sur les factures non annulées.
 */

const today = () => new Date().toISOString().slice(0, 10);

function remaining(invoice: SupplierInvoice): string {
  return new Decimal(invoice.total).minus(invoice.amountPaid).toFixed(2);
}

function toDto(invoice: SupplierInvoice) {
  const isOpen = ["unpaid", "partially_paid"].includes(invoice.status);
  return {
    ...invoice.toJSON(),
    remaining: invoice.status === "cancelled" ? "0.00" : remaining(invoice),
    overdue: isOpen && !!invoice.dueDate && invoice.dueDate < today(),
  };
}

async function findInvoice(access: CompanyAccess, id: string, transaction?: Transaction, lock = false) {
  const invoice = await SupplierInvoice.findOne({
    where: { id, companyId: access.companyId },
    transaction,
    ...(lock && transaction && { lock: transaction.LOCK.UPDATE }),
  });
  if (!invoice) {
    throw AppError.notFound("Facture introuvable");
  }
  return invoice;
}

export async function getInvoice(access: CompanyAccess, id: string) {
  await findInvoice(access, id);
  const invoice = await SupplierInvoice.findByPk(id, {
    include: [
      { model: SupplierPayment, as: "payments" },
      { model: Supplier, as: "supplier", attributes: ["id", "name"] },
    ],
    order: [[{ model: SupplierPayment, as: "payments" }, "createdAt", "ASC"]],
  });
  return toDto(invoice!);
}

export async function listInvoices(access: CompanyAccess, query: ListInvoicesQuery) {
  const where: WhereOptions<SupplierInvoice> = {
    companyId: access.companyId,
    ...(query.supplierId && { supplierId: query.supplierId }),
    ...(query.status && { status: query.status }),
    ...(query.overdue && {
      status: { [Op.in]: ["unpaid", "partially_paid"] },
      dueDate: { [Op.lt]: today() },
    }),
  };
  const { rows, count } = await SupplierInvoice.findAndCountAll({
    where,
    include: [{ model: Supplier, as: "supplier", attributes: ["id", "name"] }],
    order: [
      ["dueDate", "ASC NULLS LAST"],
      ["invoiceDate", "ASC"],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: rows.map(toDto), total: count, page: query.page, pageSize: query.pageSize };
}

export async function createInvoice(access: CompanyAccess, input: CreateInvoiceInput, actor: AuditActor) {
  assertCurrencyAmount(access, input.total, "Montant de la facture");

  try {
    const id = await sequelize.transaction(async (transaction) => {
      // Un fournisseur archivé peut encore envoyer une facture pour une livraison passée
      const supplier = await Supplier.findOne({
        where: { id: input.supplierId, companyId: access.companyId },
        transaction,
      });
      if (!supplier) {
        throw AppError.badRequest("Fournisseur inconnu");
      }
      if (input.receiptId) {
        const receipt = await GoodsReceipt.findOne({
          where: { id: input.receiptId, companyId: access.companyId, supplierId: supplier.id, status: "validated" },
          transaction,
        });
        if (!receipt) {
          throw AppError.badRequest("Réception inconnue, non validée ou d'un autre fournisseur");
        }
      }

      const invoice = await SupplierInvoice.create(
        {
          companyId: access.companyId,
          supplierId: supplier.id,
          receiptId: input.receiptId ?? null,
          reference: input.reference,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate ?? null,
          total: input.total,
          notes: input.notes ?? null,
          createdBy: actor.actorUserId!,
        },
        { transaction },
      );
      await recordAudit(
        {
          ...actor,
          companyId: access.companyId,
          action: "supplier_invoice.create",
          entityType: "supplier_invoice",
          entityId: invoice.id,
          after: { supplier: supplier.name, reference: invoice.reference, total: invoice.total },
        },
        transaction,
      );
      return invoice.id;
    });
    return getInvoice(access, id);
  } catch (error) {
    rethrowAsConflict(error, {}, "Ce fournisseur a déjà une facture avec cette référence");
  }
}

/**
 * Paiement (total ou partiel). La facture est verrouillée : deux paiements simultanés ne
 * peuvent pas, ensemble, dépasser le reste dû (la base le vérifie aussi : amount_paid <= total).
 */
export async function addPayment(
  access: CompanyAccess,
  invoiceId: string,
  input: CreateSupplierPaymentInput,
  actor: AuditActor,
) {
  assertCurrencyAmount(access, input.amount, "Montant du paiement");

  await sequelize.transaction(async (transaction) => {
    const invoice = await findInvoice(access, invoiceId, transaction, true);
    if (!["unpaid", "partially_paid"].includes(invoice.status)) {
      throw AppError.conflict(invoice.status === "paid" ? "Cette facture est déjà réglée" : "Cette facture est annulée");
    }
    const due = new Decimal(remaining(invoice));
    if (new Decimal(input.amount).greaterThan(due)) {
      throw AppError.badRequest(`Le paiement dépasse le reste dû (${due.toFixed(2)})`);
    }

    const payment = await SupplierPayment.create(
      {
        companyId: access.companyId,
        supplierId: invoice.supplierId,
        invoiceId: invoice.id,
        amount: input.amount,
        method: input.method,
        paidAt: input.paidAt ?? today(),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        createdBy: actor.actorUserId!,
      },
      { transaction },
    );

    const amountPaid = new Decimal(invoice.amountPaid).plus(input.amount);
    const status = amountPaid.greaterThanOrEqualTo(invoice.total) ? "paid" : "partially_paid";
    const before = { amountPaid: invoice.amountPaid, status: invoice.status };
    await invoice.update({ amountPaid: amountPaid.toFixed(2), status }, { transaction });

    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "supplier_payment.create",
        entityType: "supplier_invoice",
        entityId: invoice.id,
        before,
        after: { amountPaid: invoice.amountPaid, status, payment: { id: payment.id, amount: payment.amount, method: payment.method } },
      },
      transaction,
    );
  });
  return getInvoice(access, invoiceId);
}

/** Annulation d'une facture saisie par erreur : uniquement si aucun paiement n'a été fait. */
export async function cancelInvoice(access: CompanyAccess, id: string, actor: AuditActor) {
  await sequelize.transaction(async (transaction) => {
    const invoice = await findInvoice(access, id, transaction, true);
    if (invoice.status !== "unpaid") {
      throw AppError.conflict("Seule une facture sans aucun paiement peut être annulée");
    }
    await invoice.update({ status: "cancelled" }, { transaction });
    await recordAudit(
      {
        ...actor,
        companyId: access.companyId,
        action: "supplier_invoice.cancel",
        entityType: "supplier_invoice",
        entityId: invoice.id,
        before: { status: "unpaid" },
        after: { status: "cancelled" },
      },
      transaction,
    );
  });
  return getInvoice(access, id);
}

/** Dettes fournisseurs : facturé, payé, reste dû et part échue, par fournisseur. */
export async function supplierBalances(access: CompanyAccess) {
  const rows = await sequelize.query<{
    supplier_id: string;
    name: string;
    invoiced: string;
    paid: string;
    outstanding: string;
    overdue: string;
    open_invoices: string;
  }>(
    `SELECT s.id AS supplier_id, s.name,
            COALESCE(SUM(i.total), 0) AS invoiced,
            COALESCE(SUM(i.amount_paid), 0) AS paid,
            COALESCE(SUM(i.total - i.amount_paid), 0) AS outstanding,
            COALESCE(SUM(i.total - i.amount_paid) FILTER (WHERE i.due_date < CURRENT_DATE), 0) AS overdue,
            COUNT(i.id) FILTER (WHERE i.status IN ('unpaid', 'partially_paid')) AS open_invoices
     FROM suppliers s
     JOIN supplier_invoices i ON i.company_id = s.company_id AND i.supplier_id = s.id AND i.status <> 'cancelled'
     WHERE s.company_id = :companyId
     GROUP BY s.id, s.name
     HAVING SUM(i.total - i.amount_paid) > 0
     ORDER BY outstanding DESC`,
    { replacements: { companyId: access.companyId }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => ({
    supplier: { id: row.supplier_id, name: row.name },
    invoiced: row.invoiced,
    paid: row.paid,
    outstanding: row.outstanding,
    overdue: row.overdue,
    openInvoices: Number(row.open_invoices),
  }));
}
