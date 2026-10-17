import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import { verifyAccessToken } from "../utils/jwt.js";

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
  limit: number | ((req: Request) => number);
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
    // Tests automatisés uniquement : jamais à false en dev ni en production
    skip: () => !env.RATE_LIMIT_ENABLED,
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

// Clé calculée une fois par requête (elle sert à la clé et au plafond)
const clientKeys = new WeakMap<Request, string>();

/**
 * Qui consomme le quota général : l'utilisateur d'un jeton d'accès valide, sinon l'adresse IP.
 * Par IP seulement, tous les employés d'une boutique (même box Internet) se partageraient un
 * seul quota et seraient bloqués, puis déconnectés, en pleine journée.
 */
export function apiClientKey(req: Request): string {
  let key = clientKeys.get(req);
  if (key) return key;
  key = ipKey(req);
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      key = `user:${verifyAccessToken(header.slice("Bearer ".length)).sub}`;
    } catch {
      // Jeton expiré ou falsifié : compté avec l'adresse IP
    }
  }
  clientKeys.set(req, key);
  return key;
}

/** Plafonds du quota général sur 15 minutes. */
export const API_LIMITS = { user: 1000, ip: 300 } as const;

/** Filet de sécurité sur toute l'API : par utilisateur connecté, sinon par IP. */
export const apiLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: (req) => (apiClientKey(req).startsWith("user:") ? API_LIMITS.user : API_LIMITS.ip),
  message: "Trop de requêtes, réessayez dans quelques minutes",
  keyGenerator: apiClientKey,
}); 

/** Demandes "mot de passe oublié", par IP (chaque demande peut envoyer un email). */
export const forgotPasswordLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  message: "Trop de demandes, réessayez dans 15 minutes",
});

/** Vérification / utilisation d'un lien de mot de passe, par IP. */
export const passwordTokenLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  message: "Trop de tentatives, réessayez dans 15 minutes",
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

/** Échecs de code OTP au login, par IP (en plus des 5 essais max par code, stockés en base). */
export const otpVerifyLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  message: "Trop de codes invalides, réessayez dans 15 minutes",
});

/** Demandes de renvoi du code par email, par IP (limite aussi le spam d'emails). */
export const otpResendLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  message: "Trop de demandes de renvoi, réessayez plus tard",
});

/**
 * Échecs de renouvellement de session, par IP. Les réussites ne comptent pas : un refresh token
 * (256 bits aléatoires) ne se devine pas, et plusieurs appareils d'une boutique partagent l'IP.
 */
export const refreshLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  skipSuccessfulRequests: true,
  message: "Trop de renouvellements de session, réessayez plus tard",
});

/**
 * Échecs de changement de mot de passe, par utilisateur : empêche de deviner le mot de passe
 * actuel avec une session volée. À placer APRÈS authenticate, qui remplit req.user.
 */
export const changePasswordLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  message: "Trop de tentatives, réessayez dans 15 minutes",
  keyGenerator: (req) => (req.user ? `user:${req.user.sub}` : ipKey(req)),
});
