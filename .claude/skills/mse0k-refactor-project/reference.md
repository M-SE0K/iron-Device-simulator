# reference — structural smell catalog & refactoring recipes

Read this when working Phase 2 (smell detection) and Phase 4 (applying moves). Each
entry: how to detect it (language-agnostic), and the safe refactor recipe.

## Duplication smells

### Scattered utility
**Detect:** same helper name/role defined in multiple files (`formatDate`, `clamp`,
`sleep`, `cn`, `slugify`). Grep the definition inventory for repeated names and for
copy-pasted bodies.
**Recipe:** pick or create one canonical module (`shared/lib/<topic>`). Move the best
implementation there; delete the rest; repoint every importer. If implementations
drifted, diff them and confirm which behavior is canonical before merging.

### Parametric duplicate
**Detect:** two+ functions/components identical except for a constant, endpoint,
label, color, or one branch.
**Recipe:** introduce a parameter/prop whose default reproduces one existing call
site verbatim, migrate the other sites to pass the differing value, then delete the
copies. Keep the public call signature backward-compatible where possible.

### Copy-paste block
**Detect:** repeated sequences INSIDE functions — duplicated fetch+try/catch,
repeated `useEffect`/lifecycle wiring, copy-pasted JSX/HTML, repeated SQL or
validation. Optional accelerator: a clone detector if already installed.
**Recipe:** extract the block into a named function/hook/component; replace each
occurrence with a call. Verify the extracted version handles every original variant.

### Redundant module
**Detect:** two modules with overlapping responsibility — two HTTP clients, two date
libs, two config readers, two state containers, two logging helpers.
**Recipe:** choose the more complete one, port any unique capability from the other
into it, repoint all importers, delete the loser. Higher risk — do it as its own
batch, verify hard.

## Placement / organization smells

### Misplaced file
**Detect:** a file whose location contradicts its role — a React component under
`lib/`, business logic inside a route/controller, a hook defined inside a component
file, types scattered instead of a single `types` module.
**Recipe:** move to the conventional location; update imports, aliases, and barrel
re-exports. Splitting an inlined definition out: extract, export, repoint.

### Inconsistent organization
**Detect:** mixed paradigms — part by-feature, part by-layer; some features have a
folder while siblings are loose files; inconsistent depth.
**Recipe:** pick ONE organizing principle (match whatever the majority/most-recent
code uses) and migrate the outliers toward it incrementally. Don't restructure the
whole tree in one commit — move one feature/folder per batch.

### God file
**Detect:** one file with many unrelated responsibilities, very large, imported
everywhere for unrelated reasons.
**Recipe:** split by responsibility into cohesive modules; keep a thin barrel at the
old path re-exporting the new modules so importers don't break, then migrate
importers, then (optionally) remove the barrel.

### Naming inconsistency
**Detect:** same concept under different names (`userId`/`user_id`/`uid`), or same
role under different file-naming conventions (`*.util.ts`/`*-utils.ts`/`helpers.ts`).
**Recipe:** agree on one convention, rename outliers, update references. Pure renames
— still verify, since string references and dynamic lookups can break.

## Dependency smells

### Circular / tangled imports
**Detect:** A imports B imports A; feature modules importing each other's internals.
Grep import graphs; many tools also report cycles.
**Recipe:** extract the shared piece into a leaf module both depend on (the
"engine-core" pattern), breaking the cycle. Don't paper over it with lazy `import()`.

### Config / constant duplication
**Detect:** the same URL, magic number, key list, or schema literal repeated across
files.
**Recipe:** hoist to a single constants/config module and import it. Watch for values
that LOOK identical but are semantically different — don't over-merge.

## Refactor ordering (safest → riskiest)

1. Extract a shared util into a new module + repoint imports (additive, low risk).
2. Parameterize near-duplicates with backward-compatible defaults.
3. Move misplaced files + fix imports.
4. Rename for consistency.
5. Merge redundant modules (behavior must be reconciled — highest care).
6. Split god files (use a re-export barrel to stay backward-compatible).

Always: one batch, verify, commit. Repeat.
