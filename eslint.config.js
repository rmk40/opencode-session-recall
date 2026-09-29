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
    // `**/history/v1.js` catches the path from any depth (./, ../, ../../);
    // `./v1.js` covers siblings inside src/history/. (A future host/v1 entry
    // module joins the exemption list.)
    pattern: {
      group: ["**/history/v1.js", "./v1.js"],
      message:
        "Only the v1 entry may import the v1 history adapter; read history through HistorySource.",
    },
    exempt: ["src/opencode-session-recall.ts", "src/history/v1.ts"],
  },
  {
    // The plugin package is v1-host only and absent from a v2-only install.
    // Its types are vendored in src/host/opencode-v1-types.ts (checked by
    // test/host-v1-types.test.ts) and `tool()` is replaced by src/tool-def.ts,
    // so nothing in src/ imports it, not even types (the emitted .d.ts would
    // reference a package the consumer may not have).
    pattern: {
      group: [
        "@opencode-ai/plugin",
        "@opencode-ai/plugin/*",
        "@opencode/plugin",
        "@opencode/plugin/*",
      ],
      message:
        "src/ must not import the opencode plugin package; use src/host/opencode-v1-types.ts and src/tool-def.ts.",
    },
    exempt: [],
  },
  {
    // src/ is runtime-agnostic (no Node types; Bun or Node at runtime). Only
    // the driver adapter and the builtin loaders touch runtime modules, and
    // they do it through dynamic import() behind a variable specifier.
    pattern: {
      group: ["node:*", "bun:*"],
      message:
        "Only src/sqlite.ts and src/node-import.ts may import node:/bun: modules; use the loaders in src/node-import.ts.",
    },
    exempt: ["src/sqlite.ts", "src/node-import.ts"],
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
  {
    // no-restricted-imports sees static imports only; also catch a literal
    // dynamic import("node:fs") outside the two runtime-aware files.
    files: ["src/**/*.ts"],
    ignores: ["src/sqlite.ts", "src/node-import.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(node|bun):/]",
          message:
            "Only src/sqlite.ts and src/node-import.ts may import node:/bun: modules; use the loaders in src/node-import.ts.",
        },
      ],
    },
  },
);
