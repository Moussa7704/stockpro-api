/**
 * Variables d'environnement imposées pendant les tests.
 * DB_HOST, DB_USER, DB_PASSWORD… viennent du .env (en local) ou de la CI :
 * process.loadEnvFile() ne remplace jamais une variable déjà définie ici.
 */
export const testEnv = {
  NODE_ENV: "test",
  // Base dédiée : ses tables sont vidées avant chaque test
  DB_NAME: process.env.TEST_DB_NAME ?? "stockpro_test",
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
  if (!process.env.DB_NAME?.endsWith("_test")) {
    throw new Error(`Refus de lancer les tests sur la base "${process.env.DB_NAME}" (nom en _test attendu)`);
  }
}
