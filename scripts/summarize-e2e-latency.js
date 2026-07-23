#!/usr/bin/env node
// scripts/summarize-e2e-latency.js — window.__ironE2E.download()로 받은 e2e-latency_*.json을
// 요약·해석한다. docs/e2e-latency-experiment.md의 "해석 가이드"를 코드로 옮긴 것 — 표만 찍는 게
// 아니라 이 데이터셋에서 뭐가 병목 후보인지, 값이 0이거나 비정상인 이유가 뭔지까지 같이 알려준다.
//
// 사용법:
//   node scripts/summarize-e2e-latency.js <A.json>            # 단일 파일 요약
//   node scripts/summarize-e2e-latency.js <A.json> <B.json>   # 두 세션 비교
//   npm run summarize:e2e -- <A.json> [<B.json>]
"use strict";

const fs = require("fs");
const path = require("path");

const RENDER_INTERVAL_MS = 100; // DashboardClient.tsx의 RENDER_INTERVAL과 일치시켜둔 값

const NODE_ORDER = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12"];

// 스레드/프로세스 경계가 있어 특정 조건에서만 값이 채워지는 노드 — count=0이어도 정상일 수 있다.
const CONDITIONAL_NODES = {
  N1: "Electron 전용(웹 빌드) 또는 enable()을 세션 시작 전에 안 부른 경우 0",
  N3: "메인 스레드 엔진 경로(NEXT_PUBLIC_USE_WORKER_ENGINE=0)면 0",
  N4: "메인 스레드 엔진 경로면 0",
  N7: "메인 스레드 엔진 경로면 0",
  N9: "useQueue=false(.env의 USE_QUEUE=false 등)면 0 — 프레임이 큐 없이 바로 렌더됨",
  N10: "useQueue=false면 0",
};

const META_COMPARE_FIELDS = ["mode", "engine", "sampleRate", "samplesPerCh", "channels", "deviceName"];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function expandHome(p) {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "");
}

function loadReport(filePath) {
  const resolved = path.resolve(process.cwd(), expandHome(filePath));
  if (!fs.existsSync(resolved)) fail(`파일을 찾을 수 없습니다: ${resolved}`);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    fail(`JSON 파싱 실패(${resolved}): ${err.message}`);
  }
  const { meta, nodes, summary } = data;
  if (!meta || !summary) {
    fail(`${resolved} — E2E 지연 실험(window.__ironE2E.download()) 결과 형식이 아닙니다.`);
  }
  return { fileName: path.basename(resolved), meta, nodes, summary };
}

// avg가 음수거나 비정상적으로 크면(스레드/프로세스 경계를 performance.now()로 잘못 잰 시계 불일치
// 버그의 흔적) 노드별 경고 메시지를 만든다.
function detectAnomalies(summary) {
  const anomalies = [];
  for (const id of NODE_ORDER) {
    const s = summary[id];
    if (!s || s.avg === null) continue;
    if (s.avg < 0 || Math.abs(s.avg) > 5000) {
      anomalies.push(
        `${id}: avg=${s.avg}ms — 비정상적으로 크거나 음수. 스레드/프로세스 경계를 performance.now()로 ` +
        `쟀다면 시간 원점 불일치 버그일 수 있다(Worker의 performance.now()는 "그 Worker가 생성된 시점" ` +
        `기준이라 메인 스레드와 다름 — 반드시 Date.now() 벽시계로 재야 함). 최신 코드는 고쳐져 있으니 ` +
        `이 파일이 구버전 산출물인지, out/이 최신 소스로 재빌드됐는지 확인.`
      );
    }
  }
  return anomalies;
}

function printMeta(report) {
  const { meta } = report;
  console.log(`세션 시작: ${meta.startedAt}`);
  console.log(`모드: ${meta.mode}   엔진: ${meta.engine}   장치: ${meta.deviceName ?? "-"}`);
  console.log(`샘플레이트: ${meta.sampleRate}Hz   버퍼: ${meta.samplesPerCh}samples/ch   채널: ${meta.channels}`);
}

function printAnomalies(anomalies) {
  if (anomalies.length === 0) return;
  console.log("\n⚠️  이상치 감지");
  for (const a of anomalies) console.log(`  - ${a}`);
}

function printZeroNotes(summary) {
  const zeroNotes = NODE_ORDER
    .filter((id) => summary[id] && summary[id].count === 0 && CONDITIONAL_NODES[id])
    .map((id) => `  - ${id}: ${CONDITIONAL_NODES[id]}`);
  if (zeroNotes.length === 0) return;
  console.log("\nℹ️  count=0인 노드 (버그 아님, 아래 조건이면 정상)");
  console.log(zeroNotes.join("\n"));
}

function isAnomalousStat(s) {
  return !!s && s.avg !== null && (s.avg < 0 || Math.abs(s.avg) > 5000);
}

