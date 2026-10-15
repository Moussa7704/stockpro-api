import { Op, QueryTypes, type Transaction } from "sequelize";
import { sequelize } from "../../config/database.js";
import { Product, StockMovement, Unit } from "../../models/index.js";
import type { MovementType } from "../../models/stock.models.js";
import { AppError } from "../../utils/app-error.js";
import { isWhole } from "../../utils/decimal.js";

/**
 * MOTEUR DE STOCK — seul endroit du code qui modifie une quantité (RB-04).
 * Ajustements, inventaires, transferts, puis réceptions d'achat et ventes passent tous par
 * applyMovements(), toujours à l'intérieur de la transaction de l'opération métier.
 *
 * Garanties :
 * - stock jamais négatif, même avec des requêtes simultanées : la diminution est un UPDATE
 *   conditionnel (quantity + delta >= 0) exécuté sur la ligne verrouillée ;
 * - verrous pris dans un ordre fixe (boutique, produit) : pas d'interblocage entre deux ventes ;
 * - calculs (quantité, coût moyen pondéré) faits par PostgreSQL en NUMERIC exact ;
 * - chaque mouvement est journalisé avec son coût figé et le solde obtenu.
 */

export interface MovementRequest {
  shopId: string;
  productId: string;
  // Décimal signé en chaîne : "5" entrée, "-2.5" sortie (jamais 0)
  quantity: string;
  type: MovementType;
  // Entrée valorisée (réception, stock d'ouverture, transfert reçu) : met à jour le CMP.
  // Absent : le mouvement est valorisé au coût moyen actuel, qui ne change pas.
  unitCost?: string;
}

export interface MovementContext {
  companyId: string;
  sourceType: string; // ex. "stock_adjustment", "stock_transfer", "sale"
  sourceId: string;
  createdBy: string | null;
  transaction: Transaction;
}

export function negate(quantity: string): string {
  return quantity.startsWith("-") ? quantity.slice(1) : `-${quantity}`;
}

export function isNegative(quantity: string): boolean {
  return quantity.startsWith("-");
}

/**
 * Produits utilisables dans une opération de stock : de l'entreprise, actifs, et avec des
 * quantités compatibles avec leur unité (pas de demi-pièce).
 */
export async function loadStockProducts(
  companyId: string,
  lines: { productId: string; quantities: string[] }[],
  transaction: Transaction,
  // true : accepte un produit archivé (ex. marchandise déjà en route quand il a été archivé)
  { allowArchived = false } = {},
): Promise<Map<string, Product>> {
  const ids = [...new Set(lines.map((line) => line.productId))];
  const products = await Product.findAll({
    where: { companyId, id: { [Op.in]: ids }, ...(!allowArchived && { status: "active" }) },
    include: [{ model: Unit, as: "unit", attributes: ["name", "allowsDecimal"] }],
    transaction,
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product) {
      // Produit d'une autre entreprise, inexistant ou archivé : même réponse (RB-01)
      throw AppError.badRequest("Produit inconnu ou archivé");
    }
    if (!product.unit!.allowsDecimal && line.quantities.some((quantity) => !isWhole(quantity))) {
      throw AppError.badRequest(`« ${product.name} » se compte en ${product.unit!.name.toLowerCase()}s entières`);
    }
  }
  return byId;
}

/** Crée les lignes de solde manquantes (à 0) pour pouvoir les verrouiller. */
async function ensureLevels(companyId: string, requests: MovementRequest[], transaction: Transaction) {
  for (const request of requests) {
    await sequelize.query(
      `INSERT INTO stock_levels (shop_id, product_id, company_id, quantity, average_cost, created_at, updated_at)
       VALUES (:shopId, :productId, :companyId, 0, 0, now(), now())
       ON CONFLICT (shop_id, product_id) DO NOTHING`,
      { replacements: { shopId: request.shopId, productId: request.productId, companyId }, transaction },
    );
  }
}

/** Verrouille les soldes dans un ordre fixe et renvoie les quantités actuelles (clé "shop:produit"). */
export async function lockLevels(
  companyId: string,
  keys: { shopId: string; productId: string }[],
  transaction: Transaction,
): Promise<Map<string, { quantity: string; averageCost: string }>> {
  await ensureLevels(
    companyId,
    keys.map((key) => ({ ...key, quantity: "0", type: "adjustment" })),
    transaction,
  );
  const rows = await sequelize.query<{ shop_id: string; product_id: string; quantity: string; average_cost: string }>(
    `SELECT shop_id, product_id, quantity, average_cost FROM stock_levels
     WHERE company_id = :companyId AND (shop_id, product_id) IN (:pairs)
     ORDER BY shop_id, product_id
     FOR UPDATE`,
    {
      replacements: { companyId, pairs: keys.map((key) => [key.shopId, key.productId]) },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return new Map(
    rows.map((row) => [`${row.shop_id}:${row.product_id}`, { quantity: row.quantity, averageCost: row.average_cost }]),
  );
}

export async function applyMovements(
  context: MovementContext,
  requests: MovementRequest[],
): Promise<StockMovement[]> {
  const { companyId, transaction } = context;
  // Ordre fixe des verrous : deux transactions sur les mêmes produits ne s'attendent jamais en croix
  const ordered = [...requests].sort(
    (a, b) => a.shopId.localeCompare(b.shopId) || a.productId.localeCompare(b.productId),
  );
  await ensureLevels(companyId, ordered, transaction);

  const movements: StockMovement[] = [];
  for (const request of ordered) {
    const cost = request.unitCost ?? null;
    // Une seule requête : verrou de la ligne, contrôle du stock et mise à jour du CMP.
    // Dans SET, "quantity" et "average_cost" désignent encore les anciennes valeurs.
    const [rows] = (await sequelize.query(
      `UPDATE stock_levels SET
         average_cost = CASE
           WHEN CAST(:cost AS numeric) IS NOT NULL AND CAST(:delta AS numeric) > 0
             THEN ROUND((quantity * average_cost + CAST(:delta AS numeric) * CAST(:cost AS numeric))
                        / (quantity + CAST(:delta AS numeric)), 4)
           ELSE average_cost
         END,
         quantity = quantity + CAST(:delta AS numeric),
         updated_at = now()
       WHERE company_id = :companyId AND shop_id = :shopId AND product_id = :productId
         AND quantity + CAST(:delta AS numeric) >= 0
       RETURNING quantity, average_cost`,
      {
        replacements: {
          companyId,
          shopId: request.shopId,
          productId: request.productId,
          delta: request.quantity,
          cost,
        },
        transaction,
      },
    )) as [{ quantity: string; average_cost: string }[], unknown];

    const level = rows[0];
    if (!level) {
      const product = await Product.findByPk(request.productId, { attributes: ["name"], transaction });
      throw AppError.conflict(`Stock insuffisant pour « ${product?.name ?? "produit"} »`);
    }

    movements.push(
      await StockMovement.create(
        {
          companyId,
          shopId: request.shopId,
          productId: request.productId,
          type: request.type,
          quantity: request.quantity,
          // Coût figé : celui de l'entrée valorisée, sinon le coût moyen du moment
          unitCost: cost ?? level.average_cost,
          balanceAfter: level.quantity,
          sourceType: context.sourceType,
          sourceId: context.sourceId,
          createdBy: context.createdBy,
        },
        { transaction },
      ),
    );
  }
  return movements;
}
