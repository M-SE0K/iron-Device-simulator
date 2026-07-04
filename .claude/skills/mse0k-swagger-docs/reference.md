# swagger-docs — reference

Detailed conventions for `mse0k-swagger-docs`. Read this when generating blocks and
components. Examples are drawn from the iron-device-simulator repo (Next.js App Router,
cookie-JWT auth, unified `{ error }` responses via `src/app/api/_lib/route.ts`).

---

## Block — the `@openapi` JSDoc above a handler

Place one block **immediately above** each exported handler in a `route.ts`. `swagger-jsdoc`
parses the YAML after the `@openapi` (or `@swagger`) tag. The top-level key is the URL path
(with `{param}` templating), then the lowercase HTTP method.

```ts
/**
 * @openapi
 * /api/projects/{id}:
 *   get:
 *     summary: 프로젝트 단건 조회 (메타 + 측정 요약 + 음원 메타)
 *     tags: [Projects]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/ProjectDetail' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '404': { $ref: '#/components/responses/NotFound' }
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) { … }
```

Notes:
- Quote status codes (`'200'`) — YAML would otherwise treat them oddly in some parsers.
- One `route.ts` with multiple methods gets **multiple blocks** (one per handler), each
  repeating the path key under a different method — or a single block listing several
  methods under the one path. Prefer one block per handler; it keeps the block next to the
  code it documents and makes idempotent updates easier.
- Idempotency: to update, find the existing `/** … @openapi … */` comment directly above
  the handler and replace its contents. Never leave two blocks for one handler.

---

## Extraction rules — deriving the block from real code

| Signal in handler | What it means for the block |
|---|---|
| `await requireApprovedUser(); if (!auth) return unauthorized();` | `security: [{ cookieAuth: [] }]`; add `'401': {$ref: Unauthorized}` |
| `await requireAdmin(); if (!admin) return forbidden("관리자…")` | `security: [{ cookieAuth: [] }]`; add `'403': {$ref: Forbidden}` |
| `getAuthFromCookie()` non-fatal (`/me`) | auth optional; document authed body **and** the unauthed body (e.g. `{ user: null }` at 401) as distinct responses |
| no guard (`login`/`signup`/`logout`/`refresh`) | public — omit `security` |
| `readJson<{ email?: string }>(req)` | `requestBody` `application/json` object; required fields = those the code rejects when missing |
| `req.formData()` + `form.get('file')` | `requestBody` `multipart/form-data`; `file` → `{ type: string, format: binary }` |
| `searchParams.get('space')` | query `parameters` (`in: query`); enum if the code checks a fixed set |
| `[id]` in path | path `parameters` (`in: path`, required) |
| `unauthorized()` | `'401': {$ref: Unauthorized}` |
| `forbidden(msg)` | `'403': {$ref: Forbidden}` |
| `notFound(msg)` | `'404': {$ref: NotFound}` |
| `badRequest(msg)` / `badBody()` | `'400': {$ref: BadRequest}` |
| `conflict(msg)` | `'409': {$ref: Conflict}` |
| `errorJson(msg, 429, …)` | `'429': {$ref: TooManyRequests}` (+ note `Retry-After` header) |
| `httpError(e)` | add each `HttpError.status` the called service can throw (read the service; commonly 400/403/404) |
| `NextResponse.json(body)` | success `'200'` with `body` shape → `$ref` a schema |
| `NextResponse.json(body, { status: 201 })` | success `'201'` |
| `new NextResponse(bytes, { headers: { 'Content-Type': mime } })` | binary response: `content: { '<mime>': { schema: { type: string, format: binary } } }` |

**Do not** document a status the code cannot return, or a param the handler never reads.

---

## Components — define once in `buildOpenApiSpec()`, `$ref` everywhere

Put these in the `swagger-jsdoc` `definition.components` (see `templates/openapi-spec.ts`).
Derive domain schemas from the project's own sources — do not hand-maintain parallel copies.

### securitySchemes

```yaml
cookieAuth:
  type: apiKey
  in: cookie
  name: irontune_token   # = TOKEN_COOKIE (features/auth/lib/auth.ts)
```

