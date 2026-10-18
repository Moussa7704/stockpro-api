import { z } from "zod";

// Charge le fichier .env s'il existe (en production, les variables viennent de l'environnement)
try {
  process.loadEnvFile();
} catch {
  // pas de fichier .env : on utilise uniquement process.env
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  // Nombre de reverse proxies devant l'API (nginx, load balancer…). 0 = accès direct.
  // Sert à lire la vraie IP du client dans X-Forwarded-For (indispensable au rate limiting)
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Désactivé uniquement par les tests automatisés (des centaines de requêtes en quelques secondes)
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  // Documentation interactive /api/docs : par défaut active partout sauf en production
  API_DOCS_ENABLED: z.stringbool().optional(),
  // Niveau du journal : debug (requêtes SQL comprises), info, warn, error ; silent en test
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  // Sauvegardes (pnpm db:backup, service Docker « backup ») : dossier, heure locale (variable TZ)
  BACKUP_DIR: z.string().min(1).default("backups"),
  BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  // Dossier des outils PostgreSQL (pg_dump, pg_restore…) s'ils ne sont pas dans le PATH (Windows)
  PG_BIN_DIR: z.string().min(1).optional(),
  // Compte autorisé à créer une base, pour vérifier une sauvegarde (sinon celui de l'application)
  BACKUP_VERIFY_DB_USER: z.string().min(1).optional(),
  BACKUP_VERIFY_DB_PASSWORD: z.string().min(1).optional(),
  // Adresse du front : sert à construire les liens envoyés par email (invitation, mot de passe oublié)
  CLIENT_URL: z.url().default("http://localhost:5173"),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),

  // Au moins 32 caractères : un secret court peut être retrouvé par force brute
  JWT_ACCESS_SECRET: z.string().min(32),
  // Durée de vie de l'access token, en secondes (900 = 15 min)
  JWT_ACCESS_EXPIRES_IN: z.coerce.number().int().positive().default(900),
  // Durée de vie d'une session (refresh token), en jours
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Clé secrète (32 octets en hexadécimal) pour l'empreinte HMAC des codes OTP stockés en base
  OTP_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "doit contenir 64 caractères hexadécimaux (32 octets)"),

  // Envoi des emails (codes OTP) : compte Gmail + "mot de passe d'application" Google
  // (pas le mot de passe du compte). Mêmes noms que dans les autres projets.
  EMAIL_USER: z.string().min(1),
  EMAIL_PASS: z.string().min(1),
  // Serveur SMTP : Gmail par défaut, à changer seulement pour un autre fournisseur
  SMTP_HOST: z.string().min(1).default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  // true = TLS dès la connexion (port 465) ; false = STARTTLS (port 587)
  SMTP_SECURE: z.stringbool().default(true),
  // Expéditeur affiché ; par défaut "StockPro <EMAIL_USER>"
  MAIL_FROM: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Pas encore de journal (il dépend de cette configuration) : sortie directe
  console.error("Variables d'environnement invalides :");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = {
  ...parsed.data,
  API_DOCS_ENABLED: parsed.data.API_DOCS_ENABLED ?? parsed.data.NODE_ENV !== "production",
  LOG_LEVEL: parsed.data.LOG_LEVEL ?? (parsed.data.NODE_ENV === "test" ? "silent" : "info"),
};
