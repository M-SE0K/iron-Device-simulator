---
name: mse0k-domain-tw
description: Write and maintain a Korean README.md inside every domain folder of a domain-structured project (technical writing per domain). Reads the ACTUAL source before writing — never guesses; speculation must be prefixed "Claude의 생각은". Creates new domain READMEs and PARTIALLY updates existing ones only when meaningful changes (interface changes, file add/delete, dependency changes) landed since the last README-update commit, judged via git log/diff — typo/formatting churn never triggers an update. Human-authored notes are preserved unless the user approves deletion. Final text is always passed through the /humanize-korean skill before saving (AI draft → humanize → save). Manual trigger only. Use when the user asks to write/update domain READMEs, document a domain folder, or sync per-domain docs after code changes.
---

# domain-tw

> **언어: 이 스킬을 실행하는 동안 사용자에게 보내는 모든 답변(보고서, 표, 질문,
> 진행 설명 등)과 산출물 README.md 본문은 한국어로 작성한다.** 코드·심볼명·
> 파일경로·시그니처·명령어는 원문 그대로 둔다.

Maintain a **Korean `README.md` per domain folder**. Two modes per domain:
**create** (no README yet → write the full 6-section document) and **update**
(README exists → *partial* update of only the sections affected by meaningful
code changes). Every final README goes through the pipeline:

> **AI 초안 → `/humanize-korean` 윤문 → 저장**

## Core principle

> Read the code, don't guess. Update only what changed. Preserve what humans wrote.

Every sentence in a README must be backed by source code actually read in this
run. If a statement is inference rather than observed fact, it MUST be prefixed
**"Claude의 생각은"** so readers can tell verified fact from speculation.
When the code and an existing README disagree, the **code is ground truth**.

**Trigger: manual only.** Run solely when the user invokes `/mse0k-domain-tw`.
The root `CLAUDE.md` rule (see below) tells future sessions *when* an update is
due, but the skill itself never auto-runs.

## Step 0 — Establish domain boundaries (ask when ambiguous)

1. Read the project's `CLAUDE.md` / repository layout and list candidate domain
   folders (e.g. `components/dashboard`, `components/player`, `lib/engine`,
   `electron/`, …). A "domain" is a folder with a coherent responsibility, not
   every subfolder.
2. Present the proposed domain list (folder → one-line responsibility) to the
   user **before writing anything**.
3. **If any boundary is even slightly ambiguous** (folder could belong to two
   domains, unclear granularity — e.g. is `components/` one domain or five?),
   ask the user with concrete options and wait. Never resolve ambiguity by
   assumption.
4. **Split heuristic ("한 페이지 한 주제", Toss guide)**: if a README draft
   would need heading depth ≥ H4, or covers two or more core topics, treat
   that as an objective signal the folder is more than one domain — stop and
   ask the user whether to split before continuing.

## Step 1 — Decide create vs. update vs. skip (per domain)

For each confirmed domain folder:

1. No `<domain>/README.md` → **create mode**.
2. Otherwise find the last README-update commit and diff the domain since then:
   ```bash
   git log -1 --format=%H -- <domain>/README.md
   git diff <that-hash>..HEAD --stat -- <domain>
   git status --porcelain <domain>   # include uncommitted work-tree changes
   ```
3. Classify the changes:
   - **Meaningful → update mode**: exported interface/signature changes, file
     added/deleted/renamed, import/dependency changes (new module wired in or
     removed), data-flow or entry-point changes.
   - **Trivial → skip**: typos, formatting/whitespace, comment wording, lint
     fixes, pure style churn. Report the domain as "갱신 불필요" with the
     evidence (diffstat) instead of touching its README.
4. Report the per-domain verdict table (create / update / skip + evidence)
   and get user approval before drafting.

## Step 2 — Read the source (hallucination guard)

- **Create mode**: read every file in the domain (skim large generated files,
  but open them). **Update mode**: read every changed file plus its direct
  neighbors (importers/importees) needed to describe the change correctly.
