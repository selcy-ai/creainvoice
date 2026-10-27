import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Change 6: tests assert against the Prisma-shaped facade over Drizzle
      // (tests/helpers/test-db), NOT the raw client, so `db.invoice.
      // findUnique({ where: { id } })` keeps meaning what it always meant.
      // Services those tests import still resolve "@/server/db" to the real
      // Drizzle client — only test files import the facade.
      // Array form: entries are matched in order, so the more specific
      // "@/tests" must be listed before the "@/*" prefix.
      {
        find: "@/tests",
        replacement: path.resolve(process.cwd(), "tests"),
      },
      {
        find: /^@\/(.*)$/,
        replacement: path.resolve(process.cwd(), "src/$1"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/setup.ts"],
    // Integration tests share one test database — run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
