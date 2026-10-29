import { z } from "zod";
import { auditQuerySchema } from "../modules/access/access.routes.js";
import * as catalog from "../modules/catalog/catalog.schemas.js";
import * as customers from "../modules/customers/customers.schemas.js";
import * as expenses from "../modules/expenses/expenses.schemas.js";
import * as pos from "../modules/pos/pos.schemas.js";
import * as purchases from "../modules/purchases/purchases.schemas.js";
import * as reports from "../modules/reports/reports.schemas.js";
import { listShopsQuerySchema } from "../modules/shops/shops.schemas.js";
import * as stock from "../modules/stock/stock.schemas.js";
import { includeArchivedQuerySchema, paginationSchema } from "../utils/query.js";

/**
 * Ce que le code ne dit pas tout seul : un résumé par route, une explication pour les routes
 * délicates, et les paramètres d'URL (?page=…) lus dans les handlers par parseQuery — avec les
 * MÊMES schémas zod que le code. Méthode, chemin, permission, body et idempotence sont, eux,
 * relus directement sur les routers (voir openapi.ts).
 *
 * Un test vérifie que chaque route montée a son entrée ici, et qu'aucune entrée n'est orpheline.
 */

export interface OperationDoc {
  summary: string;
  description?: string;
  query?: z.ZodType;
}

const withoutFormat = "Ajouter `?format=xlsx` ou `?format=pdf` pour télécharger le rapport (Excel ou PDF) au lieu du JSON.";
const period = "Période en jours du fuseau de l'entreprise (`from` et `to` inclus, AAAA-MM-JJ, deux ans au plus).";

