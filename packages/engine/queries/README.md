# Vendored tree-sitter tags queries (MIT)

- `typescript/tags.scm`: merge of `tree-sitter/tree-sitter-javascript` tags.scm
  (v0.23.1) and `tree-sitter/tree-sitter-typescript` tags.scm (v0.23.2), also
  used for `.tsx`. The merge is required because tree-sitter-typescript's
  grammar is built on top of tree-sitter-javascript's grammar.js and reuses
  its node types (`function_declaration`, `class_declaration`,
  `method_definition`, `call_expression`, ...); upstream's typescript
  tags.scm omits patterns for those shared node types and expects consumers
  to merge in the base javascript tags query. Our loader (`parser.ts`) reads
  one `tags.scm` file per `queryDir` and does not resolve `inherits:`
  directives, so the merge is pre-baked into the vendored file, with a
  comment marking where the typescript-specific additions begin.
- `javascript/tags.scm` from `tree-sitter/tree-sitter-javascript` (v0.23.1),
  unmodified.
- `python/tags.scm` from `tree-sitter/tree-sitter-python`
  (26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64), unmodified.
- `go/tags.scm` from `tree-sitter/tree-sitter-go`
  (2346a3ab1bb3857b48b29d779a1ef9799a248cd7), unmodified.
- `rust/tags.scm` from `tree-sitter/tree-sitter-rust`
  (77a3747266f4d621d0757825e6b11edcbf991ca5), unmodified.
- `java/tags.scm` from `tree-sitter/tree-sitter-java`
  (e10607b45ff745f5f876bfa3e94fbcc6b44bdc11), unmodified.

## Known upstream query gaps

- **Go**: Top-level `const` and `var` declarations are not captured by the
  upstream query. These are valid module-level symbols but fall outside the
  current tag query scope. Additionally, type self-references (e.g., type
  assertions or embedded `(*Typ).method` receivers) may appear as references,
  creating noise in the call graph.

## Grammar wasm source

Grammar wasm binaries are loaded at runtime from `@vscode/tree-sitter-wasm`
(see `../src/wiki/languages.ts` `wasmDir()`), not from the queries above —
the queries are grammar-version-sensitive only loosely (matched against node
type names, not exact grammar builds) and remain compatible with the
`@vscode/tree-sitter-wasm@0.3.1` typescript/tsx/javascript grammars (built
from tree-sitter-typescript ^0.23.2 / tree-sitter-javascript ^0.25.0 per that
package's `devDependencies`). See the engine package README / task report
for why `tree-sitter-wasms` was dropped in favor of this package.