### The unified error schema + reusable responses

```yaml
schemas:
  Error:
    type: object
    required: [error]
    properties:
      error: { type: string, description: 사람이 읽을 수 있는 에러 메시지 }
responses:
  BadRequest:      { description: 잘못된 요청,        content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
  Unauthorized:    { description: 인증 필요,          content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
  Forbidden:       { description: 권한 없음,          content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
  NotFound:        { description: 찾을 수 없음,       content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
  Conflict:        { description: 충돌(중복 등),      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
  TooManyRequests: { description: 요청 한도 초과,     content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
```

### Domain schemas (reuse — keep aligned with the TS/Prisma source)

Derive fields from the actual `select`/return shapes, not the full DB row. This repo's live
routes return trimmed views:

- **User** — from Prisma `User`, as returned by admin/auth routes:
  `{ id, email, role: enum[ADMIN,USER], status: enum[PENDING,APPROVED,REJECTED], createdAt }`.
- **ProjectSummary** — `POST /api/projects` / rename result: `{ id, name, folderId? }`.
- **ProjectDetail** — `GET /api/projects/{id}`: `{ id, name, spaceType, folderId,
  baseProjectId, hasAudio, createdAt, measurements: [MeasurementSummary], audio: AudioMeta|null,
  ancestors: [FolderRef] }`.
- **MeasurementSummary** — `{ id, label, speaker, powerW, durationSec, frameCount, recordedAt }`.
- **AudioMeta** — `{ filename, mimeType, sizeBytes }`.
- **Folder** — `{ id, name, parentId? }`.
- **FolderChildren** — `GET /api/folders` result of `listFolderChildren` (match its actual
  return shape: folders + projects for one level).
- **AnalysisFrame / MeasurementExport** — reuse verbatim from `features/audio/types.ts`
  (single source of truth) if any HTTP route ever returns them.

When one of these underlying types changes, the component must change too — treat a mismatch
as drift and update the component, don't leave a stale schema.

---

## Serving layer — the three templates

- `templates/openapi-spec.ts` → `src/shared/lib/openapi.ts`. Holds `buildOpenApiSpec()`
  (info, servers, `components` above, `security` default, `tags`) and points
  `apis: ['./src/app/api/**/route.ts']` at the handlers. `swagger-jsdoc` reads those files
  from disk, so the process needs the source present (true in dev `tsx server.ts` and in
  this repo's custom-server prod `node server.js`). If a deployment strips source (e.g.
  Next standalone output), switch to build-time generation: run the builder in a script and
  write `public/openapi.json`, and have the docs page load that static file instead.
- `templates/openapi-json-route.ts` → `src/app/api/openapi.json/route.ts`. `GET` returns the
  spec. Must be `runtime = 'nodejs'` (fs access) and `dynamic = 'force-dynamic'` (always
  fresh).
- `templates/api-docs-route.ts` → `src/app/api-docs/route.ts`. Returns an HTML shell that
  loads Swagger UI from the `swagger-ui-dist` CDN and reads `/api/openapi.json`. Using a
  route handler that emits `text/html` sidesteps `swagger-ui-react`'s React-19 peer-dep
  issues and needs no client bundle. If the project must run fully offline, install
  `swagger-ui-dist` and serve its assets from `/public` instead of the CDN.

### Middleware / auth interaction

If the app has route-protecting middleware, make sure `/api-docs` and `/api/openapi.json`
are reachable. In this repo `middleware.ts` only guards `/` and `/admin/*`, so the docs
paths are public by default — but confirm the matcher, and if the docs must be gated,
protect them explicitly rather than leaving them accidentally open.

---

## Coverage report (Step 7 output)

Present a table so gaps are visible:

| Endpoint | Documented | Statuses (code → doc) | Notes |
|---|---|---|---|
| `GET /api/projects/{id}` | ✅ | 200,401,404 → 200,401,404 | — |
| `POST /api/projects` | ✅ | 201,400,401,403,404 → same | httpError→403/404 from service |
| `ws /ws/audio` | ⛔ n/a | — | WebSocket, excluded from OpenAPI |

A row is only "done" when every status the handler can emit is documented.