function printBottleneckRanking(nodes, summary) {
  const excluded = NODE_ORDER.filter((id) => isAnomalousStat(summary[id]));
  const ranked = NODE_ORDER
    .map((id) => ({ id, ...summary[id] }))
    .filter((n) => n.count > 0 && n.p95 !== null && !isAnomalousStat(n))
    .sort((a, b) => b.p95 - a.p95);
  if (ranked.length === 0) return;
  console.log(
    `\n🔥 병목 후보 (p95 기준 내림차순${excluded.length > 0 ? `, 이상치 ${excluded.join("/")} 제외` : ""})`
  );
  ranked.slice(0, 5).forEach((n, i) => {
    const label = (nodes && nodes[n.id] && nodes[n.id].label) || n.id;
    console.log(`  ${i + 1}. ${n.id} ${label} — p95 ${n.p95}ms (avg ${n.avg}ms, max ${n.max}ms)`);
  });
}

function printQueueingNote(summary) {
  const n9 = summary.N9;
  if (!n9 || n9.count === 0) return;
  const half = RENDER_INTERVAL_MS / 2;
  console.log(
    `\nN9(출력 큐 대기) avg=${n9.avg}ms — RENDER_INTERVAL(${RENDER_INTERVAL_MS}ms)의 절반(${half}ms)` +
    (Math.abs(n9.avg - half) < half * 0.4
      ? " 근처라 정상 범위(균등분포 대기)."
      : " 과 꽤 다름 — setInterval 자체가 밀리고 있을 수 있음(메인 스레드 혼잡 의심).")
  );
  if (n9.p95 !== null && n9.p95 > RENDER_INTERVAL_MS) {
    console.log(`  p95(${n9.p95}ms)가 RENDER_INTERVAL을 넘음 — 드레인 주기가 밀리는 중.`);
  }
}

function printWorkerOffloadNote(summary) {
  const { N3: n3, N7: n7, N5: n5, N6: n6 } = summary;
  if (!n3 || !n7 || !n5 || !n6 || n3.count === 0 || n7.count === 0) return;
  if ((n3.avg < 0 || Math.abs(n3.avg) > 5000) || (n7.avg < 0 || Math.abs(n7.avg) > 5000)) {
    console.log("\n(N3/N7이 이상치라 워커 오프로딩 손익 계산은 건너뜀 — 위 이상치 감지 참고)");
    return;
  }
  const overhead = (n3.avg ?? 0) + (n7.avg ?? 0);
  const compute = (n5.avg ?? 0) + (n6.avg ?? 0);
  console.log(
    `\n워커 왕복 오버헤드(N3+N7 avg) ${overhead.toFixed(3)}ms vs 실제 연산(N5+N6 avg) ${compute.toFixed(3)}ms` +
    (overhead > compute
      ? " — 오프로딩 비용이 연산 비용보다 큼. NEXT_PUBLIC_USE_WORKER_ENGINE=0(메인 스레드 엔진)과 비교 실험 권장."
      : " — 오프로딩 비용이 연산 비용보다 작아 워커 사용이 이득으로 보임.")
  );
}

function printSmallBufferWarning(meta) {
  if (!meta.samplesPerCh || meta.samplesPerCh >= 200) return;
  console.log(
    `\n⚠️  samplesPerCh=${meta.samplesPerCh}(작음, 기본값 480) — 초당 청크 수가 매우 많아 ` +
    `N1/N3/N4처럼 청크 빈도에 비례하는 노드의 값이 실제 대역폭 문제라기보다 IPC/스케줄링 콜 빈도 ` +
    `자체에 의해 부풀려졌을 수 있다. 기본 버퍼 크기(480)로도 재측정해서 비교 권장.`
  );
}

function printSingleReport(report) {
  console.log("=".repeat(64));
  console.log(" E2E 지연 실험 요약 —", report.fileName);
  console.log("=".repeat(64));
  printMeta(report);
  console.log();

  const rows = {};
  for (const id of NODE_ORDER) {
    const s = report.summary[id];
    if (!s) continue;
    const label = (report.nodes && report.nodes[id] && report.nodes[id].label) || id;
    rows[`${id} ${label}`] = {
      count: s.count, "avg(ms)": s.avg, "p50(ms)": s.p50, "p95(ms)": s.p95, "p99(ms)": s.p99, "max(ms)": s.max,
    };
  }
  console.table(rows);

  printAnomalies(detectAnomalies(report.summary));
  printZeroNotes(report.summary);
  printBottleneckRanking(report.nodes, report.summary);
  printQueueingNote(report.summary);
  printWorkerOffloadNote(report.summary);
  printSmallBufferWarning(report.meta);
  console.log();
}

