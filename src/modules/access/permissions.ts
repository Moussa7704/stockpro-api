/**
 * Catalogue des permissions et rôles par défaut (cahier des charges §1.1).
 * Une permission est une chaîne "domaine.action" vérifiée par requirePermission().
 * Les rôles système sont créés automatiquement pour chaque nouvelle entreprise.
 */

export const PERMISSIONS = [
  "company.manage",
  "users.manage",
  "roles.manage",
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

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Libellés et regroupement pour les écrans de gestion des droits (cases à cocher). */
export const PERMISSION_GROUPS: { label: string; permissions: { code: Permission; label: string }[] }[] = [
  {
    label: "Administration",
    permissions: [
      { code: "company.manage", label: "Paramétrer l'entreprise, les boutiques et les moyens de paiement" },
      { code: "users.manage", label: "Gérer l'équipe : inviter, changer les rôles, accorder des droits" },
      { code: "roles.manage", label: "Créer et modifier les rôles" },
      { code: "audit.view", label: "Consulter le journal d'audit" },
    ],
  },
  {
    label: "Catalogue",
    permissions: [
      { code: "products.view", label: "Voir les produits" },
      { code: "products.manage", label: "Créer et modifier les produits" },
      { code: "prices.manage", label: "Modifier les prix de vente" },
    ],
  },
  {
    label: "Stock",
    permissions: [
      { code: "stock.view", label: "Voir le stock" },
      { code: "stock.adjust", label: "Ajuster le stock et faire les inventaires" },
      { code: "stock.transfer", label: "Transférer entre boutiques" },
    ],
  },
  {
    label: "Achats",
    permissions: [
      { code: "purchases.manage", label: "Commandes, réceptions et retours fournisseurs" },
      { code: "supplier_payments.manage", label: "Factures et paiements fournisseurs" },
    ],
  },
  {
    label: "Caisse",
    permissions: [
      { code: "sales.create", label: "Vendre" },
      { code: "sales.discount", label: "Accorder des remises" },
      { code: "sales.price_override", label: "Modifier le prix à la caisse" },
      { code: "sales.cancel_refund", label: "Annuler une vente, faire un retour client" },
      { code: "cash_sessions.manage", label: "Ouvrir et clôturer une session de caisse" },
    ],
  },
  {
    label: "Clients et finances",
    permissions: [
      { code: "customers.manage", label: "Gérer les clients" },
      { code: "customer_payments.manage", label: "Encaisser les règlements de dette" },
      { code: "expenses.manage", label: "Enregistrer les dépenses" },
      { code: "reports.view", label: "Voir les rapports, les marges et les coûts" },
    ],
  },
];

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
      // Paramètres de l'entreprise ; boutiques modifiables seulement dans son périmètre
      "company.manage",
      // Délégation : ajuster les droits de son équipe, jamais au-delà des siens (voir delegation.ts)
      "users.manage",
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