export const operations: Record<string, OperationDoc> = {
  // --- Authentification
  "POST /api/auth/login": {
    summary: "Connexion, étape 1 : email + mot de passe",
    description:
      "Si les identifiants sont bons, un code à 6 chiffres est envoyé par email et la réponse contient un `challengeToken`. " +
      "Aucun token d'accès n'est délivré à cette étape.",
  },
  "POST /api/auth/login/otp": {
    summary: "Connexion, étape 2 : code reçu par email",
    description:
      "Avec le `challengeToken` et le code : renvoie l'`accessToken` (à envoyer en `Authorization: Bearer …`) et pose le " +
      "refresh token dans un cookie httpOnly. Si l'utilisateur a plusieurs entreprises, il choisit ensuite avec `POST /api/auth/company`.",
  },
  "POST /api/auth/login/otp/resend": { summary: "Renvoyer le code de connexion par email" },
  "POST /api/auth/refresh": {
    summary: "Nouveau token d'accès",
    description:
      "Utilise le refresh token du cookie httpOnly (rotation : l'ancien est invalidé, la session garde son identifiant). " +
      "Pas d'en-tête Authorization. 409 si un autre onglet vient de renouveler la même session : réessayer (le navigateur a déjà le nouveau cookie).",
  },
  "POST /api/auth/logout": { summary: "Déconnexion (révoque le refresh token du cookie)" },
  "GET /api/auth/me": { summary: "Utilisateur connecté, ses entreprises et ses droits dans l'entreprise active" },
  "GET /api/auth/sessions": {
    summary: "Appareils connectés : navigateur, adresse IP, connexion, dernière activité ; celui-ci en premier (current)",
  },
  "POST /api/auth/sessions/revoke-others": { summary: "Déconnecter tous les autres appareils (renvoie le nombre déconnecté)" },
  "DELETE /api/auth/sessions/:id": {
    summary: "Déconnecter un autre appareil",
    description: "Effet immédiat : ses access tokens sont refusés dès sa requête suivante. Pour l'appareil courant, utiliser /api/auth/logout.",
  },
  "POST /api/auth/company": {
    summary: "Choisir ou changer d'entreprise active",
    description: "Renvoie un nouveau token d'accès portant l'entreprise choisie : toutes les données sont ensuite filtrées sur elle.",
  },
  "POST /api/auth/password/forgot": { summary: "Mot de passe oublié : envoie un lien par email (réponse identique que l'email existe ou non)" },
  "POST /api/auth/password/check": { summary: "Vérifier qu'un lien d'invitation ou de réinitialisation est encore valide" },
  "POST /api/auth/password/reset": { summary: "Définir le mot de passe depuis un lien (invitation ou réinitialisation)" },
  "POST /api/auth/password/change": { summary: "Changer son mot de passe (les autres sessions sont fermées)" },

  // --- Plateforme
  "GET /api/platform/companies": { summary: "Lister les commerçants (entreprises clientes)" },
  "POST /api/platform/companies": {
    summary: "Créer un commerçant",
    description: "Crée l'entreprise, ses rôles, unités, moyens de paiement, catégories de dépenses, une première boutique et invite le propriétaire.",
  },
  "GET /api/platform/companies/:id": { summary: "Détail d'un commerçant : boutiques, membres, propriétaire et état de son invitation" },
  "POST /api/platform/companies/:id/owner/invitation": {
    summary: "Renvoyer l'invitation du propriétaire (compte pas encore activé)",
    description: "Nouveau lien par email, l'ancien ne sert plus. 409 si le compte est déjà activé ou le commerçant suspendu.",
  },
  "PATCH /api/platform/companies/:id": { summary: "Modifier ou suspendre un commerçant" },

  // --- Entreprise, boutiques, membres
  "GET /api/company": { summary: "Entreprise active (nom, devise, fuseau, réglages)" },
  "PATCH /api/company": {
    summary: "Modifier l'entreprise active (nom, fuseau, réglages de caisse, couleur de l'interface)",
    description:
      "`settings.brandColor` : couleur principale de l'interface au format #RRGGBB, refusée si le texte blanc " +
      "des boutons y est illisible (contraste < 4,5:1) ; null revient à la couleur StockPro. Renvoyée par /api/auth/me.",
  },
  "GET /api/shops": { summary: "Boutiques visibles par l'utilisateur", query: listShopsQuerySchema },
  "GET /api/shops/:id": { summary: "Détail d'une boutique" },
  "POST /api/shops": {
    summary: "Créer une boutique",
    description: "Un membre limité à certaines boutiques reçoit aussitôt l'accès à celle qu'il crée.",
  },
  "PATCH /api/shops/:id": { summary: "Modifier ou archiver une boutique" },
  "GET /api/members": {
    summary: "Membres de l'entreprise : rôle, boutiques, droits effectifs",
    description: "`editable` indique si l'utilisateur connecté peut modifier ce membre (jamais lui-même, jamais quelqu'un de plus puissant).",
  },
  "POST /api/members": { summary: "Ajouter un membre (invitation par email si le compte est nouveau)" },
  "PATCH /api/members/:id": { summary: "Changer le rôle, les boutiques ou désactiver un membre" },
  "POST /api/members/:id/invite": { summary: "Renvoyer l'invitation d'un membre" },
  "GET /api/members/:id/permissions": {
    summary: "Droits d'un membre : ceux de son rôle, ajouts, retraits, droits effectifs",
    description: "`grantable` liste les permissions que l'utilisateur connecté peut accorder ou retirer (cases à cocher actives).",
  },
  "PUT /api/members/:id/permissions": {
    summary: "Ajuster les droits d'un membre par rapport à son rôle (ajouts et retraits)",
    description:
      "Remplace les ajustements précédents. Ex. un gérant accorde `sales.create` et `cash_sessions.manage` à un gestionnaire de stock. " +
      "Délégation : on n'accorde ou ne retire que des permissions qu'on possède, à un membre moins puissant que soi, jamais à soi-même.",
  },

  // --- Catalogue
  "GET /api/units": { summary: "Unités de vente (pièce, kg, litre…)", query: includeArchivedQuerySchema },
  "POST /api/units": { summary: "Créer une unité" },
  "PATCH /api/units/:id": { summary: "Modifier ou archiver une unité" },
  "GET /api/categories": { summary: "Catégories de produits (liste à plat avec parentId)", query: includeArchivedQuerySchema },
  "POST /api/categories": { summary: "Créer une catégorie" },
  "PATCH /api/categories/:id": { summary: "Modifier, déplacer ou archiver une catégorie" },
  "GET /api/suppliers": { summary: "Fournisseurs", query: catalog.listSuppliersQuerySchema },
  "GET /api/suppliers/:id": { summary: "Détail d'un fournisseur" },
  "POST /api/suppliers": { summary: "Créer un fournisseur" },
  "PATCH /api/suppliers/:id": { summary: "Modifier ou archiver un fournisseur" },
  "GET /api/products": { summary: "Produits (recherche, filtres, pagination)", query: catalog.listProductsQuerySchema },
  "GET /api/products/lookup": {
    summary: "Trouver un produit par code-barres ou SKU (caisse, scan)",
    query: catalog.lookupProductQuerySchema,
  },
  "GET /api/products/import/template": { summary: "Modèle Excel vierge pour l'import de produits" },
  "POST /api/products/import/analyze": {
    summary: "Import, étape 1 : lire le fichier du commerçant (.xlsx ou .csv)",
    description:
      "Renvoie les colonnes trouvées, 10 lignes d'exemple et la correspondance proposée colonne → champ " +
      "(« Désignation » → nom, « PU » → prix de vente…). Rien n'est écrit.",
  },
  "POST /api/products/import": {
    summary: "Import, étapes 2 et 3 : aperçu (dryRun) puis import des produits",
    description:
      "Même fichier + `options` (correspondance des colonnes, unité par défaut…). Chaque ligne est classée : " +
      "`create`, `existing` (même SKU ou code-barres : non modifié), `skipped` (ligne sans nom, total…) ou `error`. " +
      "Avec `dryRun: true`, rien n'est écrit. Sinon c'est tout ou rien : une seule ligne en erreur → 400 avec le rapport " +
      "dans `details`. SKU absent → généré (`ART-000001`…). Catégories inconnues créées si `createCategories`.\n\n" +
      "**Stock de départ** : colonne `quantity` + `shopId` (permission `stock.adjust` en plus). Une seule pièce " +
      "« stock d'ouverture » pour tout le fichier, valorisée au prix d'achat de la ligne. Premier remplissage seulement : " +
      "un produit qui a déjà eu du stock dans la boutique garde le sien (`stock: already_stocked`) — réimporter ne double jamais.",
  },
  "GET /api/products/:id": { summary: "Détail d'un produit" },
  "POST /api/products": { summary: "Créer un produit" },
  "PATCH /api/products/:id": { summary: "Modifier un produit (le changement de prix exige prices.manage et est audité)" },

  // --- Stock
  "GET /api/stock": { summary: "Niveaux de stock par boutique et produit", query: stock.listStockQuerySchema },
  "GET /api/stock/alerts": {
    summary: "Produits à réapprovisionner : ruptures (en tête) et stock au niveau ou sous le seuil d'alerte",
    query: z.object({ shopId: z.uuid().optional() }),
  },
  "GET /api/stock/movements": { summary: "Journal des mouvements de stock", query: stock.listMovementsQuerySchema },
  "GET /api/stock/products/:id": { summary: "Stock d'un produit dans chaque boutique" },
  "GET /api/stock/adjustments": { summary: "Ajustements de stock", query: stock.listDocumentsQuerySchema },
  "GET /api/stock/adjustments/:id": { summary: "Détail d'un ajustement" },
  "POST /api/stock/adjustments": { summary: "Ajuster le stock (stock initial, casse, perte, correction…)" },
  "GET /api/stock/transfers": { summary: "Transferts entre boutiques", query: stock.listTransfersQuerySchema },
  "GET /api/stock/transfers/:id": { summary: "Détail d'un transfert" },
  "POST /api/stock/transfers": { summary: "Préparer un transfert (brouillon)" },
  "POST /api/stock/transfers/:id/ship": { summary: "Expédier un transfert (le stock sort de la boutique d'origine)" },
  "POST /api/stock/transfers/:id/receive": { summary: "Réceptionner un transfert (quantités reçues, écarts tracés)" },
  "POST /api/stock/transfers/:id/cancel": { summary: "Annuler un transfert non expédié" },
  "GET /api/stock/inventories": { summary: "Inventaires", query: stock.listDocumentsQuerySchema },
  "GET /api/stock/inventories/:id": { summary: "Détail d'un inventaire et de ses lignes" },
  "POST /api/stock/inventories": { summary: "Ouvrir un inventaire (photo du stock théorique)" },
  "PUT /api/stock/inventories/:id/lines": { summary: "Saisir les quantités comptées" },
  "POST /api/stock/inventories/:id/validate": { summary: "Valider l'inventaire (les écarts deviennent des mouvements)" },
  "POST /api/stock/inventories/:id/cancel": { summary: "Annuler un inventaire en cours" },

  // --- Achats
  "GET /api/purchases/orders": { summary: "Bons de commande fournisseur", query: purchases.listOrdersQuerySchema },
  "GET /api/purchases/orders/:id": { summary: "Détail d'un bon de commande" },
  "POST /api/purchases/orders": { summary: "Créer un bon de commande (brouillon)" },
  "PATCH /api/purchases/orders/:id": { summary: "Modifier un bon de commande en brouillon" },
  "POST /api/purchases/orders/:id/send": { summary: "Envoyer le bon de commande au fournisseur" },
  "POST /api/purchases/orders/:id/cancel": { summary: "Annuler un bon de commande" },
  "POST /api/purchases/orders/:id/close": { summary: "Clôturer un bon de commande partiellement reçu" },
  "GET /api/purchases/receipts": { summary: "Réceptions de marchandise", query: purchases.listReceiptsQuerySchema },
  "GET /api/purchases/receipts/:id": { summary: "Détail d'une réception" },
  "POST /api/purchases/receipts": { summary: "Saisir une réception (brouillon, avec ou sans bon de commande)" },
  "POST /api/purchases/receipts/:id/validate": {
    summary: "Valider une réception : entrée en stock et recalcul du coût moyen pondéré",
  },
  "POST /api/purchases/receipts/:id/cancel": { summary: "Annuler une réception en brouillon" },
  "GET /api/purchases/returns": { summary: "Retours fournisseur", query: purchases.listReturnsQuerySchema },
  "GET /api/purchases/returns/:id": { summary: "Détail d'un retour fournisseur" },
  "POST /api/purchases/returns": { summary: "Préparer un retour fournisseur (brouillon)" },
  "POST /api/purchases/returns/:id/validate": { summary: "Valider un retour fournisseur (sortie de stock)" },
  "POST /api/purchases/returns/:id/cancel": { summary: "Annuler un retour fournisseur en brouillon" },
  "GET /api/purchases/invoices": { summary: "Factures fournisseur", query: purchases.listInvoicesQuerySchema },
  "GET /api/purchases/invoices/:id": { summary: "Détail d'une facture et de ses paiements" },
  "POST /api/purchases/invoices": { summary: "Enregistrer une facture fournisseur" },
  "POST /api/purchases/invoices/:id/payments": { summary: "Payer une facture (jamais plus que le reste dû)" },
  "POST /api/purchases/invoices/:id/cancel": { summary: "Annuler une facture sans paiement" },
  "GET /api/purchases/supplier-balances": { summary: "Dettes fournisseurs : reste dû par fournisseur" },

  // --- Clients et créances
  "GET /api/customers": { summary: "Clients (recherche, filtre débiteurs)", query: customers.listCustomersQuerySchema },
  "GET /api/customers/debtors": {
    summary: "Impayés : clients débiteurs et ancienneté de la dette (0-30, 31-60, 61-90, +90 jours)",
    query: customers.debtorsQuerySchema,
  },
  "GET /api/customers/payments/:id": { summary: "Détail d'un règlement client" },
  "GET /api/customers/:id": { summary: "Fiche client : solde, crédit disponible, derniers achats" },
  "GET /api/customers/:id/ledger": { summary: "Compte client : écritures (ventes à crédit, règlements, retours…)", query: paginationSchema },
  "POST /api/customers": { summary: "Créer un client (le plafond de crédit exige reports.view)" },
  "PATCH /api/customers/:id": { summary: "Modifier ou archiver un client" },
  "GET /api/customers/:id/statement": {
    summary: "Relevé de compte sur une période (solde d'ouverture, mouvements, solde de clôture)",
    description: period,
    query: customers.statementQuerySchema,
  },
  "GET /api/customers/:id/payments": { summary: "Règlements d'un client", query: paginationSchema },
  "POST /api/customers/:id/payments": {
    summary: "Encaisser un règlement de dette",
    description: "Jamais plus que la dette. En espèces : session de caisse ouverte obligatoire, l'argent entre dans ce tiroir.",
  },

  // --- Dépenses
  "GET /api/expenses/categories": { summary: "Catégories de dépenses", query: includeArchivedQuerySchema },
  "POST /api/expenses/categories": { summary: "Créer une catégorie de dépenses" },
  "PATCH /api/expenses/categories/:id": { summary: "Renommer ou archiver une catégorie de dépenses" },
  "GET /api/expenses": { summary: "Dépenses (filtres, total hors annulées)", query: expenses.listExpensesQuerySchema },
  "GET /api/expenses/:id": { summary: "Détail d'une dépense" },
  "POST /api/expenses": {
    summary: "Enregistrer une dépense",
    description: "Avec `cashSessionId` (espèces uniquement) : payée depuis ce tiroir-caisse, les espèces attendues à la clôture diminuent.",
  },
  "POST /api/expenses/:id/cancel": { summary: "Annuler une dépense (impossible si sa session de caisse est clôturée)" },

  // --- Caisse
  "GET /api/payment-methods": {
    summary: "Moyens de paiement",
    query: z.object({ includeInactive: z.stringbool().default(false) }),
  },
  "POST /api/payment-methods": { summary: "Créer un moyen de paiement" },
  "PATCH /api/payment-methods/:id": { summary: "Modifier ou désactiver un moyen de paiement" },
  "GET /api/pos/sessions": { summary: "Sessions de caisse (un caissier ne voit que les siennes)", query: pos.listSessionsQuerySchema },
  "GET /api/pos/sessions/current": {
    summary: "Ma session ouverte dans une boutique (null s'il n'y en a pas)",
    query: z.object({ shopId: z.uuid() }),
  },
  "GET /api/pos/sessions/:id": { summary: "Détail d'une session et ses totaux (espèces attendues…)" },
  "POST /api/pos/sessions": { summary: "Ouvrir une session de caisse avec un fond de caisse" },
  "POST /api/pos/sessions/:id/close": { summary: "Clôturer : montant compté, écart enregistré et audité" },
  "GET /api/pos/sales": { summary: "Ventes (un caissier ne voit que les siennes)", query: pos.listSalesQuerySchema },
  "GET /api/pos/sales/:id": { summary: "Détail d'une vente" },
  "GET /api/pos/sales/:id/ticket": {
    summary: "Ticket de caisse",
    description: "JSON structuré, ou texte 42 colonnes pour imprimante thermique avec `?format=text`.",
    query: z.object({ format: z.enum(["text"]).optional() }),
  },
  "POST /api/pos/sales": {
    summary: "Enregistrer une vente",
    description:
      "Totaux calculés par le serveur (jamais envoyés par le client). Session de caisse ouverte obligatoire. " +
      "En cas de coupure réseau, rejouer la requête avec la MÊME clé d'idempotence : la vente n'est jamais enregistrée deux fois.",
  },
  "POST /api/pos/sales/:id/cancel": { summary: "Annuler une vente (stock restitué, crédit client annulé)" },
  "GET /api/pos/returns/:id": { summary: "Détail d'un retour client" },
  "POST /api/pos/returns": { summary: "Retour client : remboursement par un moyen de paiement ou sur le compte du client" },

  // --- Rapports
  "GET /api/reports/dashboard": {
    summary: "Tableau de bord : jour, veille, mois, période choisie, top produits, stock, créances, caisses ouvertes",
    description:
      "Période facultative `from`/`to` (jours du fuseau de l'entreprise, bornes incluses, au plus deux ans, jamais après aujourd'hui) : " +
      "une date (from = to), un mois (du 1er au dernier jour) ou une période libre ; sans période, le mois en cours. " +
      "`period` donne ses chiffres, ceux de la période précédente (mois entiers → mois précédents, sinon autant de jours juste avant) " +
      "et un graphique par jour (par mois au-delà de 92 jours) ; le top produits suit la période. " +
      "`today`, `yesterday`, `month` et `last7Days` restent ceux du jour. Stock, alertes, créances et caisses : situation à l'instant.",
    query: reports.dashboardQuerySchema,
  },
  "GET /api/reports/sales": {
    summary: "Ventes par jour, semaine ou mois : CA, remises, retours, coût, marge",
    description: `${period} ${withoutFormat}`,
    query: reports.salesReportQuerySchema,
  },
  "GET /api/reports/top-products": {
    summary: "Meilleurs produits (par CA, quantité ou marge)",
    description: `${period} ${withoutFormat}`,
    query: reports.topProductsQuerySchema,
  },
  "GET /api/reports/stock-value": {
    summary: "Valeur du stock au coût moyen pondéré et au prix de vente",
    description: withoutFormat,
    query: reports.stockValueQuerySchema,
  },
  "GET /api/reports/expenses": {
    summary: "Dépenses par catégorie",
    description: `${period} ${withoutFormat}`,
    query: reports.periodQuerySchema,
  },
  "GET /api/reports/profit-and-loss": {
    summary: "Compte de résultat simplifié : CA net − coût des ventes − dépenses",
    description: `${period} ${withoutFormat}`,
    query: reports.periodQuerySchema,
  },

  // --- Rôles et audit
  "GET /api/permissions": { summary: "Catalogue des permissions, groupées et libellées (écrans de gestion des droits)" },
  "GET /api/roles": { summary: "Rôles de l'entreprise, leurs permissions et le nombre de membres" },
  "POST /api/roles": { summary: "Créer un rôle personnalisé (jamais au-delà de ses propres droits)" },
  "PATCH /api/roles/:id": {
    summary: "Modifier un rôle (nom, description, permissions)",
    description: "S'applique immédiatement à tous les membres qui ont ce rôle. Le rôle de propriétaire n'est pas modifiable.",
  },
  "DELETE /api/roles/:id": { summary: "Supprimer un rôle personnalisé que personne n'utilise" },
  "GET /api/audit-logs": { summary: "Journal d'audit (qui a fait quoi, avant/après)", query: auditQuerySchema },
};
