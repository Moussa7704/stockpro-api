/**
 * Catalogue des permissions et rôles par défaut (cahier des charges §1.1).
 * Une permission est une chaîne "domaine.action" vérifiée par requirePermission().
 * Les rôles système sont créés automatiquement pour chaque nouvelle entreprise.
 */

export const PERMISSIONS = [
  "company.manage",
  "users.manage",
  "products.view",
  "products.manage",
  "prices.manage",
  "stock.view",
  "stock.adjust",
  "stock.transfer",
  "purchases.manage",
  "supplier_payments.manage",
  "sales.create",
  "sales.discount",
  "sales.price_override",
  "sales.cancel_refund",
  "cash_sessions.manage",
  "customers.manage",
  "customer_payments.manage",
  "expenses.manage",
  "reports.view",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLE_CODES = ["owner", "manager", "cashier", "stock_keeper", "accountant"] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

interface SystemRoleDefinition {
  name: string;
  // Rôle qui voit toutes les boutiques par défaut (sinon : boutiques attribuées une par une)
  allShopsByDefault: boolean;
  permissions: readonly Permission[];
}

export const SYSTEM_ROLES: Record<SystemRoleCode, SystemRoleDefinition> = {
  owner: {
    name: "Propriétaire",
    allShopsByDefault: true,
    // Le propriétaire a tout
    permissions: PERMISSIONS,
  },
  manager: {
    name: "Gérant",
    allShopsByDefault: false,
    permissions: [
      "products.view",
      "products.manage",
      "prices.manage",
      "stock.view",
      "stock.adjust",
      "stock.transfer",
      "purchases.manage",
      "sales.create",
      "sales.discount",
      "sales.price_override",
      "sales.cancel_refund",
      "cash_sessions.manage",
      "customers.manage",
      "customer_payments.manage",
      "expenses.manage",
      "reports.view",
    ],
  },
  cashier: {
    name: "Caissier",
    allShopsByDefault: false,
    permissions: [
      "products.view",
      "stock.view",
      "sales.create",
      "cash_sessions.manage",
      "customers.manage",
      "customer_payments.manage",
    ],
  },
  stock_keeper: {
    name: "Gestionnaire de stock",
    allShopsByDefault: false,
    permissions: [
      "products.view",
      "products.manage",
      "stock.view",
      "stock.adjust",
      "stock.transfer",
      "purchases.manage",
    ],
  },
  accountant: {
    name: "Comptable",
    allShopsByDefault: true,
    permissions: [
      "products.view",
      "stock.view",
      "supplier_payments.manage",
      "cash_sessions.manage",
      "customers.manage",
      "customer_payments.manage",
      "expenses.manage",
      "reports.view",
      "audit.view",
    ],
  },
};
