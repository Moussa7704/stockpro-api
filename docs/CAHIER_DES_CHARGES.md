# StockPro — Cahier des charges

> Version 1.0 — 15/10/2026. Document vivant : toute décision qui modifie une règle métier
> ou le modèle de données est ajoutée ici **avant** d'être codée.

**Proposition de valeur** : permettre à chaque commerçant de gérer ses boutiques, ses produits,
ses stocks, ses achats, ses ventes et ses finances depuis une application web centralisée.

| Sujet | Choix |
|---|---|
| Type | SaaS multi-commerçants (multi-tenant) |
| Architecture | Monolithe modulaire (un dossier par module : `src/modules/<module>`) |
| Hébergement | Cloud |
| Base de données | PostgreSQL, base partagée, colonne `company_id` |
| Backend | Node.js, Express, TypeScript, Sequelize, migrations Umzug |
| Frontend | React, TypeScript, Vite, Ant Design (+ Charts), React Router, Redux Toolkit, TanStack Query |
| Qualité | Vitest, React Testing Library, tests API, lint, Prettier, GitHub Actions |
| Livraison | Docker, déploiement progressif |

---

## 1. Utilisateurs de la plateforme

| Profil | Code | Responsabilités |
|---|---|---|
| Administrateur SaaS | `platform_admin` | Gère les commerçants, les plans et la plateforme. **Hors entreprise.** |
| Propriétaire du commerce | `owner` | Configure son entreprise, ses boutiques et ses utilisateurs |
| Gérant | `manager` | Supervise les ventes, le stock et les opérations de **ses** boutiques |
| Caissier | `cashier` | Enregistre les ventes et les paiements autorisés |
| Gestionnaire de stock | `stock_keeper` | Gère les produits, les réceptions et les mouvements |
| Comptable ou superviseur | `accountant` | Consulte les rapports et les opérations financières autorisées |

- Les permissions sont configurables **par rôle** et **par périmètre de boutiques**.
- Un utilisateur peut appartenir à **plusieurs entreprises**, avec un rôle différent dans chacune
  (ex. un comptable externe). Après connexion, il choisit l'entreprise active.
- Un caissier ne peut jamais consulter ni modifier les données d'une autre entreprise.

### 1.1 Matrice de permissions par défaut (V1)

Chaque rôle est un ensemble de permissions. Le propriétaire pourra plus tard créer ses propres
rôles ; en V1, les rôles ci-dessous sont créés automatiquement pour chaque entreprise.

| Permission | owner | manager | cashier | stock_keeper | accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| `company.manage` (paramètres, boutiques) | ✅ | | | | |
| `users.manage` (inviter, rôles, boutiques) | ✅ | | | | |
| `products.view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `products.manage` (créer, modifier, archiver) | ✅ | ✅ | | ✅ | |
| `prices.manage` (changer un prix produit) | ✅ | ✅ | | | |
| `stock.view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `stock.adjust` (ajustement, inventaire) | ✅ | ✅ | | ✅ | |
| `stock.transfer` | ✅ | ✅ | | ✅ | |
| `purchases.manage` (commandes, réceptions, retours) | ✅ | ✅ | | ✅ | |
| `supplier_payments.manage` | ✅ | | | | ✅ |
| `sales.create` (caisse) | ✅ | ✅ | ✅ | | |
| `sales.discount` (au-delà de la remise caissier) | ✅ | ✅ | | | |
| `sales.price_override` (prix modifié en caisse) | ✅ | ✅ | | | |
| `sales.cancel_refund` (annulation, retour, remboursement) | ✅ | ✅ | | | |
| `cash_sessions.manage` (ouvrir/clôturer, voir les écarts) | ✅ | ✅ | ✅ (la sienne) | | ✅ (lecture) |
| `customers.manage` | ✅ | ✅ | ✅ | | ✅ |
| `customer_payments.manage` (remboursements de crédit) | ✅ | ✅ | ✅ | | ✅ |
| `expenses.manage` | ✅ | ✅ | | | ✅ |
| `reports.view` | ✅ | ✅ | | | ✅ |
| `audit.view` | ✅ | | | | ✅ |

Le **périmètre boutiques** s'ajoute aux permissions : un gérant n'agit que sur les boutiques
qui lui sont attribuées. `owner` et `accountant` voient toutes les boutiques par défaut.

