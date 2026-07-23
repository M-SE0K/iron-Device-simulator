#!/usr/bin/env node

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
  console.log(`\t - 세션 시작: ${meta.startedAt}`);
  console.log(`\t - 모드: ${meta.mode}   엔진: ${meta.engine}   장치: ${meta.deviceName ?? "-"}`);
  console.log(`\t - 샘플레이트: ${meta.sampleRate}Hz   버퍼: ${meta.samplesPerCh}samples/ch   채널: ${meta.channels}\n`);
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
}

function isAnomalousStat(s) {
  return !!s && s.avg !== null && (s.avg < 0 || Math.abs(s.avg) > 5000);
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
  console.log(`\n워커 왕복 오버헤드(N3+N7 avg) ${overhead.toFixed(3)}ms vs 실제 연산(N5+N6 avg) ${compute.toFixed(3)}ms`);
}

// N1~N12를 파이프라인 순서대로 이어 붙인 "총 E2E 지연" 근사치. count=0(그 경로 미사용)이거나
// 이상치인 노드는 자동으로 빼고, 뭘 뺐는지 이유와 함께 남긴다.
function computeTotalE2E(summary) {
  const included = [];
  const excludedZero = [];
  const excludedAnomalous = [];
  let sumAvg = 0;
  let sumP95 = 0;
  let sumP50 = 0;

  for (const id of NODE_ORDER) {
    const s = summary[id];
    if (!s || s.count === 0) { excludedZero.push(id); continue; }
    if (isAnomalousStat(s)) { excludedAnomalous.push(id); continue; }
    included.push(id);
    sumAvg += s.avg ?? 0;
    sumP95 += s.p95 ?? 0;
    sumP50 += s.p50 ?? 0;
  }

  return { included, excludedZero, excludedAnomalous, sumAvg, sumP50, sumP95 };
}

function printTotalE2E(label, nodes, summary) {
  const t = computeTotalE2E(summary);
  if (t.included.length === 0) return t;

  console.log(`\n총 E2E 지연 추정치${label ? ` (${label})` : ""} — N1~N12 합산(캡처→렌더)`);
  console.log(`  포함(${t.included.length}/12): ${t.included.join(", ")}`);
  if (t.excludedZero.length > 0) console.log(`  제외: ${t.excludedZero.join(", ")}`);
  if (t.excludedAnomalous.length > 0) console.log(`  제외(이상치): ${t.excludedAnomalous.join(", ")}`);
  console.log(`  avg 합계 ≈ ${t.sumAvg.toFixed(2)}ms   p50 합계 ≈ ${t.sumP50.toFixed(2)}ms   p95 합계 ≈ ${t.sumP95.toFixed(2)}ms`);
  return t;
}

function printSmallBufferWarning(meta) {
  if (!meta.samplesPerCh || meta.samplesPerCh >= 200) return;
  console.log(
    `\nsamplesPerCh=${meta.samplesPerCh}(작음, 기본값 480) — 초당 청크 수가 매우 많아 ` +
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
  printTotalE2E(null, report.nodes, report.summary);
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
  console.log("=".repeat(100));
  console.log(` E2E 지연 실험 비교 — A: ${a.fileName}  vs  B: ${b.fileName}`);
  console.log("[A]"); printMeta(a);
  console.log("[B]"); printMeta(b);

  const metaDiffs = META_COMPARE_FIELDS.filter((k) => String(a.meta[k]) !== String(b.meta[k]));
  if (metaDiffs.length > 0) {
    for (const k of metaDiffs) console.log(`  - ${k}: A=${a.meta[k]}  B=${b.meta[k]}`);
  }

  // ---- 노드별 이상치 (각 파일 개별) ----
  const anomaliesA = detectAnomalies(a.summary).map((m) => `[A] ${m}`);
  const anomaliesB = detectAnomalies(b.summary).map((m) => `[B] ${m}\n`);
  printAnomalies([...anomaliesA, ...anomaliesB]);
  console.log("=".repeat(100));

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

  // ---- 총 E2E 지연 비교 ----
  const totalA = computeTotalE2E(a.summary);
  const totalB = computeTotalE2E(b.summary);
  if (totalA.included.length > 0 && totalB.included.length > 0) {
    console.log(`\n총 E2E 지연 추정치 비교 (N1~N12 합산)`);
    console.log(`  A(${totalA.included.join(",")}) avg ≈ ${totalA.sumAvg.toFixed(2)}ms, p95 ≈ ${totalA.sumP95.toFixed(2)}ms`);
    console.log(`  B(${totalB.included.join(",")}) avg ≈ ${totalB.sumAvg.toFixed(2)}ms, p95 ≈ ${totalB.sumP95.toFixed(2)}ms`);
    const dAvg = pctDelta(totalA.sumAvg, totalB.sumAvg);
    const dP95 = pctDelta(totalA.sumP95, totalB.sumP95);
    console.log(
      `  Δavg ${dAvg === null ? "-" : `${dAvg > 0 ? "+" : ""}${dAvg.toFixed(1)}%`}   ` +
      `Δp95 ${dP95 === null ? "-" : `${dP95 > 0 ? "+" : ""}${dP95.toFixed(1)}%`}`
    );
    console.log("  (합산 방식·주의사항은 아래 A/B 개별 섹션의 총 E2E 지연 추정치 참고)");
  }

  // ---- 큐잉 경로 사용 여부가 다른가(N9/N10 count 유무로 추정) ----
  const aQueued = (a.summary.N9 && a.summary.N9.count > 0) || (a.summary.N10 && a.summary.N10.count > 0);
  const bQueued = (b.summary.N9 && b.summary.N9.count > 0) || (b.summary.N10 && b.summary.N10.count > 0);
  if (aQueued !== bQueued) {
    console.log(
      `\nℹ큐잉 렌더 경로(N9/N10) 사용 여부가 다릅니다 — A: ${aQueued ? "사용" : "미사용"}, ` +
      `B: ${bQueued ? "사용" : "미사용"} (useQueue 설정 차이로 보임). N9/N10뿐 아니라 N11/N12(React ` +
      `커밋/렌더)도 이 차이 때문에 달라질 수 있으니, 그 둘의 변화를 useQueue 효과로 해석해도 됩니다.`
    );
  }

  // ---- 노드별 상세 해석은 두 세션 각각에 대해 ----
  console.log("\n------------------------------ A 상세 ------------------------------");
  printZeroNotes(a.summary);
  printTotalE2E("A", a.nodes, a.summary);
  printWorkerOffloadNote(a.summary);

  console.log("\n------------------------------ B 상세 ------------------------------");
  printZeroNotes(b.summary);
  printTotalE2E("B", b.nodes, b.summary);
  printWorkerOffloadNote(b.summary);
  
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
