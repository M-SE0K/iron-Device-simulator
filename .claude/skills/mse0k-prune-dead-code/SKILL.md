---
name: mse0k-prune-dead-code
description: Find and remove unused files and unused exports in TypeScript/JavaScript projects (pnpm/npm/yarn monorepos), and flag stale/inaccurate comments that no longer match the code. Hybrid detection with knip + Claude triage. Proposes deletions and comment fixes for approval — never auto-deletes. Use when the user asks to clean up dead code, remove unused exports/files, "prune" a TS/JS codebase, or audit comments that are out of sync with the project.
---

# prune-dead-code

> **언어: 이 스킬을 실행하는 동안 사용자에게 보내는 모든 답변(보고서, 표, 질문,
> 진행 설명 등)은 한국어로 작성한다.** 코드·심볼명·파일경로·명령어는 원문 그대로 둔다.

Detect and remove **unused files** and **exported-but-unused functions** in TS/JS
projects, and detect **stale comments** that no longer match the code they describe.
Detection is a hybrid: `knip` produces candidates, Claude triages them to
filter false positives, then **proposes** deletions and comment fixes and waits for
approval.

## Core principle

> The tool finds. Claude judges. The user approves. Verification protects.

Never trust a single signal. `knip` cannot see dynamic references (string-based DI,
glob loading, reflection), so every candidate must pass Claude triage before it is
proposed, and every deletion must pass build/test before it is committed.

**Default policy: PROPOSE-ONLY.** Do not delete anything until the user approves the
report. Never `git push`.

## Step 1 — Detect environment

Before running anything, establish facts (do not assume):

1. Package manager: look for `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`.
   Default to `pnpm` if `pnpm-workspace.yaml` exists.
2. Workspaces / monorepo: read `pnpm-workspace.yaml` or `package.json#workspaces`.
   Note whether `turbo.json` is present.
3. Verification commands available in root + each package `package.json#scripts`:
   - typecheck (e.g. `pnpm typecheck`, or `tsc --noEmit`)
   - build (e.g. `pnpm build`)
   - test (e.g. `pnpm test`)
   - lint (e.g. `pnpm lint`)
   Record the exact commands. If no typecheck script exists, fall back to
   `npx tsc -p <tsconfig> --noEmit`.

State these findings to the user in one short block before proceeding.

## Step 2 — Run knip

Run knip without installing globally:

```bash
npx --yes knip --reporter json
```

- If a `knip.json`/`knip.jsonc` already exists, respect it.
- If not, and the run is noisy with framework false positives, write a config from
  `knip.template.jsonc` (in this skill folder) adapted to the detected entry points,
  and tell the user a config was added.
- For a single package in a monorepo: `npx --yes knip --workspace <pkg> --reporter json`.

knip reports: `files` (unused files), `exports` / `types` (unused exports),
`dependencies` / `devDependencies` (unused deps). Capture all categories.

## Step 2.5 — Detect stale comments (project-mismatch audit)

In parallel with the knip pass, audit comments that **contradict the current code**.
knip cannot see these — this is a Claude-only read pass. Scope the audit to files
touched by the dead-code work plus any files the user names; for a full-project audit,
sweep `// `, `/* */`, `/** */` (JSDoc), and doc headers across `src/`.

Flag a comment as **stale** only when it makes a claim the code no longer supports:

- **Wrong references** — names a function/file/variable/env var/flag/route that was
  renamed or no longer exists (e.g. comment says `audio-stream.worker.ts` but the
  WebSocket now lives on the main thread). Grep the named symbol to confirm it's gone.
- **Contradicted behavior** — describes logic that the code now does differently
  (default values, units, frame sizes, ordering, return shapes, "always/never" claims
  that the code violates).
- **Outdated TODO/FIXME** — references work already done, or a library/API that's
  since changed; flag `추후 …` / `TODO` notes whose premise no longer holds.
- **Drift from docs/spec** — comment cites a behavior that `CLAUDE.md`, `docs/`, or
  `SPECIFICATION.md` now describe differently. When in doubt, the **code is ground
  truth**, not the comment.
- **Dead-code comments** — comments attached to a file/export being deleted in this
  run go with it (no separate proposal needed).

**Do NOT flag**: stylistic/explanatory comments that are merely terse, license
headers, intentional `eslint-disable` / `@ts-expect-error` directives, or comments
whose accuracy you cannot verify against the code. Bias toward keeping — only flag a
comment when you can point to the specific code that contradicts it.

