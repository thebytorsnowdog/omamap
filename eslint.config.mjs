// ESLint flat config. The web core is plain <script> files sharing one
// global scope (load order in core/index.html), so each file is told about
// the top-level names the other core files declare. That keeps no-undef
// useful: a typo or a removed helper is reported instead of failing at run time.
import fs from "node:fs";
import js from "@eslint/js";
import globals from "globals";

const CORE = ["fastpoints.js", "batchcanvas.js", "spatial.js", "parse.js", "basemaps.js", "style.js", "table.js", "app.js"];
const VENDOR = { L: "readonly", toGeoJSON: "readonly", Papa: "readonly", fflate: "readonly", shp: "readonly" };
// Set on the global object rather than declared: parse.js is a UMD-style
// module (also loaded by Node and the worker) and app.js exports OmaMap.
const EXPORTS = { OmaParse: "readonly", OmaMap: "readonly" };

const declared = (file) => {
  const src = fs.readFileSync(new URL("core/" + file, import.meta.url), "utf8");
  return [...src.matchAll(/^(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
};
const perFile = Object.fromEntries(CORE.map((f) => [f, declared(f)]));
const othersOf = (file, access) => Object.fromEntries(
  CORE.filter((f) => f !== file).flatMap((f) => perFile[f]).map((n) => [n, access]));
const allCore = Object.fromEntries(Object.values(perFile).flat().map((n) => [n, "writable"]));

const shared = {
  ...js.configs.recommended.rules,
  "no-unused-vars": ["error", { vars: "local", args: "none", caughtErrors: "none" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-control-regex": "off",          // stripping control characters is deliberate
  "preserve-caught-error": "off",     // errors are rewritten into user-facing messages on purpose
};

export default [
  { ignores: ["core/vendor/**", "node_modules/**", "build/**", "tests/output/**"] },
  ...CORE.map((file) => ({
    files: ["core/" + file],
    languageOptions: {
      ecmaVersion: 2022, sourceType: "script",
      globals: { ...globals.browser, ...VENDOR, ...EXPORTS, ...othersOf(file, "writable"), module: "readonly" },
    },
    rules: shared,
  })),
  {
    files: ["core/parse-worker.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.worker, ...VENDOR, ...EXPORTS } },
    rules: shared,
  },
  {
    // Node tests and tools; page.evaluate() callbacks run in the app page.
    files: ["tests/**/*.cjs", "scripts/**/*.{js,cjs,mjs}", "omarchy-plugin/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: { ...globals.node, ...globals.browser, ...VENDOR, ...EXPORTS, ...allCore } },
    rules: shared,
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
    rules: shared,
  },
];
