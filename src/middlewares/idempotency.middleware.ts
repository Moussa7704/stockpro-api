import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { UniqueConstraintError } from "sequelize";
import { withMeta } from "../docs/route-meta.js";
import { IdempotencyKey } from "../models/index.js";
import { AppError } from "../utils/app-error.js";

/**
 * Idempotence des opérations sensibles (RB-05) : réception validée, paiement, et plus tard vente.
 * Le client génère une clé unique par opération (en-tête Idempotency-Key, ex. un UUID) et la
 * renvoie telle quelle s'il doit rejouer la requête après une coupure réseau :
 * - première requête : traitée normalement, la réponse (2xx) est mémorisée ;
 * - même clé, même contenu : la réponse mémorisée est renvoyée, rien n'est refait ;
 * - même clé, contenu différent : 422 (clé réutilisée par erreur) ;
 * - même clé pendant que la première est encore en cours : 409.
 * À placer APRÈS requirePermission (la clé est rangée par entreprise), et après uploadFile
 * pour un envoi de fichier (le contenu du fichier entre dans l'empreinte de la requête).
 */

const KEY_PATTERN = /^[A-Za-z0-9_:.-]{8,100}$/;

function hashRequest(method: string, path: string, body: unknown, file?: Express.Multer.File): string {
  const hash = createHash("sha256").update(`${method} ${path} ${JSON.stringify(body ?? null)}`);
  // Envoi de fichier : même clé avec un autre fichier = autre requête (422), pas une répétition
  if (file) {
    hash.update(file.buffer);
  }
  return hash.digest("hex");
}

export function idempotent({ required = false } = {}): RequestHandler {
  const handler: RequestHandler = async (req, res, next) => {
    const key = req.header("Idempotency-Key");
    if (!key) {
      if (required) {
        throw AppError.badRequest("En-tête Idempotency-Key obligatoire pour cette opération");
      }
      return next();
    }
    if (!KEY_PATTERN.test(key)) {
      throw AppError.badRequest("Idempotency-Key invalide (8 à 100 caractères : lettres, chiffres, - _ : .)");
    }

    const companyId = req.company!.companyId;
    const userId = req.user!.sub;
    const requestHash = hashRequest(req.method, req.originalUrl, req.body, req.file);

    try {
      await IdempotencyKey.create({ companyId, key, userId, requestHash, status: "processing" });
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) {
        throw error;
      }
      const existing = await IdempotencyKey.findOne({ where: { companyId, key } });
      if (!existing || existing.requestHash !== requestHash || existing.userId !== userId) {
        throw new AppError(422, "Cette clé d'idempotence a déjà servi pour une autre requête");
      }
      if (existing.status === "processing") {
        throw AppError.conflict("Une requête identique est en cours de traitement");
      }
      res.setHeader("Idempotent-Replayed", "true");
      res.status(existing.responseStatus ?? 200).json(existing.responseBody);
      return;
    }

    // On mémorise la réponse AVANT de l'envoyer : un client qui rejoue aussitôt sa requête
    // retrouve bien la réponse enregistrée (et non "requête en cours")
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const persist =
        res.statusCode < 400
          ? IdempotencyKey.update(
              { status: "completed", responseStatus: res.statusCode, responseBody: body as object },
              { where: { companyId, key } },
            )
          : // Échec : la clé est libérée, le client peut corriger et réessayer avec la même clé
            IdempotencyKey.destroy({ where: { companyId, key } });

      persist
        .catch((error: unknown) => req.log.error({ err: error }, "Échec de l'enregistrement de la clé d'idempotence"))
        .finally(() => sendJson(body));
      return res;
    };

    next();
  };
  return withMeta(handler, { kind: "idempotent", required });
}
