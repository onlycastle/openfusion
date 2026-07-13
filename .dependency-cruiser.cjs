// .dependency-cruiser.cjs
// Architecture boundary rules — spec: docs/superpowers/specs/2026-07-13-clean-architecture-design.md §3.
// Existing violations are grandfathered in .dependency-cruiser-known-violations.json
// (the Phase 3-4 burn-down list); only NEW violations fail.
const path = require("node:path");

const APPLICATION = "^packages/engine/src/(orchestrate|evals|candidates)/";
const MODULES = "^packages/engine/src/(worker|harness|wiki|models|engines|runs|verification|runtime)/";
const TRANSPORT = "^packages/engine/src/rpc/";
const FOUNDATION = "^packages/(engine/src/(util|tools)/|shared/)";

module.exports = {
  forbidden: [
    {
      name: "modules-must-not-import-application",
      comment: "Layer rule: transport -> application -> modules, one way only.",
      severity: "error",
      from: { path: MODULES },
      to: { path: APPLICATION },
    },
    {
      name: "modules-must-not-import-transport",
      comment: "methods.ts RPC adapters inside module folders are the known burn-down (Phase 4 transport/domain split).",
      severity: "error",
      from: { path: MODULES, pathNot: "methods\\.ts$" },
      to: { path: TRANSPORT },
    },
    {
      name: "no-cross-module-deep-imports",
      comment: "A module may import foundation code and its own files — not sibling module internals. $1 back-references the from-side capture group (same-module imports allowed).",
      severity: "error",
      from: { path: "^packages/engine/src/([^/]+)/" },
      to: { path: MODULES, pathNot: ["^packages/engine/src/$1/", FOUNDATION] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true, dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^packages/(engine|shared)/(src|test)/",
    // Absolute path required: TypeScript's parseJsonConfigFileContent double-applies
    // the containing directory when configFileName is relative AND the tsconfig's
    // own "extends" is a relative "../../..." path — it resolves tsconfig.base.json
    // as packages/engine/tsconfig.base.json instead of the repo-root file. See
    // dependency-cruiser src/cli/index.mjs extractTSConfigOptions(), which passes
    // ruleSet.options.tsConfig.fileName to typescript.parseJsonConfigFileContent
    // verbatim as its last (configFileName) argument with no path.resolve.
    tsConfig: { fileName: path.resolve(__dirname, "packages/engine/tsconfig.json") },
    tsPreCompilationDeps: true,
  },
};
