import { defineConfig } from "vitest/config";

/**
 * The checks that run the compiled worker in a real thread
 * (`test/compiled/*.check.ts`, through `npm run test:compiled`). They need
 * `dist/` and `test-dist/` built first, so `npm test` leaves them out: its
 * default pattern matches only `*.test.ts`.
 */
export default defineConfig({
  test: {
    include: ["test/compiled/**/*.check.ts"],
  },
});