function pctDelta(a, b) {
  if (a === null || b === null || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

function fmt(v) {
  return v === null || v === undefined ? "-" : v;
}

function printComparison(a, b) {
  console.log("=".repeat(72));
  console.log(` E2E 지연 실험 비교 — A: ${a.fileName}  vs  B: ${b.fileName}`);
  console.log("=".repeat(72));
  console.log("[A]"); printMeta(a);
  console.log("[B]"); printMeta(b);

  const metaDiffs = META_COMPARE_FIELDS.filter((k) => String(a.meta[k]) !== String(b.meta[k]));
  if (metaDiffs.length > 0) {
    console.log("\n⚠️  두 세션의 조건이 다릅니다 — 아래 필드는 동일 조건 비교가 아닙니다:");
    for (const k of metaDiffs) console.log(`  - ${k}: A=${a.meta[k]}  B=${b.meta[k]}`);
    if (metaDiffs.includes("samplesPerCh")) {
      console.log(
        "    → samplesPerCh(버퍼 크기)가 다르면 청크 발생 빈도 자체가 달라지므로 N1/N3/N4(청크 빈도에 " +
        "비례)는 두 세션 간 직접 비교가 왜곡됩니다. 같은 버퍼 크기로 다시 재는 걸 권장합니다."
      );
    }
  }

  // ---- 노드별 이상치 (각 파일 개별) ----
  const anomaliesA = detectAnomalies(a.summary).map((m) => `[A] ${m}`);
  const anomaliesB = detectAnomalies(b.summary).map((m) => `[B] ${m}`);
  printAnomalies([...anomaliesA, ...anomaliesB]);

  // ---- 비교 표 ----
  const rows = {};
  for (const id of NODE_ORDER) {
    const sa = a.summary[id];
    const sb = b.summary[id];
    if (!sa && !sb) continue;
    const label = (a.nodes && a.nodes[id] && a.nodes[id].label) || (b.nodes && b.nodes[id] && b.nodes[id].label) || id;
    const avgA = sa && sa.count > 0 ? sa.avg : null;
    const avgB = sb && sb.count > 0 ? sb.avg : null;
    const p95A = sa && sa.count > 0 ? sa.p95 : null;
    const p95B = sb && sb.count > 0 ? sb.p95 : null;
    const anomalous =
      (avgA !== null && (avgA < 0 || Math.abs(avgA) > 5000)) ||
      (avgB !== null && (avgB < 0 || Math.abs(avgB) > 5000));
    rows[`${id} ${label}${anomalous ? " ⚠️" : ""}`] = {
      "A count": sa ? sa.count : 0,
      "B count": sb ? sb.count : 0,
      "A avg": fmt(avgA),
      "B avg": fmt(avgB),
      "Δavg%": anomalous ? "-" : fmt(pctDelta(avgA, avgB) === null ? null : Math.round(pctDelta(avgA, avgB))),
      "A p95": fmt(p95A),
      "B p95": fmt(p95B),
      "Δp95%": anomalous ? "-" : fmt(pctDelta(p95A, p95B) === null ? null : Math.round(pctDelta(p95A, p95B))),
    };
  }
  console.table(rows);
  console.log("(Δ%는 A→B 변화율 — 양수면 B가 더 느려짐, 음수면 B가 더 빨라짐. ⚠️ 표시 노드는 이상치라 Δ% 계산을 건너뜀)");

  // ---- 큐잉 경로 사용 여부가 다른가(N9/N10 count 유무로 추정) ----
  const aQueued = (a.summary.N9 && a.summary.N9.count > 0) || (a.summary.N10 && a.summary.N10.count > 0);
  const bQueued = (b.summary.N9 && b.summary.N9.count > 0) || (b.summary.N10 && b.summary.N10.count > 0);
  if (aQueued !== bQueued) {
    console.log(
      `\nℹ️  큐잉 렌더 경로(N9/N10) 사용 여부가 다릅니다 — A: ${aQueued ? "사용" : "미사용"}, ` +
      `B: ${bQueued ? "사용" : "미사용"} (useQueue 설정 차이로 보임). N9/N10뿐 아니라 N11/N12(React ` +
      `커밋/렌더)도 이 차이 때문에 달라질 수 있으니, 그 둘의 변화를 useQueue 효과로 해석해도 됩니다.`
    );
  }

  // ---- 노드별 상세 해석은 두 세션 각각에 대해 ----
  console.log("\n--- A 상세 ---");
  printZeroNotes(a.summary);
  printBottleneckRanking(a.nodes, a.summary);
  printQueueingNote(a.summary);
  printWorkerOffloadNote(a.summary);
  printSmallBufferWarning(a.meta);

  console.log("\n--- B 상세 ---");
  printZeroNotes(b.summary);
  printBottleneckRanking(b.nodes, b.summary);
  printQueueingNote(b.summary);
  printWorkerOffloadNote(b.summary);
  printSmallBufferWarning(b.meta);

  console.log();
}

const args = process.argv.slice(2);
if (args.length === 0) {
  fail(
    "파일 경로를 넘겨주세요:\n" +
    "  node scripts/summarize-e2e-latency.js <A.json>            # 단일 요약\n" +
    "  node scripts/summarize-e2e-latency.js <A.json> <B.json>   # 비교"
  );
} else if (args.length === 1) {
  printSingleReport(loadReport(args[0]));
} else {
  printComparison(loadReport(args[0]), loadReport(args[1]));
}
