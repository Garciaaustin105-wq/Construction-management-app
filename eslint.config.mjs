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
    // Other agents' worktrees live here — whole checkouts of this repo nested
    // inside it. Linting them reports the same file many times over and is
    // never what anyone wants. (Adding a "**/*.cjs" config block below is what
    // first made ESLint walk into them: in flat config the linted file set is
    // the union of every block's `files`, so a new extension pattern widens the
    // traversal.)
    ".claude/**",
    // Emitted output: the standalone tsc compiles the harnesses run against
    // (.irr-build, .feedback-build, .mat-build, .nav-build, .br-build, ...).
    // Gitignored, regenerated constantly, never hand-edited.
    ".*-build/**",
    // Same, for camera-platform's standalone contract build. The contracts
    // themselves ARE linted — only the emitted dist/ is ignored.
    "camera-platform/dist/**",
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
