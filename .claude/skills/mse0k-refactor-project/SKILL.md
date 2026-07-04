---
name: mse0k-refactor-project
description: Find duplicated/redundant code and structural problems across a project, then refactor for consistency. Language-agnostic, tool-independent. Maps the project, clusters duplicate functionality, flags structure smells, then PROPOSES a refactor plan and applies approved items in verified batches. Use when the user wants to clean up duplicate code, consolidate redundant functions/components, or restructure a project — especially fast sprint/hackathon/demo codebases that have accreted copy-paste.
---

# refactor-project

Detect **duplicated functionality** and **structural smells** in a codebase, then
refactor toward a clean, consistent structure. Built for fast-moving sprint / demo /
hackathon projects where features get copy-pasted under time pressure.

Works in **any language** — detection is heuristic and structural, not tied to a
specific linter or AST tool. If a helper tool happens to be installed it may be used
as an accelerator, but it is never required.

## Core principle

> Map first. Cluster the duplicates. Name the smell. Propose. Then refactor — verified.

A refactor that changes behavior is a bug, not a cleanup. Every consolidation must
preserve behavior and pass whatever verification the project has. **Default policy:
PROPOSE-ONLY** — produce the report and wait for explicit approval before editing.
Never `git push`; commit only when asked.

Refactoring ≠ deleting dead code. If the user only wants unused files/exports
removed, that is `mse0k-prune-dead-code`. This skill is about **consolidating things that
do the same job** and **fixing where things live**.

---

## Phase 0 — Map the project (always do this first)

Establish facts before judging anything. Do not assume stack or layout.

1. **Languages & stack**: list file extensions by count
   (`git ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn`), identify the
   primary language(s), framework, and any monorepo workspaces.
2. **Build/verify commands** — record the EXACT commands that exist (you will run
   them in Phase 4):
   - JS/TS: `package.json#scripts` (typecheck/`tsc --noEmit`, build, test, lint)
   - Python: `pytest`, `ruff`/`flake8`, `mypy`, `pyproject.toml`/`tox.ini`
   - Go: `go build ./...`, `go vet`, `go test ./...`
   - Rust: `cargo build`, `cargo test`, `cargo clippy`
   - Other: Makefile targets, CI workflow steps
   If none exist, say so — the safety net is weaker and batches must be smaller.
3. **Structure inventory**: a tree of source dirs (depth ~2), noting the organizing
   principle (by-feature? by-layer? flat? mixed?). Note the alias/import roots
   (e.g. `@/* → src/*`).
4. **Entry points & public surface**: app entry, exported package API, route files,
   config. These constrain what may move.

Print a short "Project map" block (5–10 lines) summarizing the above, then proceed.

---

## Phase 1 — Detect duplicated functionality

Two kinds of duplication; find both.

### 1a. Build a definition inventory

Extract every function / class / component / hook / route definition with ripgrep,
using language-appropriate patterns. Examples:

```bash
# JS/TS — functions, components, hooks, exported consts
rg -n --no-heading -g '!node_modules' \
  -e 'function ([A-Za-z0-9_]+)' \
  -e 'const ([A-Za-z0-9_]+)\s*=\s*(async\s*)?\(' \
  -e 'export (default )?(async )?function ([A-Za-z0-9_]+)' \
  -e 'class ([A-Za-z0-9_]+)'
# Python
rg -n --no-heading -e '^\s*def ([a-z0-9_]+)' -e '^\s*class ([A-Za-z0-9_]+)'
# Go
rg -n --no-heading -e 'func (\([^)]*\) )?([A-Za-z0-9_]+)\('
```

Cluster the results by:
- **Name similarity** — `formatDate`, `formatDateTime`, `dateFormat`, `toDate` are a
  cluster worth inspecting; same name in N files is a strong signal.
- **Role keywords** — `fetch*/get*/load*` API callers, `format*/parse*` converters,
  `*Modal/*Dialog`, `use*` hooks, validators, mappers, config loaders.

### 1b. Confirm by reading (semantic dedup — the part only Claude can do)

For each cluster, **read the candidates** and decide whether they actually do the
same job. Distinguish:

- **Exact / near-exact copy** — same logic, maybe renamed vars or trivial diffs.
  → consolidate to one.
- **Parametric duplicate** — same shape differing by a constant/branch (two API
  callers differing only by endpoint; two components differing by a label/color).
  → unify into one parameterized version.
- **Coincidental name clash** — same name, genuinely different behavior.
  → KEEP both; note the confusing naming instead.

Copy-paste BLOCK detection (repeated bodies inside larger files, not whole
functions): scan for repeated literal sequences — duplicated `useEffect` blocks,
repeated fetch+error-handling, copy-pasted JSX/markup, repeated SQL. If `jscpd` (or a
similar clone detector) is already available, you MAY run it as an accelerator
(`npx --yes jscpd --silent --reporters json <dir>`); otherwise rely on the inventory
+ targeted reading. Do not install heavy tooling without asking.

