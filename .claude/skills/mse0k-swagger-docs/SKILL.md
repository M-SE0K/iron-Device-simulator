---
name: mse0k-swagger-docs
description: Generate and maintain Swagger/OpenAPI documentation for a Next.js App Router project from JSDoc @openapi blocks on each route handler, and serve it as an interactive Swagger UI page at /api-docs. Derives the spec from the ACTUAL route code (auth guards, status codes, request/response shapes) — code is ground truth — reuses existing TS/Prisma types as components instead of re-declaring them, and unifies all error responses under one { error } schema. Manual trigger only. Use when the user asks to create/update API docs, add Swagger/OpenAPI, document REST endpoints, or serve an /api-docs page.
---

# swagger-docs

> **언어: 이 스킬을 실행하는 동안 사용자에게 보내는 모든 답변(보고서, 표, 질문,
> 진행 설명 등)은 한국어로 작성한다.** 코드·심볼명·파일경로·JSDoc·명령어는 원문 그대로 둔다.

Generate **OpenAPI 3.0** documentation for a **Next.js App Router** API and serve it as
an interactive **Swagger UI** at `/api-docs`. The source of truth is a `@openapi` **JSDoc
block above each route handler**, collected by `swagger-jsdoc`. The skill writes and keeps
those blocks in sync with the real handler code, defines shared components once (auth
scheme, `Error` schema, domain schemas reused from existing TS/Prisma types), and wires up
the serving endpoint + page.

## Core principle

> Read the handler. Document what it actually does. Reuse existing types. Never duplicate.

Every `@openapi` block must reflect the **actual code**, not a guess: the security scheme
comes from which auth guard the handler calls, the documented status codes come from the
error/response helpers the handler can actually return, and the request/response schemas
`$ref` shared components derived from the project's own TS interfaces and Prisma models.
When a block and the code disagree, **the code is ground truth** — update the block.

**Trigger: manual only.** Run solely when the user invokes `/mse0k-swagger-docs`. Do not
wire this into a hook or run it automatically on route changes.

**Default policy: PROPOSE-then-apply.** Adding docs is additive and low-risk, but still
present the plan (deps, files, and the per-route block list) before writing, then apply in
verified batches. Never `git push`; commit only when asked.

## Step 1 — Detect environment (establish facts, do not assume)

1. **Framework & router**: confirm Next.js App Router — `src/app/` (or `app/`) with
   `route.ts` handlers. Record the API root (this repo: `src/app/api/`). Note the path
   alias (`@/* → src/*` here) and whether a **custom server** runs the app
   (`server.ts` → source files stay on disk at runtime; relevant in Step 6).
2. **Package manager**: `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`. Use the
   matching `npm|pnpm|yarn` for installs.
3. **React / Next version**: `next`, `react`. React 19 / Next 15 → **do not** use
   `swagger-ui-react` (peer-dep friction); use the CDN Swagger UI HTML route template
   instead (Step 5, `templates/api-docs-route.ts`).
4. **Existing swagger setup**: grep for `swagger`, `openapi`, `@openapi`, an
   `/api-docs` route, `swagger-jsdoc`. If a spec already exists, **update in place** — do
   not scaffold a second one.
5. **Verification commands**: `lint` (`next lint`), `build` (`next build`), typecheck
   (`tsc --noEmit`). Record the exact commands.

State these findings in one short block before proceeding.

## Step 2 — Enumerate every endpoint

List all `route.ts` under the API root and, for **each**, the exported HTTP handlers:

```bash
find src/app/api -name 'route.ts' | sort
# per file, which methods are exported:
grep -nE 'export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)' <file>
```

Build a table `{ file, method, url-path }`. Convert the file path to the OpenAPI URL:
`src/app/api/projects/[id]/route.ts` + `GET` → `GET /api/projects/{id}` (`[x]` → `{x}`).

**Exclude from OpenAPI** (note them to the user, do not try to force them in):
- The `_lib/` helpers dir (underscore-prefixed, not a route).
- **WebSocket** endpoints (e.g. `ws://…/ws/audio` from `server.ts`) — OpenAPI can't
  express them; mention them in the API description text or a separate note only.

## Step 3 — Read each handler and extract its truth (ground truth)

For every handler, read the code and derive the block from what it **actually does**.
See `reference.md` for the full extraction rules; the essentials:

- **Security** — from the guard it calls:
  - `requireApprovedUser()` → `security: [{ cookieAuth: [] }]`, can return **401** (guard
    null) and any authz **403/404**.
  - `requireAdmin()` → `security: [{ cookieAuth: [] }]` + **403** "관리자 권한".
  - `getAuthFromCookie()` used non-fatally (e.g. `/me`) → optional auth; document both the
    authed and the unauthed response shape.
  - no guard (e.g. `login`, `signup`, `logout`) → **public**, no `security`.
- **Responses** — enumerate every status the handler can emit by scanning the helper
  calls it uses (these all return the unified `{ error }` body):
  `unauthorized()`→401, `forbidden()`→403, `notFound()`→404, `badRequest()`/`badBody()`→400,
  `conflict()`→409, `errorJson(_, N, …)`→N, `httpError(e)`→ the `HttpError.status` values
  that the called service can throw. Plus the **success** status from the final
  `NextResponse.json(body, { status })` (default 200; note 201 on create).
- **Request** — from `readJson<T>()` generic (JSON body), `req.formData()` `.get()` fields
  (multipart), or `searchParams.get()` (query params). Mark required vs optional from the
  validation checks that follow.
