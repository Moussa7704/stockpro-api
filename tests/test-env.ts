/**
 * Variables d'environnement imposées pendant les tests.
 * DB_HOST, DB_PORT… viennent du .env (en local) ou de la CI.
 */

// Charge le .env ici aussi : ce fichier est lu par vitest.config.ts, avant src/config/env.ts
try {
  process.loadEnvFile();
} catch {
  // pas de .env (CI) : les variables viennent de l'environnement
}

const testDbUser = process.env.TEST_DB_USER;
const testDbPassword = process.env.TEST_DB_PASSWORD;

export const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  // Base dédiée : ses tables sont vidées avant chaque test
  DB_NAME: process.env.TEST_DB_NAME ?? "stockpro_test",
  // Compte PostgreSQL des tests (ex. postgres) : il peut créer la base de test si elle manque
  ...(testDbUser && { DB_USER: testDbUser }),
  ...(testDbPassword && { DB_PASSWORD: testDbPassword }),
  RATE_LIMIT_ENABLED: "false",
  JWT_ACCESS_SECRET: "secret-de-test-uniquement-pas-pour-la-production-0123456789",
  OTP_SECRET_KEY: "0".repeat(64),
  // Les emails ne partent jamais : le module mailer est remplacé (voir tests/setup.ts)
  EMAIL_USER: "test@stockpro.test",
  EMAIL_PASS: "test",
  CLIENT_URL: "http://localhost:5173",
};

/** Garde-fou : les tests vident les tables, ils ne doivent jamais toucher une autre base. */
export function assertTestDatabase(): void {
  const name = process.env.DB_NAME ?? "";
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refus de lancer les tests sur la base "${name}" (nom en _test attendu)`);
  }
}
