import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
  },
  {
    // The SDK is a v1-host runtime dependency: only the v1 history adapter may
    // import its values (clients). Everything else in src/ stays host-neutral
    // and may use its types only.
    files: ["src/**/*.ts"],
    ignores: ["src/history/v1.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@opencode-ai/sdk", "@opencode-ai/sdk/*"],
              allowTypeImports: true,
              message:
                "Only src/history/v1.ts may import @opencode-ai/sdk values; use `import type` elsewhere.",
            },
          ],
        },
      ],
    },
  },
);
