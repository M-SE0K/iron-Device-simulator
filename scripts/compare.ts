/**
 * compare.ts — 측정 결과 비교
 *
 * measurements 디렉토리에서 JSON 파일들을 읽어 요약 테이블을 출력한다.
 *
 * 사용: npx tsx scripts/compare.ts [file1.json file2.json ...]
 *       npx tsx scripts/compare.ts   (→ measurements/*.json 전체 비교)
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, basename } from "path";

const measDir = resolve(__dirname, "..", "measurements");

// 파일 목록
let files: string[];
if (process.argv.length > 2) {
  files = process.argv.slice(2).map(f => resolve(f));
} else {
  try {
    files = readdirSync(measDir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .map(f => resolve(measDir, f));
  } catch {
    console.error("measurements 디렉토리가 없습니다. 먼저 측정을 실행하세요.");
    process.exit(1);
  }
}

if (files.length === 0) {
  console.error("비교할 측정 파일이 없습니다.");
  process.exit(1);
}

interface Stats {
  avg: number | null;
  min?: number | null;
  max?: number | null;
  p50?: number | null;
  p95?: number | null;
  p99?: number | null;
}

interface MeasData {
  meta: { label?: string; frameCount: number; measurementDurationSec: number };
  summary: {
    rtt: Stats;
    recvRender?: Stats;
    e2e: Stats;
    freshnessLag?: Stats;
    maxStreamingFramesLen?: number;
    serverProc: Stats;
    temperature: Stats;
    excursion: Stats;
  };
}

// 데이터 로드
const entries = files.map(f => {
  const data = JSON.parse(readFileSync(f, "utf-8")) as MeasData;
  return { file: basename(f), data };
});

// 포맷 유틸
const fmt  = (v: number | null | undefined, w = 8) =>
  v == null ? "—".padStart(w) : v.toFixed(2).padStart(w);
const hdr  = (s: string, w = 8) => s.padStart(w);

// 비교 지표 목록
const metrics: { name: string; key: keyof MeasData["summary"]; fields: string[] }[] = [
  { name: "RTT (ms)",          key: "rtt",          fields: ["avg", "p50", "p95", "p99", "max"] },
  { name: "Recv→Render (ms)",  key: "recvRender",   fields: ["avg", "p50", "p95", "p99", "max"] },
  { name: "E2E (ms)",          key: "e2e",          fields: ["avg", "p50", "p95", "p99", "max"] },
  { name: "Freshness (ms)",    key: "freshnessLag", fields: ["avg", "p50", "p95", "p99", "max"] },
];

// 테이블 출력
const colW    = 10;
const labelW  = 22;
const sep     = "─".repeat(labelW + (colW + 1) * entries.length + 2);

console.log(`\n${"═".repeat(70)}`);
console.log(`  Measurement Comparison — ${entries.length} files`);
console.log(`${"═".repeat(70)}\n`);

// 메타 정보
console.log(`${"".padEnd(labelW)} ${entries.map(e => e.data.meta.label?.padStart(colW) ?? basename(e.file).slice(0, colW).padStart(colW)).join(" ")}`);
console.log(`${"Frames".padEnd(labelW)} ${entries.map(e => String(e.data.meta.frameCount).padStart(colW)).join(" ")}`);
console.log(`${"Duration (s)".padEnd(labelW)} ${entries.map(e => e.data.meta.measurementDurationSec.toFixed(1).padStart(colW)).join(" ")}`);
if (entries.some(e => e.data.summary.maxStreamingFramesLen !== undefined)) {
  console.log(`${"Max Buffer (fr)".padEnd(labelW)} ${entries.map(e => String(e.data.summary.maxStreamingFramesLen ?? "—").padStart(colW)).join(" ")}`);
}
console.log(sep);

for (const metric of metrics) {
  console.log(`\n  ${metric.name}`);
  for (const field of metric.fields) {
    const row = `  ${field.padEnd(labelW - 2)} ${
      entries.map(e => {
        const stats = e.data.summary[metric.key] as Stats | undefined;
        const val = stats ? (stats as unknown as Record<string, number | null | undefined>)[field] : null;
        return fmt(val, colW);
      }).join(" ")
    }`;
    console.log(row);
  }
}

// 서버 처리 시간
console.log(`\n  Server Proc (ms)`);
console.log(`  ${"avg".padEnd(labelW - 2)} ${entries.map(e => fmt(e.data.summary.serverProc.avg, colW)).join(" ")}`);

console.log(`\n${sep}`);

// 변화율 계산 (첫 파일을 baseline으로)
if (entries.length >= 2) {
  console.log(`\n  Change vs "${entries[0].data.meta.label ?? entries[0].file}"\n`);
  const base = entries[0].data;

  for (const metric of metrics) {
    const baseStats = base.summary[metric.key] as Stats | undefined;
    if (!baseStats?.avg) continue;

    const changes = entries.slice(1).map(e => {
      const stats = e.data.summary[metric.key] as Stats | undefined;
      if (!stats?.avg || !baseStats.avg) return "—".padStart(colW);
      const pct = ((stats.avg - baseStats.avg) / baseStats.avg * 100).toFixed(1);
      const sign = stats.avg <= baseStats.avg ? "" : "+";
      return `${sign}${pct}%`.padStart(colW);
    });

    console.log(`  ${metric.name.padEnd(labelW)} ${"(base)".padStart(colW)} ${changes.join(" ")}`);
  }
}

console.log(`\n${"═".repeat(70)}\n`);
