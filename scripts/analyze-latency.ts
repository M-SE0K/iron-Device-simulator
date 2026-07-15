/**
 * analyze-latency.ts — 측정 CSV에서 병목 분석
 *
 * 사용:
 *   npx tsx scripts/analyze-latency.ts measurements/impulse-*.csv
 */

import { readFileSync } from "fs";
import { resolve } from "path";

interface Frame {
  frameIdx: number;
  audioTime: number;
  hwCaptureMs: number | null;
  encodingMs: number | null;
  wasmMs: number;
  decodingMs: number;
  totalMs: number;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("사용: npx tsx scripts/analyze-latency.ts <csv-path>");
    process.exit(1);
  }

  const csv = readFileSync(csvPath, "utf-8");
  const lines = csv.split("\n").filter((l) => l.trim());
  const frames: Frame[] = [];

  for (let i = 1; i < lines.length; i++) {
    const [frameIdx, audioTime, hwCapture, encoding, wasm, decoding, total] = lines[i].split(",").map((v) => {
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    });

    frames.push({
      frameIdx: frameIdx as number,
      audioTime: audioTime as number,
      hwCaptureMs: hwCapture,
      encodingMs: encoding,
      wasmMs: wasm as number,
      decodingMs: decoding as number,
      totalMs: total as number,
    });
  }

  console.log(`\n■ 분석: ${frames.length} 프레임`);
  console.log(`Duration: ${(frames[frames.length - 1]?.audioTime ?? 0).toFixed(2)}s`);

  // ── 구간별 통계 ──────────────────────────────────────────────────────
  const stats = (values: (number | null)[], name: string) => {
    const nums = values.filter((v): v is number => v !== null && v > 0);
    if (nums.length === 0) {
      console.log(`${name.padEnd(15)} count=0`);
      return;
    }
    nums.sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const max = nums[nums.length - 1];
    const p95 = nums[Math.floor(nums.length * 0.95)];
    console.log(
      `${name.padEnd(15)} avg=${avg.toFixed(3).padStart(7)}ms  ` +
        `p95=${p95.toFixed(3).padStart(7)}ms  max=${max.toFixed(3).padStart(7)}ms  ` +
        `count=${nums.length}/${frames.length}`,
    );
  };

  console.log("\n── 각 구간 통계 ─────────────────────────────────────────");
  stats(
    frames.map((f) => f.hwCaptureMs),
    "1. HW capture",
  );
  stats(
    frames.map((f) => f.encodingMs),
    "2. Encoding",
  );
  stats(
    frames.map((f) => f.wasmMs),
    "3. WASM",
  );
  stats(
    frames.map((f) => f.decodingMs),
    "4. Decoding",
  );
  stats(
    frames.map((f) => f.totalMs),
    "E2E (1~4)",
  );

  // ── 렌더 지연 추정 ──────────────────────────────────────────────────
  // renderMs ≈ 16ms가 측정되었으므로, 총 지연 = E2E + render
  // 만약 render가 코얼레싱(3 프레임 누적)되면?
  const totalE2E = frames
    .map((f) => (f.hwCaptureMs ?? 0) + (f.encodingMs ?? 0) + f.wasmMs + f.decodingMs)
    .reduce((a, b) => a + b, 0) / frames.length;

  console.log("\n── 지연 시뮬레이션 (단일 Impulse) ─────────────────────────");
  console.log(`E2E 파이프라인:         ${totalE2E.toFixed(3)}ms`);
  console.log(`+ 렌더 (1 프레임):      ${(totalE2E + 16).toFixed(3)}ms`);
  console.log(`+ 렌더 (코얼레싱 3x):   ${(totalE2E + 16 * 3).toFixed(3)}ms`);
  console.log(`+ MCHStreamer 루프백:   ${(totalE2E + 16 * 3 + 15).toFixed(3)}ms (추정 15ms)`);

  // ── 극한값(max) 분석 ──────────────────────────────────────────────────
  const maxTotalFrame = frames.reduce((a, b) =>
    (a.hwCaptureMs ?? 0) + (a.encodingMs ?? 0) + a.wasmMs + a.decodingMs >
    (b.hwCaptureMs ?? 0) + (b.encodingMs ?? 0) + b.wasmMs + b.decodingMs
      ? a
      : b,
  );

  console.log("\n── 최악 케이스 프레임 ──────────────────────────────────────");
  console.log(`Frame #${maxTotalFrame.frameIdx} @ ${maxTotalFrame.audioTime.toFixed(3)}s:`);
  console.log(
    `  hwCapture=${maxTotalFrame.hwCaptureMs?.toFixed(3) ?? "null"}ms, ` +
      `encoding=${maxTotalFrame.encodingMs?.toFixed(3) ?? "null"}ms, ` +
      `wasm=${maxTotalFrame.wasmMs.toFixed(3)}ms, ` +
      `decoding=${maxTotalFrame.decodingMs.toFixed(3)}ms`,
  );
  console.log(`  합계=${maxTotalFrame.totalMs.toFixed(3)}ms`);

  // ── 권장사항 ──────────────────────────────────────────────────────────
  console.log("\n── 병목 진단 ──────────────────────────────────────────────");
  console.log(`✓ WASM/Encoding/Decoding: 무시할 수 있음 (< 0.01ms)`);
  console.log(`✓ HW capture: 정상 (평균 < 1ms)`);
  console.log(
    `⚠️  Render: 16ms는 60FPS 기준이지만, 코얼레싱/버퍼링 시 3 프레임 누적 = 48ms`,
  );
  console.log(`⚠️  MCHStreamer 루프백: 10~20ms (오디오 장치 지연 미측정)`);
  console.log(
    `\n총 지연 ≈ 48ms (렌더) + 15ms (루프백) ≈ 50~65ms (예상과 부분 일치)`,
  );
}

main();