For every confirmed duplicate, record the **canonical target** (which copy survives,
or a new shared module) and **every call site** that must be repointed.

---

## Phase 2 — Detect structural smells

Beyond duplication, flag where things live wrong. See `reference.md` in this skill
folder for the full catalog + refactoring recipes. The common ones:

- **Scattered utilities** — the same helper redefined in 3 files instead of one
  `lib/`/`utils` module.
- **Misplaced files** — a component under `lib/`, business logic in a route handler,
  a hook defined inside a component file.
- **Inconsistent organization** — half the code by-feature, half by-layer; some
  features have a folder, others are loose files.
- **God file** — one file doing many unrelated jobs (split by responsibility).
- **Redundant modules** — two API clients, two date libs, two config readers, two
  state stores doing the same thing.
- **Naming inconsistency** — `userId` vs `user_id` vs `uid`; `*.util.ts` vs
  `*-utils.ts` vs `helpers.ts` for the same role.
- **Circular / tangled imports** — A→B→A; feature modules reaching into each other's
  internals instead of a shared module.
- **Config/constant duplication** — the same magic number, URL, or schema repeated.

For each smell, record the concrete files involved and the target structure.

---

## Phase 3 — Report (STOP here; wait for approval)

Present findings as grouped tables, most impactful first. Two sections.

**A. Duplicated functionality**

| Cluster | Copies (file:line) | Class | Canonical target | Call sites to update | Confidence |
|---------|--------------------|-------|------------------|----------------------|------------|
| `formatTime` | `a.ts:12`, `b.tsx:40`, `c.ts:8` | exact | new `shared/lib/time.ts` | 7 | high |
| API fetch+catch block | `x.tsx:50`, `y.tsx:71` | parametric | `useApi(endpoint)` hook | 2 | med |

**B. Structural smells**

| Smell | Files | Proposed change | Risk |
|-------|-------|-----------------|------|
| component under `lib/` | `lib/Card.tsx` | move → `components/Card.tsx`, fix imports | low |
| two API clients | `api.ts`, `client.ts` | merge → `api.ts`, repoint 9 imports | med |

Then:
- Summarize impact (files touched, call sites moved, est. lines removed).
- Propose an **ordered plan** — safest/highest-value first (extract shared util →
  repoint imports → move files → merge modules → split god file). Risky structural
  moves last.
- Ask for approval, and offer batching: "apply all `high`-confidence dedups now,
  review structural moves one at a time?"

Do NOT edit anything before approval.

---

## Phase 4 — Apply (only after approval), in verified batches

Work one **logical batch** at a time (one cluster, or one move). For each:

1. **Consolidate / move**:
   - Dedup: create or pick the canonical definition; delete the duplicates; update
     every recorded call site's import/reference. Preserve the exact behavior of the
     version that was actually correct (read both — they may have drifted; if they
     differ in behavior, surface the diff and ask which is canonical).
   - Move: relocate the file; update all importers; update path aliases/barrels.
   - Parameterize: introduce the param/prop with a default that reproduces existing
     call sites unchanged, then migrate sites.
2. **Verify** with the Phase-0 commands: typecheck → build → test → lint (whichever
   exist). For languages without those, at minimum compile/import the touched
   modules.
3. **On failure**, `git restore`/revert just that batch, reclassify it as risky, and
   report what broke — do not pile more changes on a broken tree.
4. **On green**, `git add` + commit the batch with a clear message
   (e.g. `refactor: consolidate time formatting into shared/lib/time`). Keep batches
   small and behavior-preserving — many small verified commits beat one big one.
5. Continue to the next batch.

After all batches: short summary (what merged/moved, call sites repointed, lines
removed, commits made) and any items deferred as too risky.

---

## Hard rules

- **Behavior-preserving only.** A refactor must not change what the program does. If
  two "duplicates" actually behave differently, do NOT silently pick one — report the
  divergence and ask.
- **Never edit before the user approves the Phase-3 report.**
- **Verify every batch.** Never stack multiple unverified structural changes.
- **Don't move public surface** (package exports, route paths, entry points, public
  API) without explicit confirmation — it breaks external callers.
- **Respect dynamic references** — string-based imports, DI, glob loading, reflection.
  Grep for a symbol/filename as a string before assuming a move is safe.
- **Never `git push`.** Commit only, and only when changes are verified.
- Bias toward keeping code when uncertain: downgrade confidence, don't force a merge.
- This skill consolidates and relocates; it does not hunt for unused code (that's
  `mse0k-prune-dead-code`) or for bugs (that's `/code-review`).
