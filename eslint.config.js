import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Import boundaries for src/. Each entry is a no-restricted-imports pattern
 * plus the files exempt from it. A later flat-config block REPLACES an
 * earlier block's options for the same rule, so the rule cannot be split
 * across blocks per boundary; instead `restrictedImports` emits one block per
 * distinct exemption set, each carrying every pattern that applies to it.
 */
const boundaries = [
  {
    // The SDK is a v1-host runtime dependency: only the v1 history adapter may
    // import its values (clients). Everything else in src/ stays host-neutral
    // and may use its types only.
    pattern: {
      group: ["@opencode-ai/sdk", "@opencode-ai/sdk/*"],
      allowTypeImports: true,
      message:
        "Only src/history/v1.ts may import @opencode-ai/sdk values; use `import type` elsewhere.",
    },
    exempt: ["src/history/v1.ts"],
  },
  {
    // The v1 history adapter is wired in by the v1 entry only; the core reads
    // history through the HistorySource seam and never depends on an adapter.
    // (A future host/v1 entry module joins the exemption list.)
    pattern: {
      group: ["./history/v1.js", "../history/v1.js", "./v1.js"],
      message:
        "Only the v1 entry may import the v1 history adapter; read history through HistorySource.",
    },
    exempt: ["src/opencode-session-recall.ts", "src/history/v1.ts"],
  },
];

function restrictedImports(files) {
  const exemptSets = new Map([["", []]]);
  for (const { exempt } of boundaries) {
    for (const file of exempt) exemptSets.set(file, [file]);
  }
  return [...exemptSets.values()].map((exemptFiles) => {
    const patterns = boundaries
      .filter(({ exempt }) => !exemptFiles.some((file) => exempt.includes(file)))
      .map(({ pattern }) => pattern);
    return {
      files: exemptFiles.length > 0 ? exemptFiles : files,
      ignores: exemptFiles.length > 0 ? [] : [...exemptSets.keys()].filter(Boolean),
      rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns }] },
    };
  });
}

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
  },
  ...restrictedImports(["src/**/*.ts"]),
);