- **Response body schema** — from the shape passed to `NextResponse.json({ … })`. Prefer a
  `$ref` to a shared component (Step 4) over an inline object.

Do not invent parameters or statuses the code can't produce. If a handler streams bytes
(e.g. audio) document it as `content: { <mimeType>: { schema: { type: string, format: binary } } }`.

## Step 4 — Define shared components ONCE (reuse, don't duplicate)

In the `swagger-jsdoc` definition (`templates/openapi-spec.ts`), define once and `$ref`
everywhere:

- **securitySchemes.cookieAuth**: `{ type: apiKey, in: cookie, name: <TOKEN_COOKIE> }`
  (this repo: `irontune_token` from `features/auth/lib/auth.ts`).
- **schemas.Error**: `{ type: object, required: [error], properties: { error: { type: string } } }`
  — the single unified error schema. Every 4xx/5xx `$ref`s it via shared **responses**
  (`Unauthorized`, `Forbidden`, `NotFound`, `BadRequest`, `Conflict`, `TooManyRequests`).
- **Domain schemas — reuse the project's own types, never re-type them by hand.** Derive
  from the existing single-source definitions and keep names aligned:
  - `features/audio/types.ts` → `AnalysisFrame`, `MeasurementExport`, WS message types.
  - Prisma models (`prisma/schema.prisma`) → `User`, `Project`, `Folder`, `Measurement`,
    plus the trimmed API view objects the routes actually return (e.g. `ProjectDetail`,
    `FolderChildren`, `AudioMeta`). Match the exact fields the handler `select`s/returns.
  When a TS type changes, the component must change with it — call this out as drift.

See `reference.md` §Components for the concrete component catalog for this repo.

## Step 5 — Scaffold the serving layer (from templates/)

Copy and adapt the three templates (adjust import paths to the project's alias):

1. `templates/openapi-spec.ts` → e.g. `src/shared/lib/openapi.ts` — `buildOpenApiSpec()`
   using `swagger-jsdoc` with the definition from Step 4 and
   `apis: ['./src/app/api/**/route.ts']`.
2. `templates/openapi-json-route.ts` → `src/app/api/openapi.json/route.ts` — `GET` returns
   `buildOpenApiSpec()` as JSON. `export const runtime = 'nodejs'` (uses `fs`) and
   `export const dynamic = 'force-dynamic'`.
3. `templates/api-docs-route.ts` → `src/app/api-docs/route.ts` — returns an HTML page that
   mounts Swagger UI (CDN `swagger-ui-dist`) pointed at `/api/openapi.json`. A route
   handler returning `text/html` avoids the React-19 `swagger-ui-react` peer-dep problem.

Install deps (Step 1 package manager):

```bash
npm i -D swagger-jsdoc @types/swagger-jsdoc
```

> `/api-docs` and `/api/openapi.json` are new public routes — if the project has auth
> middleware (this repo's `middleware.ts` protects `/` and `/admin/*`), confirm the docs
> paths are reachable (they are not under the protected prefixes here) or add them to the
> middleware matcher's allowlist. Note this to the user.

## Step 6 — Write / update the @openapi blocks, in batches

Insert one `@openapi` JSDoc block **directly above** each exported handler (see
`reference.md` §Block for the exact shape and a worked example). Rules:

- **Idempotent**: if a block already exists above the handler, **update it in place** to
  match current code — never append a duplicate. Detect the existing `@openapi` comment and
  replace its body.
- Group by domain with `tags` (Auth, Admin, Projects, Folders).
- Reference shared components (`$ref: '#/components/responses/Unauthorized'`, `#/components/schemas/…`).
- Keep summaries short and in Korean; keep the path/param/schema keywords in English.
- Work in batches of one domain (or ~5 handlers) at a time.

## Step 7 — Verify

After each batch and once at the end:

1. **Spec builds & is valid**: generate the spec and validate it —
   ```bash
   npx --yes tsx -e "import('./src/shared/lib/openapi.ts').then(m=>{const s=m.buildOpenApiSpec();console.log('paths',Object.keys(s.paths).length)})"
   npx --yes @apidevtools/swagger-parser validate <(curl -s localhost:3000/api/openapi.json)   # server running
   ```
   or validate the generated object with `@apidevtools/swagger-parser`'s `validate()`.
2. **Every enumerated endpoint appears** in `spec.paths` with the right methods — diff the
   Step 2 table against `Object.keys(spec.paths)`. Report any missing/extra.
3. **Typecheck / lint** the new serving files: `tsc --noEmit` and `next lint`.
4. **Renders**: with the dev server up, load `/api-docs` and confirm Swagger UI lists the
   endpoints (browser tools or a `curl -s localhost:3000/api-docs | grep swagger-ui`).

Report a coverage table: endpoint → documented? → statuses covered vs. statuses the code
can emit. Flag any gaps rather than silently leaving them.

## Hard rules

- **Manual trigger only** — never auto-run or install a hook for this skill.
- The block must match the code. When they differ, fix the **block** (code is ground truth);
  never change a handler just to match its docs.
- **Never duplicate a type** — if a schema already exists as a TS interface or Prisma model,
  `$ref` a component derived from it; do not hand-copy fields that will drift.
- One unified error schema (`{ error }`). Do not document ad-hoc error shapes; if a route
  still returns a non-conforming error, flag it (or fix it via the shared helper) rather
  than documenting the inconsistency.
- Do not document WebSocket or other non-HTTP endpoints as OpenAPI paths.
- Never `git push`. Commit only when asked, with a clear message
  (e.g. `docs: add OpenAPI/Swagger docs for API routes`).