- Trace `import` statements to map which other domains this one exchanges data
  with, and in which direction.
- Never describe a file you did not open in this run. If something cannot be
  verified from code (e.g. vendor behavior, runtime-only facts), either omit it
  or write it as **"Claude의 생각은 …"**.

## Step 3 — Draft (AI 초안)

Write the draft in Korean with exactly this section skeleton:

```markdown
# <도메인명>

## 1. 도메인 설명
<가치 먼저: 첫 1~2문장은 "이 도메인이 해결하는 문제 / 독자가 얻는 것".
기능 나열·배경·이력은 그 뒤로>

## 2. 프로젝트 전반에서의 역할
<전체 아키텍처에서 이 도메인이 맡는 위치/책임>

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `foo.ts` | <한 줄 설명> |

## 4. 의존성 및 흐름
<다른 어떤 도메인과 데이터를 주고받는지(방향 포함), 내부적으로 요청이
어떻게 처리되는지. 필요하면 텍스트 다이어그램(A → B → C) 사용>

## 5. 주요 인터페이스 / 진입점
<외부에 노출하는 함수·클래스·훅·API의 "이걸 쓰면 된다" 수준 시그니처 목록.
전체 구현 설명 금지. 항목 형식 통일: 이름 → 시그니처 → 한 줄 용도 →
(필요시) 주의사항. 단위·동작 조건(ms, bytes, °C, "~인 경우에만") 명시>

## 6. 변경 이력(요약)
- YYYY-MM-DD: <이번 갱신이 반영한 변경 요약> (커밋 범위: <short-hash>..<short-hash>)
```

### Writing rules (from the Toss technical writing guide)

- **Document type**: a domain README is an **explanation + reference hybrid**.
  Sections 1·2·4 are *explanation* — start from the problem the domain solves
  (why it exists), and visualize complex flows as text diagrams. Sections 3·5
  are *reference* — accuracy, no omissions, uniform entry format (see the
  skeleton notes above).
- **Concreteness × hallucination guard**: facts verified from code are stated
  **assertively with concrete numbers/units** ("1920 bytes/frame", "ms 단위");
  unverifiable statements carry the "Claude의 생각은" prefix. The hedging
  middle ground ("영향을 받을 수도 있습니다") is banned — pick one side.
- **Consistency**: one term per concept, within a README and across all domain
  READMEs (no 상태/데이터/값 mixing for the same thing). Expand abbreviations
  at first use — `SSR(Server-Side Rendering)` style. Official names only
  (쿠버네티스(Kubernetes), not "K8"). The 6-section skeleton's order and
  titles are fixed — never reorder or rename.
- **Headings**: sub-headings (H3) carry core keywords, stay ≤ 30 chars, use
  declarative form (no `?`/`!`), and keep parallel grammar (all noun-form or
  all "-하기"). Never go H4 or deeper — that triggers the Step 0 split
  heuristic.
- **Sentences (draft quality — lightens the humanize pass)**: active voice
  with the developer as subject, not the tool ("이 라이브러리는 ~를 수행해요"
  → "이 명령어를 실행하면 ~할 수 있어요"); drop "수행하다/진행하다/실시하다"
  nominalization ("인증 처리가 완료된 후" → "인증한 후"); one idea per
  sentence; no metadiscourse ("앞에서 설명했지만…").

**Update mode is PARTIAL**: rewrite only the sections invalidated by the
classified changes; leave untouched sections byte-identical. Always append a
new entry to section 6.

**Preserving human-authored content**: any prose in the existing README that
this skill did not generate (특이 케이스 메모, 팀 합의 사항, 배경 설명 —
recognizable by not fitting the skeleton's generated style, or confirmable via
`git log -p` on the README) must survive the update verbatim as long as it does
not contradict the current code. If a human note now contradicts the code or
blocks a needed rewrite, show it to the user with before→after and **ask before
deleting or altering it**.

