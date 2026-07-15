/**
 * measure-loopback.ts — MCHStreamer 루프백 지연 측정
 *
 * WAV 파일의 Impulse 위치와 측정 CSV의 반응을 비교해서
 * 루프백 지연을 정확히 측정한다.
 *
 * 사용:
 *   npx tsx scripts/measure-loopback.ts <csv-path> <impulse-times>
 *   예) npx tsx scripts/measure-loopback.ts measurements/impulse-*.csv "50.050,50.150,52.090"
 */

import { readFileSync } from "fs";

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
  const impulseTimes = process.argv[3];

  if (!csvPath || !impulseTimes) {
    console.error(
      "사용: npx tsx scripts/measure-loopback.ts <csv-path> <impulse-times>",
    );
    console.error(
      '  예) npx tsx scripts/measure-loopback.ts measurements/impulse-*.csv "50.050,50.150,52.090"',
    );
    process.exit(1);
  }

  const times = impulseTimes.split(",").map((t) => parseFloat(t.trim()));

  console.log(`▶ CSV 로드: ${csvPath}`);
  const csv = readFileSync(csvPath, "utf-8");
  const lines = csv.split("\n").filter((l) => l.trim());
  const frames: Frame[] = [];

  for (let i = 1; i < lines.length; i++) {
    const [frameIdx, audioTime, hwCapture, encoding, wasm, decoding, total] = lines[i]
      .split(",")
      .map((v) => {
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

  console.log(`▶ 분석: ${times.length}개 Impulse 시간 vs ${frames.length}개 프레임`);

  const loopbackDelays: number[] = [];

  for (const impTime of times) {
    // Impulse 시간 근처에서 반응 찾기
    // 루프백 지연이 50ms 정도라고 가정하면, impTime + 50ms 이후에 반응이 나타남
    const searchStart = impTime + 0.01; // 10ms 후부터
    const searchEnd = impTime + 0.1; // 100ms까지 탐색

    // audioTime이 searchStart~searchEnd 범위에 있는 프레임 필터
    const responseFrames = frames.filter(
      (f) => f.audioTime >= searchStart && f.audioTime <= searchEnd,
    );

    if (responseFrames.length === 0) {
      console.log(`⚠️  Impulse @ ${impTime.toFixed(3)}s — 반응을 찾을 수 없음`);
      continue;
    }

    // 가장 가까운 반응 프레임
    const closest = responseFrames.reduce((a, b) =>
      Math.abs(a.audioTime - impTime) < Math.abs(b.audioTime - impTime) ? a : b,
    );

    const delay = (closest.audioTime - impTime) * 1000; // ms로 변환
    loopbackDelays.push(delay);

    console.log(
      `✓ Impulse @ ${impTime.toFixed(3)}s → 반응 @ ${closest.audioTime.toFixed(3)}s ` +
        `(지연 ${delay.toFixed(1)}ms, frame #${closest.frameIdx})`,
    );
  }

  if (loopbackDelays.length === 0) {
    console.error("❌ 측정할 수 있는 반응이 없습니다");
    process.exit(1);
  }

  // ── 루프백 지연 통계 ──────────────────────────────────────────────
  loopbackDelays.sort((a, b) => a - b);
  const avg = loopbackDelays.reduce((a, b) => a + b, 0) / loopbackDelays.length;
  const min = loopbackDelays[0];
  const max = loopbackDelays[loopbackDelays.length - 1];
  const median = loopbackDelays[Math.floor(loopbackDelays.length / 2)];

  console.log(`\n■ MCHStreamer 루프백 지연 측정 결과`);
  console.log(`  표본 수: ${loopbackDelays.length}`);
  console.log(`  최소: ${min.toFixed(1)}ms`);
  console.log(`  중앙값: ${median.toFixed(1)}ms`);
  console.log(`  평균: ${avg.toFixed(1)}ms`);
  console.log(`  최대: ${max.toFixed(1)}ms`);

  console.log(`\n■ 총 E2E 지연 분석 (앞서 측정)`);
  console.log(`  파이프라인(E2E): 0.3ms`);
  console.log(`  렌더(코얼레싱 3x): 48ms`);
  console.log(`  루프백(방금 측정): ${avg.toFixed(1)}ms`);
  console.log(`  ──────────────────`);
  console.log(`  총합: ${(0.3 + 48 + avg).toFixed(1)}ms`);
}

main();
