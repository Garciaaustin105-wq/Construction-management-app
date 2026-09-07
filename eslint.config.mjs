import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Double quotes, and a template literal only when it earns its keep.
    //
    // Added after a DeepSource autofix PR sat open for three weeks proposing
    // three of these by hand. There were sixty-five. The rule is here so the
    // next one is caught locally at the moment it is typed, rather than in CI
    // weeks later by a bot whose patch has gone stale.
    //
    // avoidEscape leaves a string containing a double quote alone instead of
    // escaping it — that is why the QuickBooks SQL in
    // src/lib/accounting/quickbooks.ts keeps its inner single quotes.
    rules: {
      quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: false }],
    },
  },
]);

export default eslintConfig;