For each flagged comment, decide the action: **fix** (rewrite to match code),
**delete** (claim is obsolete and adds nothing), or **KEEP — uncertain**. Never
silently rewrite; every change is proposed in Step 4.

## Step 3 — Triage (the hybrid step)

Classify every candidate into one of three buckets. **When uncertain, downgrade to
⚠️ or ⛔ — bias toward keeping code.**

- ✅ **safe** — clearly dead: internal module, no references anywhere, not an entry
  point, not part of a public API surface.
- ⚠️ **suspect** — could be dynamically referenced. Before proposing, grep the repo
  for the symbol/filename as a **string** and as a **glob target**:
  ```bash
  rg -n "myFuncName" --type ts --type js
  rg -n "fileBaseName" -g '!node_modules'
  ```
  Also check for: barrel re-exports (`export * from`), `import()` dynamic imports,
  `require(variable)`, decorator metadata, DI container registration.
- ⛔ **exclude** — framework magic or public surface. Do NOT propose these. Common
  cases (verify against the actual project):
  - Package `main`/`exports`/`bin` entry points; anything in a published package's
    public API (`index.ts` re-exports of a library workspace).
  - **NestJS**: `@Injectable` providers, `@Controller`, `@Module`, guards, pipes,
    interceptors — wired by DI, often look unused to knip.
  - **TypeORM**: entities and migrations loaded by glob in the data-source config
    (`migrations: ['dist/**/migrations/*.js']`) appear unused but are essential.
  - Config files: `*.config.{ts,js,mjs}`, `swagger`, codegen inputs.
  - Test fixtures / factories referenced only by test globs.

knip plugins (nestjs, etc.) reduce these, but never rely on the plugin alone — keep
the manual exclude list as a backstop.

## Step 4 — Report

Present a single table, grouped by package, sorted ✅ then ⚠️ (omit ⛔ or list them
separately as "kept, with reason"):

| Item | Kind | Class | Evidence | Action |
|------|------|-------|----------|--------|
| `src/utils/old.ts` | file | ✅ | no imports; not an entry point | delete file |
| `formatLegacy` in `fmt.ts` | export | ✅ | 0 refs; not re-exported | remove export |
| `parseConfig` in `cfg.ts` | export | ⚠️ | only matched as string in `loaders.ts:12` | KEEP — dynamic |

Then, in a **separate** table, list stale comments found in Step 2.5:

| Location | Comment (excerpt) | Why stale | Action |
|----------|-------------------|-----------|--------|
| `ws-engine.ts:42` | "uses audio-stream.worker.ts" | file removed; WS on main thread | fix |
| `native-engine.ts:88` | "추후 라이브러리 제공하면…" | NOP still in place | KEEP — still valid |

For each comment fix, show the proposed before→after wording so the user can approve
the exact text. Then ask for approval. Offer batching (e.g. "apply all ✅ now, review
⚠️ and comment fixes one by one").

## Step 5 — Apply (only after approval), in verified batches

1. Work in batches of ~10–20 related items.
2. For an unused **export**: remove the `export` keyword if the symbol is used
   locally; delete the declaration only if it is truly unreferenced.
3. For an unused **file**: delete it, then remove any now-dangling re-exports in
   barrel files.
4. For a **stale comment**: apply exactly the approved before→after text — fix the
   wording to match the code, or delete the comment if obsolete. Never change the
   surrounding code to fit a comment; the code is ground truth.
5. After each batch run the verification commands recorded in Step 1:
   `typecheck` → `build` → `test` (whichever exist).
6. If verification fails, `git restore`/revert just that batch and reclassify those
   items as ⚠️; report what broke.
7. On green, `git add` + `git commit` the batch with a clear message
   (e.g. `chore: remove unused exports in @arc/core (prune-dead-code)`).

## Hard rules

- Never delete without explicit user approval of the report.
- Never `git push`. Commit only.
- Never delete migration files, entity files, or anything matched only by a glob
  string without confirming with the user.
- If knip flags an unused **dependency**, propose removal separately — verify it is
  not used in config files, Docker, or CI scripts first.
- Prefer many small verified commits over one large deletion.
- Never rewrite or delete a comment without explicit approval of its before→after
  text. Only flag a comment as stale when specific code contradicts it — code is
  ground truth, and a comment fix must never change code to match the comment.
