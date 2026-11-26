import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // На машине 4 vCPU: ограничиваем число воркеров, чтобы шесть агентов
    // не запускали тесты одновременно и не выели память.
    // В Vitest 5 опции test.poolOptions и maxForks удалены, ограничение
    // задаётся top-level maxWorkers.
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