---

## 2. Périmètre fonctionnel

### 2.1 Première version commercialisable (V1)

1. Gestion des entreprises, boutiques et utilisateurs.
2. Authentification et contrôle d'accès.
3. Produits, catégories, unités et fournisseurs.
4. Entrées, sorties, transferts et inventaires de stock.
5. Achats, réceptions et retours fournisseurs.
6. Caisse, sessions de caisse, ventes, paiements et tickets.
7. Clients, crédits et remboursements.
8. Dépenses, rapports et tableau de bord (exports PDF et Excel).
9. Historique des opérations et audit.

### 2.2 Hors V1 (après stabilisation)

- Abonnements SaaS, facturation récurrente, paiements en ligne, limites par plan.
- Caisse **hors ligne** (file locale + synchronisation).
- TVA et multi-devises.
- Rôles entièrement personnalisables par le propriétaire.
- Row-Level Security PostgreSQL (défense supplémentaire de l'isolation).

---

## 3. Décisions de cadrage

| # | Décision | Conséquence |
|---|---|---|
| D-01 | **Une seule devise, sans TVA** en V1 — **FCFA (XOF), sans décimales** *(devise à confirmer)* | Prix saisis TTC. Montants stockés en `NUMERIC(14,2)` mais arrondis à l'unité. Passage à la TVA = nouvelle migration (taux par produit, colonnes HT/TVA sur les lignes). |
| D-02 | **Caisse en ligne uniquement** en V1 | Chaque vente part immédiatement au serveur ; une clé d'idempotence empêche les doublons après une coupure réseau. |
| D-03 | **Un utilisateur peut appartenir à plusieurs entreprises** | Table `memberships` ; l'entreprise active est choisie après connexion et inscrite dans l'access token. |
| D-04 | **Les commerçants sont créés par l'administrateur SaaS** | Pas d'inscription publique. Back-office plateforme : création de l'entreprise + invitation du propriétaire par email. |
| D-05 | **Valorisation du stock au coût moyen pondéré (CMP)**, par boutique | Recalculé à chaque réception ; le coût est figé sur chaque mouvement et chaque ligne de vente (marge exacte). |
| D-06 | Dates stockées en **UTC**, rapports dans le **fuseau de l'entreprise** | `companies.timezone` (ex. `Africa/Abidjan`). |

---

## 4. Règles métier

### RB-01 — Isolation des entreprises

Chaque entreprise (`Company`) possède ses propres données.

- Une entreprise ne consulte que ses produits, ventes, utilisateurs et boutiques.
- Chaque requête backend vérifie l'appartenance de la ressource à l'entreprise autorisée.
- Le frontend n'est jamais une barrière de sécurité : toutes les vérifications sont faites côté serveur.
- Les identifiants reçus du client ne suffisent jamais à autoriser l'accès à une ressource.

**Mise en œuvre :**

- `company_id` vient **toujours de l'access token** (entreprise active vérifiée via `memberships`),
  jamais du corps, de l'URL ou des paramètres de la requête.
- Toute lecture/écriture d'une table métier filtre sur `company_id` (fonctions d'accès communes,
  pas de requête « nue »).
- Les clés étrangères entre tables métier incluent l'entreprise : `(company_id, product_id)` →
  `products(company_id, id)`. La base refuse elle-même de lier une vente de A à un produit de B.
- **Chaque module a un test d'isolation** : un utilisateur de B ne peut ni lire, ni modifier,
  ni référencer une ressource de A (réponse 404, pas 403, pour ne pas révéler son existence).

### RB-02 — Gestion des boutiques

- Une entreprise possède une ou plusieurs boutiques ; chacune a son propre stock.
- Un utilisateur est autorisé sur une ou plusieurs boutiques (`membership_shops`).
- Une vente est associée à une boutique précise.
- Un transfert produit une **sortie** dans la boutique source à l'expédition et une **entrée**
  dans la boutique destinataire à la réception.
- Un transfert est suivi jusqu'à sa réception : `draft → shipped → received` (ou `cancelled`
  tant qu'il n'est pas expédié). Un écart à la réception est tracé par un ajustement.

### RB-03 — Produits et prix

Chaque produit appartient à une entreprise et peut être vendu dans plusieurs boutiques. Il possède :

