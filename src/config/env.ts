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

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Variables d'environnement invalides :");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
