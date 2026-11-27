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
    // Помощник изоляции окружения подключается вторым: он снимает снимок
    // переменных окружения перед каждым тестовым файлом и возвращает их
    // после него, поэтому файл не наследует состояние соседнего (аудит B14).
    setupFiles: ["./tests/setup.ts", "./tests/env-scope/helpers.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Строка подключения к тестовой базе задаётся конфигом: без неё
    // интеграционные проверки молча пропускались и выглядели как
    // пройденные (аудит B13). Внешнее значение имеет приоритет, поэтому
    // прогон против другой базы не требует правки конфига.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://postgres:postgres@127.0.0.1:5433/support_agent",
    },
    // На машине 4 vCPU: ограничиваем число воркеров, чтобы шесть агентов
    // не запускали тесты одновременно и не выели память.
    // В Vitest 5 опции test.poolOptions и maxForks удалены, ограничение
    // задаётся top-level maxWorkers.
    pool: "forks",
    maxWorkers: 2,
    // Файлы тестов идут последовательно: счётчики лимитов и миграции живут
    // в общей базе, и параллельный прогон давал гонки — падали разные тесты
    // от прогона к прогону. Последовательный прогон детерминирован.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
