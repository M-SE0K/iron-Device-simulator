# Custom Claude Code Skills

This project uses four custom Claude Code skills developed during the Iron Device project.
Each skill is a specialized assistant for a specific code-maintenance task.

## Overview

All four skills follow a **PROPOSE-ONLY** policy: they analyze the codebase, report findings
with evidence and confidence levels, and **wait for explicit user approval** before making
changes. No skill automatically edits code or pushes to git.

### 1. **mse0k-swagger-docs**

**Trigger:** `/mse0k-swagger-docs`

Generate and maintain **Swagger/OpenAPI documentation** for Next.js App Router APIs.

- **Source of truth:** JSDoc `@openapi` blocks directly above route handlers
- **Automation:** derives the spec from actual handler code (guards, status codes, request/response shapes)
- **Reuse:** references shared components (auth scheme, error schema, domain types) instead of duplicating
- **Output:** interactive Swagger UI at `/api-docs` + machine-readable spec at `/api/openapi.json`

When to use:
- User asks to create or update API docs
- Need to add Swagger/OpenAPI documentation
- Want to document REST endpoints
- Serve an `/api-docs` page

**Files:**
- `SKILL.md` — full skill definition and workflow
- `reference.md` — detailed extraction rules, block examples, component catalog

### 2. **mse0k-prune-dead-code**

**Trigger:** `/mse0k-prune-dead-code`

Find and remove **unused files** and **unused exports** in TypeScript/JavaScript projects.
Also detects and fixes **stale comments** that contradict current code.

- **Detection:** hybrid approach (knip tool + Claude semantic triage)
- **Safety:** never trusts a single signal; filters knip false positives
- **Output:** two tables — unused code (with confidence levels) and stale comments

When to use:
- User asks to clean up dead code
- Need to remove unused exports or files
- Want to "prune" the TS/JS codebase
- Audit comments that are out of sync

**Files:**
- `SKILL.md` — full skill definition and workflow

### 3. **mse0k-refactor-project**

**Trigger:** `/mse0k-refactor-project`

Find **duplicated functionality** and **structural smells** across the codebase,
then propose safe refactoring for consistency.

- **Scope:** any language (detection is structural, not linter-specific)
- **Built for:** fast-moving sprint/demo/hackathon codebases with copy-paste
- **Safety:** behavior-preserving only; every consolidation is verified
- **Duplication types:** exact copies, parametric variants, copy-paste blocks, redundant modules
- **Smell types:** scattered utilities, misplaced files, inconsistent organization, circular imports, etc.

When to use:
- User wants to clean up duplicate code
- Need to consolidate redundant functions/components
- Want to restructure a project for consistency
- Find where things live wrong (components under `lib/`, etc.)

**Files:**
- `SKILL.md` — full skill definition and workflow
- `reference.md` — structural smell catalog + refactoring recipes

### 4. **mse0k-domain-tw**

**Trigger:** `/mse0k-domain-tw`

Write and maintain a **Korean README.md per domain folder** (technical writing per domain).

- **Ground truth:** actual source code read in the run — speculation is prefixed "Claude의 생각은"
- **Update policy:** partial updates only on meaningful changes (interface / file add·delete / dependency),
  judged via `git log`/`git diff` since the last README-update commit; typo/formatting churn is skipped
- **Preservation:** human-authored notes (특이 케이스 메모, 팀 합의, 배경 설명) survive updates;
  deletion requires user approval
- **Pipeline:** AI 초안 → `/humanize-korean` 윤문 → 저장
- **Wiring:** the maintenance rule lives in the root `CLAUDE.md` ("Domain README 유지 규칙")
- **Sources:** Toss 기술 문서 작성 가이드 (<https://technical-writing.dev/>, CC BY-NC-SA 4.0) ·
  AI 윤문 im-not-ai (<https://github.com/epoko77-ai/im-not-ai.git>)

When to use:
- User asks to write or update domain READMEs
- Need to document a domain folder in Korean
- Sync per-domain docs after meaningful code changes

**Files:**
- `SKILL.md` — full skill definition and workflow (includes the 6-section README skeleton)

---

## Installation

These skills are already installed locally under `~/.claude/skills/`. They are available
immediately when you invoke them via the Skill tool — no additional setup needed.

To use a skill in Claude Code, invoke it directly by name:
```
/mse0k-swagger-docs
/mse0k-prune-dead-code
/mse0k-refactor-project
/mse0k-domain-tw
```

## Policy

**All four skills follow these hard rules:**

1. **PROPOSE-ONLY** — analyze, report, and wait for explicit approval before editing
2. **Never auto-run** — only triggered manually by the user
3. **Never `git push`** — commit only (user may choose not to push)
4. **Verified batches** — every change is verified (typecheck → build → test → lint)
5. **Code is ground truth** — when documentation/comments disagree with code, code wins

## Common workflow

1. **User invokes the skill** → `/mse0k-swagger-docs` (etc.)
2. **Skill establishes facts** (environment, dependencies, build commands)
3. **Skill analyzes** (extracts code, detects patterns, builds report)
4. **User reviews report** — confidence levels, evidence, proposed changes
5. **User approves** (full batch or piecemeal) — or asks for adjustments
6. **Skill applies changes** in verified batches — typecheck/build/test after each
7. **On success** — git add + commit with a clear message (user may push later)

---

## See also

- `../../CLAUDE.md` — project overview and architecture
- Each skill's `SKILL.md` — full definition and step-by-step workflow
- Skill-specific `reference.md` — detailed rules and examples (swagger-docs, refactor-project)
