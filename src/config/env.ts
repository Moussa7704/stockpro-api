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

  // Clé AES-256 (32 octets en hexadécimal) qui chiffre les secrets TOTP en base
  TWO_FACTOR_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "doit contenir 64 caractères hexadécimaux (32 octets)"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Variables d'environnement invalides :");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
