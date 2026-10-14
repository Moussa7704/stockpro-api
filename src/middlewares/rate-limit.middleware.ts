import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { AppError } from "../utils/app-error.js";

/**
 * Limitation du nombre de requêtes (rate limiting) : freine la force brute
 * sur les mots de passe et les codes 2FA, et les abus en général.
 *
 * Compteurs en mémoire : propres à un processus et remis à zéro au redémarrage.
 * Avec plusieurs instances de l'API, il faudra un store partagé (rate-limit-redis).
 */

const MINUTE = 60 * 1000;

interface LimiterOptions {
  windowMs: number;
  limit: number;
  message: string;
  // true : seules les réponses en erreur (>= 400) comptent, un utilisateur légitime n'est pas pénalisé
  skipSuccessfulRequests?: boolean;
  keyGenerator?: (req: Request) => string;
}

// ipKeyGenerator regroupe les adresses IPv6 par bloc /56 : sinon un attaquant
// pourrait changer d'adresse à l'infini dans son propre bloc pour contourner la limite
function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? "unknown");
}

function createLimiter(options: LimiterOptions) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    keyGenerator: options.keyGenerator ?? ipKey,
    // En-têtes standard RateLimit-* et Retry-After : le client sait quand réessayer
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Erreur 429 au même format JSON que les autres erreurs de l'API
    handler: (_req, _res, next) => next(AppError.tooManyRequests(options.message)),
  });
}

/** Filet de sécurité sur toute l'API, par IP. */
export const apiLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 300,
  message: "Trop de requêtes, réessayez dans quelques minutes",
});

/** Création de comptes, par IP. */
export const registerLimiter = createLimiter({
  windowMs: 60 * MINUTE,
  limit: 5,
  message: "Trop de comptes créés, réessayez plus tard",
});

/** Échecs de login par IP : bloque un attaquant qui essaie beaucoup de comptes. */
export const loginIpLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  skipSuccessfulRequests: true,
  message: "Trop de tentatives de connexion, réessayez dans 15 minutes",
});

/**
 * Échecs de login par email : bloque une attaque sur UN compte, même répartie sur plusieurs IP.
 * Contrepartie : quelqu'un peut bloquer volontairement un compte 15 minutes.
 */
export const loginEmailLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  message: "Trop de tentatives de connexion, réessayez dans 15 minutes",
  keyGenerator: (req) => {
    const email: unknown = req.body?.email;
    // Le body n'est pas encore validé ici : on normalise comme le fait le schéma zod
    return typeof email === "string" ? `email:${email.trim().toLowerCase()}` : ipKey(req);
  },
});

/** Échecs de code 2FA au login, par IP (en plus des 5 essais max par challenge). */
export const twoFactorLoginLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  message: "Trop de codes invalides, réessayez dans 15 minutes",
});

/** Renouvellement de session, par IP. */
export const refreshLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  message: "Trop de renouvellements de session, réessayez plus tard",
});

/**
 * Actions 2FA d'un utilisateur connecté (activer, désactiver, régénérer) : par utilisateur.
 * À placer APRÈS authenticate, qui remplit req.user.
 */
export const twoFactorManageLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  message: "Trop de tentatives, réessayez dans 15 minutes",
  keyGenerator: (req) => (req.user ? `user:${req.user.sub}` : ipKey(req)),
});
