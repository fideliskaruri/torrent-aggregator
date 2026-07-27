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
    // Throwaway probes. `_`-prefixed scripts are one-off diagnostics kept for
    // reference, never imported by the app, and already excluded from
    // tsconfig.json for the same reason. Linting them only ever produces noise
    // that hides real errors in the rest of the run.
    "scripts/_*.mts",
    "scripts/_*.mjs",
    "scripts/_*.ts",
  ]),
]);

export default eslintConfig;