## Step 4 — Humanize (/humanize-korean)

1. Show the AI draft (or the update diff) to the user first — the draft is an
   intermediate artifact the user receives before polishing.
2. Invoke the **`humanize-korean`** skill on the draft to remove AI-ish style.
3. Fidelity check on the humanized text: every code symbol, file path,
   signature, number, and every "Claude의 생각은" prefix must survive
   unchanged — humanizing may touch style only. If anything drifted, restore it
   from the draft.

## Step 4.5 — Self-review checklist (before saving)

Adapted from the Toss guide's per-type checklists; verify on the **humanized**
text:

- [ ] 섹션 1이 제목 바로 아래에서 도메인의 가치(해결하는 문제/독자 이득)를
      말하는가? 기능 나열·배경으로 시작하지 않는가?
- [ ] 핵심 원리·배경이 설명되고, 필요한 선행 지식이 안내됐는가? (설명 파트)
- [ ] 정보가 정확하고 누락이 없으며, 섹션 5 항목 형식이 일관된가? (레퍼런스 파트)
- [ ] H4 이상 깊어진 헤딩이 없는가? (있으면 Step 0 분리 질문으로 회귀)
- [ ] 용어 혼용, 약어 미병기, hedging 표현("~일 수도")이 없는가?
- [ ] 모든 추측 서술에 "Claude의 생각은" 접두가 붙어 있는가?

Any failed item → fix the draft and re-run Step 4 for the touched part.

## Step 5 — Save & report

1. Write the humanized text to `<domain>/README.md` (create) or apply the
   partial update (update).
2. Report a summary table: domain / mode / sections touched / human notes
   preserved / commit range reflected.
3. Commit only if the user asks (e.g. `docs: <domain> README 갱신
   (domain-tw)`). Never `git push`.

## Root CLAUDE.md rule (one-time wiring)

This skill depends on a maintenance rule in the **project root `CLAUDE.md`**.
On every run, check it exists; if missing, propose adding:

```markdown
## Domain README 유지 규칙 (mse0k-domain-tw)

- 도메인 폴더마다 한국어 `README.md`를 둔다. 작성/갱신은 `/mse0k-domain-tw` 스킬로 수행한다.
- 도메인 내부에 **의미 있는 변경**(인터페이스 변경, 파일 추가/삭제, 의존성 변경)이
  생기면 해당 도메인의 `README.md`를 **부분 갱신**해야 한다. 판단 기준은 그 도메인의
  마지막 README 갱신 커밋 이후의 `git log` / `git diff`이며, 오타·포맷팅 수준의
  변경은 갱신 대상이 아니다.
- 부분 갱신 시 사람이 직접 작성한 메모/팀 합의/배경 설명은 코드 변경과 무관하면
  보존하고, 삭제가 필요하면 사용자 확인을 받는다.
```

## Hard rules

- Domain boundaries are confirmed by the user before any README is written;
  ambiguity is resolved by asking, never by assuming.
- Never describe code not read in this run. Unverifiable or inferred statements
  carry the **"Claude의 생각은"** prefix — no exceptions.
- Never delete or rewrite human-authored README content without showing
  before→after and getting explicit approval.
- Trivial changes (typos, formatting) never trigger a README update.
- A README is never saved without passing through `/humanize-korean`; the
  humanize pass may change style only, never content/symbols/signatures.
- Update mode touches only affected sections; untouched sections stay
  byte-identical. Section 6 (변경 이력) always gains an entry on update.
- Never `git push`. Commit only when asked.

## Sources (출처)

- **문서 유형·정보 구조·헤딩/문장 규칙**: Toss 기술 문서 작성 가이드 —
  <https://technical-writing.dev/> (CC BY-NC-SA 4.0)
- **AI 윤문 (`/humanize-korean`)**: im-not-ai —
  <https://github.com/epoko77-ai/im-not-ai.git>