- une référence interne (**SKU**) unique dans l'entreprise, et un **code-barres** facultatif, lui aussi unique dans l'entreprise ;
- un nom, une catégorie et une unité de mesure ;
- un prix de vente et, si nécessaire, un prix d'achat indicatif ;
- un seuil d'alerte de stock ;
- un statut **actif** ou **archivé** (jamais supprimé s'il a un historique).

Le prix réellement appliqué est enregistré dans la ligne de vente. Une modification ultérieure du
prix ne modifie jamais l'historique. Tout changement de prix est audité.

### RB-04 — Fiabilité du stock

Le stock n'est modifié que par des opérations métier explicites :

| Opération | Effet sur le stock |
|---|---|
| Réception d'achat validée | Augmentation |
| Vente finalisée | Diminution |
| Retour client accepté | Augmentation, si l'article est réintégrable |
| Retour fournisseur validé | Diminution |
| Transfert expédié | Sortie de la boutique source |
| Transfert reçu | Entrée dans la boutique destinataire |
| Inventaire validé | Ajustement tracé (écart compté − théorique) |
| Annulation ou remboursement | Opération compensatoire selon le statut et le traitement du retour |

- Chaque mouvement est enregistré dans `stock_movements` (journal en **ajout seul**) ; on ne
  supprime ni ne modifie jamais un mouvement : une erreur se corrige par un mouvement compensatoire.
- Le solde courant est tenu dans `stock_levels` (une ligne par boutique × produit), mis à jour
  **dans la même transaction** que le mouvement. `CHECK (quantity >= 0)` : le stock négatif est
  interdit par la base elle-même.
- Concurrence : les lignes `stock_levels` concernées sont verrouillées (`SELECT … FOR UPDATE`,
  **dans l'ordre des identifiants produits** pour éviter les interblocages) avant toute diminution.

### RB-05 — Cycle de vie d'une vente

1. **Brouillon / panier** — modifiable, côté client.
2. **Validation serveur** — produits actifs et de l'entreprise, prix, remises autorisées
   (permission + plafond), quantités, permissions, boutique, session de caisse ouverte.
3. **Transaction PostgreSQL** — vente + lignes + paiements + mouvements de stock + numéro de ticket.
4. **Vente confirmée** — ticket disponible, opération auditée.

- Si une étape échoue, toute la transaction est annulée.
- Une vente confirmée n'est jamais modifiée silencieusement : annulation, retour ou remboursement
  passent par une procédure métier tracée, liée à la vente d'origine (quantité retournable ≤
  quantité vendue − déjà retournée).
- **Idempotence** : chaque opération sensible (vente, paiement, remboursement, réception) porte
  une clé `Idempotency-Key` générée par le client ; une requête rejouée renvoie le résultat
  initial au lieu de créer un doublon.
- Paiement total ou partiel ; une vente à crédit (ou un reste à payer) crée un solde client.
- Les montants sont **calculés par le backend** à partir des prix et quantités ; ceux envoyés par
  le navigateur ne sont jamais acceptés tels quels.
- Calculs financiers en **décimaux exacts** (`NUMERIC` en base, bibliothèque décimale côté
  Node), jamais en nombres flottants JavaScript.

### RB-06 — Achats et réceptions

- Un bon de commande n'augmente jamais le stock.
- Le stock augmente uniquement à la **réception validée**, de la quantité réellement reçue
  (livraison partielle possible, commande soldée quand tout est reçu ou clôturée manuellement).
- La réception met à jour le **coût moyen pondéré** de la boutique.
- Factures fournisseurs, paiements et dettes sont suivis séparément des commandes et réceptions.

### RB-07 — Permissions et audit

- Chaque opération sensible enregistre son auteur, sa date et son contexte dans `audit_logs`
  (entreprise, boutique, action, entité, valeurs **avant / après**, IP, identifiant de requête).
- Exemples : changement de prix, ajustement de stock, annulation de vente, remboursement,
  création d'utilisateur, modification de permissions, clôture de caisse avec écart.
- Les actions interdites sont rejetées par le backend, même si l'API est appelée directement.
- Une action de l'administrateur SaaS dans l'espace d'un commerçant (support) est auditée comme telle.

### RB-08 — Sessions de caisse

- Un caissier ouvre une session sur une boutique avec un **fond de caisse**.
- Chaque vente et chaque paiement en espèces est rattaché à la session ouverte.
- À la clôture : montant **compté** saisi, montant **attendu** calculé, **écart** enregistré et audité.
- Une seule session ouverte par caissier et par boutique ; pas de vente sans session ouverte.

### RB-09 — Numérotation des documents

- Tickets, retours, bons de commande, réceptions et transferts sont numérotés **sans trou**,
  par entreprise, boutique, type et année : `BTQ1-T-2026-000123`.
- Le numéro est attribué dans la transaction de validation, via un compteur verrouillé
  (`document_sequences`).

### RB-10 — Remises

- Remise par ligne ou sur le total, en montant ou en pourcentage.
- Plafond de remise par rôle (paramètre entreprise) ; au-delà, permission `sales.discount` requise.
- Un prix modifié en caisse exige `sales.price_override` et est audité.

### RB-11 — Archivage plutôt que suppression

- Les données métier ayant un historique (produits, clients, fournisseurs, boutiques, utilisateurs)
  sont **archivées**, jamais supprimées.

---

## 5. Modèle de données PostgreSQL

### 5.1 Conventions

- Clés primaires `id UUID`. Colonnes en `snake_case`. `created_at` / `updated_at` sur toutes les tables.
- Toute table métier porte `company_id UUID NOT NULL` + index, et une contrainte
  `UNIQUE (company_id, id)` pour servir de cible aux clés étrangères composites.
- Montants : `NUMERIC(14,2)`. Quantités : `NUMERIC(14,3)` (vente au kg, au litre…). Coûts unitaires : `NUMERIC(14,4)`.
- Statuts : types `ENUM` PostgreSQL ou `VARCHAR` + `CHECK`.
- Suppression : `ON DELETE RESTRICT` sur les données métier (on archive) ; `CASCADE` réservé
  aux tables purement techniques (sessions, codes, jetons).
- Toutes les tables évoluent **par migration** (jamais `sync()`).

### 5.2 Plateforme, entreprises et accès

| Table | Colonnes principales | Contraintes / index |
|---|---|---|
| `users` *(existe)* | `email`, `name`, `password` (null = invité), `is_platform_admin`, `archived_at` | `UNIQUE(email)` — **le rôle n'est plus sur l'utilisateur**, il passe dans `memberships` |
| `companies` | `name`, `slug`, `currency` (`XOF`), `timezone`, `status` (`active`/`suspended`), `settings` (JSONB : plafond de remise…) | `UNIQUE(slug)` |
| `shops` | `company_id`, `name`, `code` (`BTQ1`), `address`, `phone`, `archived_at` | `UNIQUE(company_id, code)` |
| `roles` | `company_id`, `code`, `name`, `is_system` | `UNIQUE(company_id, code)` |
| `role_permissions` | `role_id`, `permission` | `PK(role_id, permission)` |
| `memberships` | `company_id`, `user_id`, `role_id`, `all_shops`, `status` (`invited`/`active`/`disabled`) | `UNIQUE(company_id, user_id)` |
| `membership_shops` | `membership_id`, `shop_id` | `PK(membership_id, shop_id)` |
| `refresh_tokens`, `email_otp_codes`, `password_tokens` *(existent)* | + `company_id` actif sur la session | — |
| `audit_logs` | `company_id` (null = plateforme), `shop_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before`, `after` (JSONB), `ip`, `request_id`, `created_at` | ajout seul ; index `(company_id, created_at)`, `(entity_type, entity_id)` |
| `idempotency_keys` | `company_id`, `key`, `endpoint`, `request_hash`, `response_status`, `response_body`, `created_at` | `UNIQUE(company_id, key)` ; purge après 48 h |
| `document_sequences` | `company_id`, `shop_id`, `doc_type`, `year`, `last_number` | `PK(company_id, shop_id, doc_type, year)` |

### 5.3 Catalogue

| Table | Colonnes principales | Contraintes / index |
|---|---|---|
| `units` | `company_id`, `name` (pièce, kg, litre…), `symbol`, `allows_decimal` | `UNIQUE(company_id, name)` |
| `categories` | `company_id`, `name`, `parent_id` | `UNIQUE(company_id, name, parent_id)` |
| `products` | `company_id`, `sku`, `barcode`, `name`, `category_id`, `unit_id`, `sale_price`, `purchase_price_hint`, `alert_threshold`, `status` (`active`/`archived`) | `UNIQUE(company_id, sku)`, `UNIQUE(company_id, barcode)`, index de recherche sur `name` (trigram) |
| `suppliers` | `company_id`, `name`, `phone`, `email`, `address`, `archived_at` | `UNIQUE(company_id, name)` |

### 5.4 Stock

| Table | Colonnes principales | Contraintes / index |
|---|---|---|
| `stock_levels` | `company_id`, `shop_id`, `product_id`, `quantity`, `average_cost` | `PK(shop_id, product_id)`, `CHECK(quantity >= 0)` |
| `stock_movements` | `company_id`, `shop_id`, `product_id`, `type` (`purchase_receipt`, `sale`, `customer_return`, `supplier_return`, `transfer_out`, `transfer_in`, `inventory_adjustment`, `cancellation`), `quantity` (signée), `unit_cost`, `balance_after`, `source_type`, `source_id`, `created_by` | ajout seul ; index `(shop_id, product_id, created_at)`, `(source_type, source_id)` |
| `stock_transfers` | `company_id`, `number`, `from_shop_id`, `to_shop_id`, `status`, `shipped_at/by`, `received_at/by` | `CHECK(from_shop_id <> to_shop_id)` |
| `stock_transfer_lines` | `transfer_id`, `product_id`, `quantity_sent`, `quantity_received`, `unit_cost` | — |
| `inventory_counts` | `company_id`, `shop_id`, `number`, `status` (`draft`/`validated`), `validated_by/at` | — |
| `inventory_count_lines` | `inventory_id`, `product_id`, `expected_quantity`, `counted_quantity` | — |

### 5.5 Achats

| Table | Colonnes principales |
|---|---|
| `purchase_orders` | `company_id`, `shop_id`, `supplier_id`, `number`, `status` (`draft`/`sent`/`partially_received`/`received`/`closed`/`cancelled`), `expected_at` |
| `purchase_order_lines` | `order_id`, `product_id`, `quantity_ordered`, `quantity_received`, `unit_cost` |
| `goods_receipts` | `company_id`, `shop_id`, `supplier_id`, `order_id` (facultatif), `number`, `status` (`draft`/`validated`), `validated_by/at` |
| `goods_receipt_lines` | `receipt_id`, `product_id`, `order_line_id`, `quantity`, `unit_cost` |
| `supplier_returns` + `_lines` | même structure ; diminution de stock à la validation |
| `supplier_invoices` | `company_id`, `supplier_id`, `reference`, `date`, `due_date`, `total`, `amount_paid`, `status` |
| `supplier_payments` | `company_id`, `supplier_id`, `invoice_id`, `amount`, `method`, `paid_at` |

### 5.6 Ventes et caisse

| Table | Colonnes principales | Contraintes |
|---|---|---|
| `payment_methods` | `company_id`, `code`, `name` (espèces, Mobile Money, carte, crédit…), `is_cash`, `active` | `UNIQUE(company_id, code)` |
| `cash_sessions` | `company_id`, `shop_id`, `cashier_id`, `opened_at`, `opening_float`, `closed_at`, `expected_cash`, `counted_cash`, `difference` | une seule session ouverte par caissier × boutique (index unique partiel) |
| `sales` | `company_id`, `shop_id`, `cash_session_id`, `customer_id`, `number`, `status` (`confirmed`/`cancelled`), `subtotal`, `discount_total`, `total`, `amount_paid`, `balance_due`, `idempotency_key`, `created_by` | `UNIQUE(company_id, number)` |
| `sale_lines` | `sale_id`, `product_id`, `quantity`, `unit_price` (figé), `discount`, `line_total`, `unit_cost` (figé, CMP) | `CHECK(quantity > 0)` |
| `sale_payments` | `sale_id`, `payment_method_id`, `amount`, `cash_session_id` | `CHECK(amount > 0)` |
| `sale_returns` + `_lines` | lien vers la vente et la ligne d'origine, `restock` (réintégrable ?), `refund_amount`, `reason` |

### 5.7 Clients, crédits et dépenses

| Table | Colonnes principales |
|---|---|
| `customers` | `company_id`, `name`, `phone`, `email`, `credit_limit`, `balance` (dénormalisé, recalculable), `archived_at` |
| `customer_ledger_entries` | `company_id`, `customer_id`, `type` (`sale_credit`/`payment`/`refund`/`adjustment`), `amount` (signé), `source_type`, `source_id` — ajout seul |
| `customer_payments` | `company_id`, `customer_id`, `shop_id`, `amount`, `payment_method_id`, `cash_session_id` |
| `expense_categories` | `company_id`, `name` |
| `expenses` | `company_id`, `shop_id`, `category_id`, `amount`, `description`, `spent_at`, `payment_method_id`, `created_by` |

---

## 6. Transactions et concurrence (exemple : validation d'une vente)

```
BEGIN
  1. Vérifier la clé d'idempotence (déjà traitée → renvoyer le résultat stocké)
  2. Vérifier la session de caisse ouverte, la boutique, les permissions
  3. Charger les produits (company_id + actifs) ; recalculer prix, remises, totaux
  4. SELECT … FROM stock_levels WHERE shop_id = ? AND product_id IN (…)
       ORDER BY product_id FOR UPDATE                -- verrou, ordre fixe
  5. Vérifier les quantités (stock négatif interdit)
  6. Attribuer le numéro de ticket (document_sequences, FOR UPDATE)
  7. INSERT sales, sale_lines (prix et coût figés), sale_payments
  8. UPDATE stock_levels ; INSERT stock_movements (balance_after)
  9. Reste à payer → customer_ledger_entries
 10. INSERT audit_logs ; enregistrer la réponse pour la clé d'idempotence
COMMIT   -- au moindre échec : ROLLBACK complet
```

---

## 7. Écarts avec l'existant (authentification déjà livrée)

| Existant | Évolution prévue |
|---|---|
| `users.role` (`admin`/`manager`/`employee`) | Remplacé par `memberships.role_id` (rôle par entreprise) + `users.is_platform_admin` |
| Pas de notion d'entreprise ni de boutique | Tables `companies`, `shops`, `memberships`, `membership_shops` ; `company_id` dans l'access token |
| `POST /api/users` (admin global) | Devient l'invitation d'un membre **dans l'entreprise active** (`users.manage`) ; la création d'un commerçant passe par le back-office plateforme |
| `pnpm user:create-admin` | Crée l'**administrateur SaaS** (`is_platform_admin`) |
| Pas d'audit | `audit_logs` dès le socle multi-entreprise |
| Rate limiting, OTP email, refresh tokens, mot de passe oublié, invitations, migrations, tests, CI | **Conservés tels quels** |

---

## 8. Plan de livraison (indicatif)

| Étape | Contenu | Statut |
|---|---|---|
| 0 | Fondations, authentification (OTP email, sessions, mots de passe, invitations), tests, CI | ✅ Livré |
| 1 | **Socle multi-entreprise** : entreprises, boutiques, appartenances, rôles/permissions, entreprise active, back-office plateforme, audit, test d'isolation type | ✅ API livrée — écrans à faire |
| 2 | Catalogue : unités, catégories, produits, fournisseurs, pagination et recherche | |
| 3 | Stock : niveaux, mouvements, ajustements, inventaires, transferts, alertes | |
| 4 | Achats : commandes, réceptions (CMP), retours, factures et dettes fournisseurs | |
| 5 | Caisse : sessions, ventes, paiements, tickets, idempotence, annulations et retours | |
| 6 | Clients, crédits, remboursements, dépenses | |
| 7 | Tableau de bord, rapports, exports PDF/Excel | |
| 8 | Qualité et livraison : sécurité, Docker, CI/CD, documentation, démonstration en ligne | |

Chaque étape : migration(s) → modèles → services (règles métier) → routes → tests (dont isolation)
→ écrans.

---

## 9. Questions ouvertes

1. **Devise** : FCFA (XOF) sans décimales — à confirmer.
2. **Mobile Money** : simple moyen de paiement saisi à la main en V1, ou intégration d'un opérateur plus tard ?
3. **Tickets** : impression navigateur (format 80 mm) suffisante en V1, ou imprimante thermique dédiée ?
4. **Plafond de crédit client** : bloquant ou simple avertissement ?
5. **Retours clients** : délai maximal après la vente ? remboursement en espèces, en avoir, ou les deux ?
