import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request } from "express";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { logger } from "../config/logger.js";

/**
 * Une ligne de journal par requête : méthode, adresse, statut, durée, utilisateur, entreprise et
 * numéro de requête. Le numéro est renvoyé dans l'en-tête X-Request-Id et dans les erreurs :
 * un commerçant qui le cite permet de retrouver la ligne exacte.
 */

// Un proxy (nginx…) peut fournir le sien : gardé s'il est raisonnable, sinon on en crée un
const VALID_REQUEST_ID = /^[\w-]{8,64}$/;

/** Journal des requêtes vers un logger donné (les tests en passent un qui écrit en mémoire). */
export const createRequestLogger = (target: Logger) =>
  pinoHttp({
    logger: target,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    // Sonde de santé interrogée toutes les quelques secondes : pas de bruit dans le journal
    autoLogging: { ignore: (req) => req.url === "/health" },
    // Erreur serveur = error ; erreur du client = warn, sauf 401 (jeton expiré toutes les 15 min) et 404
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400 && res.statusCode !== 401 && res.statusCode !== 404) return "warn";
      return "info";
    },
    // Recalculé en fin de requête : l'utilisateur est alors connu (authenticate est passé)
    customProps: (req) => {
      const user = (req as Request).user;
      return user ? { userId: user.sub, companyId: user.companyId } : {};
    },
    // Ni en-têtes ni corps dans le journal : seulement de quoi retrouver la requête
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    customSuccessMessage: (req, res, responseTime) => `${req.method} ${req.url} → ${res.statusCode} (${responseTime} ms)`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  });

export const requestLogger = createRequestLogger(logger);
