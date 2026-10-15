import { defineConfig } from "vitest/config";
import { testEnv } from "./tests/test-env.js";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: testEnv,
    // Une fois avant tous les tests : base remise à zéro par les migrations
    globalSetup: ["tests/global-setup.ts"],
    // Avant chaque fichier : emails simulés, tables vidées avant chaque test
    setupFiles: ["tests/setup.ts"],
    // Tous les fichiers partagent la même base : on les exécute l'un après l'autre
    fileParallelism: false,
    // bcrypt (coût 12) prend ~250 ms par mot de passe : marge pour les tests qui en créent plusieurs
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
