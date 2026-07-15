/**
 * compare-wav-impulses.ts — 원본 WAV와 실험 결과 WAV를 비교
 *
 * 사용:
 *   npx tsx scripts/compare-wav-impulses.ts <original> <experiment>
 */

import { readFileSync } from "fs";

interface WAVData {
  path: string;
  numChannels: number;
  sampleRate: number;
  duration: number;
  samples: Int16Array;
}

function parseWAV(buffer: Buffer): WAVData | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);

  let fmtPos = 12;
  while (fmtPos < buffer.length) {
    const chunkId = buffer.toString("ascii", fmtPos, fmtPos + 4);
    const chunkSize = view.getUint32(fmtPos + 4, true);

    if (chunkId === "fmt ") {
      const numChannels = view.getUint16(fmtPos + 8, true);
      const sampleRate = view.getUint32(fmtPos + 12, true);

      let dataPos = fmtPos + 8 + chunkSize;
      while (dataPos < buffer.length) {
        const dataChunkId = buffer.toString("ascii", dataPos, dataPos + 4);
        const dataChunkSize = view.getUint32(dataPos + 4, true);

        if (dataChunkId === "data") {
          const dataStart = dataPos + 8;
          const samples = new Int16Array(
            buffer.buffer,
            buffer.byteOffset + dataStart,
            dataChunkSize / 2,
          );

          const duration = (samples.length / numChannels) / sampleRate;
          return { path: "", numChannels, sampleRate, duration, samples };
        }
        dataPos += 8 + dataChunkSize;
      }
    }
    fmtPos += 8 + chunkSize;
  }

  return null;
}

function findImpulses(
  samples: Int16Array,
  sampleRate: number,
  numChannels: number,
  windowSize: number = 480, // 10ms @ 48kHz
  threshold: number = 15000,
): Array<{ time: number; rms: number; index: number }> {
  const impulses: Array<{ time: number; rms: number; index: number }> = [];

  for (let i = 0; i < samples.length - windowSize * numChannels; i += windowSize * numChannels) {
    let sum = 0;
    for (let j = 0; j < windowSize * numChannels; j++) {
      sum += samples[i + j] * samples[i + j];
    }
    const rms = Math.sqrt(sum / (windowSize * numChannels));

    if (rms > threshold) {
      const time = (i / numChannels) / sampleRate;
      impulses.push({ time, rms: Math.round(rms), index: i / numChannels });
    }
  }

  // 중복 제거
  const deduped: Array<{ time: number; rms: number; index: number }> = [];
  let lastTime = -1;
  for (const imp of impulses) {
    if (imp.time - lastTime > 0.05) {
      deduped.push(imp);
      lastTime = imp.time;
    }
  }

  return deduped;
}

function main() {
  const origPath = process.argv[2];
  const expPath = process.argv[3];

  if (!origPath || !expPath) {
    console.error("사용: npx tsx scripts/compare-wav-impulses.ts <original> <experiment>");
    process.exit(1);
  }

  console.log("▶ 파일 로드 중...\n");

  const origBuffer = readFileSync(origPath);
  const expBuffer = readFileSync(expPath);

  const orig = parseWAV(origBuffer);
  const exp = parseWAV(expBuffer);

  if (!orig || !exp) {
    console.error("❌ WAV 파일 파싱 실패");
    process.exit(1);
  }

  orig.path = origPath;
  exp.path = expPath;

  console.log("■ 파일 정보");
  console.log(`Original: ${origPath.split("/").pop()}`);
  console.log(`  Duration: ${orig.duration.toFixed(2)}s, SR: ${orig.sampleRate}Hz`);
  console.log(`Experiment: ${expPath.split("/").pop()}`);
  console.log(`  Duration: ${exp.duration.toFixed(2)}s, SR: ${exp.sampleRate}Hz\n`);

  console.log("▶ Impulse 탐지...\n");

  const origImpulses = findImpulses(orig.samples, orig.sampleRate, orig.numChannels);
  const expImpulses = findImpulses(exp.samples, exp.sampleRate, exp.numChannels);

  console.log(`Original: ${origImpulses.length}개 Impulse 발견`);
  origImpulses.slice(0, 15).forEach((imp) => {
    console.log(`  ${imp.time.toFixed(3)}s (RMS=${imp.rms})`);
  });

  console.log(`\nExperiment: ${expImpulses.length}개 Impulse 발견`);
  expImpulses.slice(0, 15).forEach((imp) => {
    console.log(`  ${imp.time.toFixed(3)}s (RMS=${imp.rms})`);
  });

  // ── 지연 계산 ────────────────────────────────────────────────────────
  console.log("\n■ 지연 분석\n");

  const delays: number[] = [];

  for (let i = 0; i < Math.min(origImpulses.length, expImpulses.length); i++) {
    const origTime = origImpulses[i].time;
    const expTime = expImpulses[i].time;
    const delay = (expTime - origTime) * 1000; // ms로 변환

    delays.push(delay);
    console.log(
      `Impulse #${i + 1}: Original @ ${origTime.toFixed(3)}s → Experiment @ ${expTime.toFixed(3)}s ` +
        `(지연: ${delay.toFixed(1)}ms)`,
    );
  }

  if (delays.length === 0) {
    console.error("❌ 비교 가능한 Impulse가 없습니다");
    process.exit(1);
  }

  // ── 통계 ────────────────────────────────────────────────────────────
  delays.sort((a, b) => a - b);
  const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
  const minDelay = delays[0];
  const maxDelay = delays[delays.length - 1];
  const medianDelay = delays[Math.floor(delays.length / 2)];

  console.log("\n■ 총 지연 측정 결과");
  console.log(`  표본 수: ${delays.length}`);
  console.log(`  최소: ${minDelay.toFixed(1)}ms`);
  console.log(`  중앙값: ${medianDelay.toFixed(1)}ms`);
  console.log(`  평균: ${avgDelay.toFixed(1)}ms`);
  console.log(`  최대: ${maxDelay.toFixed(1)}ms`);

  // ── Experiment 파일의 시작 부분 분석 ────────────────────────────────
  console.log("\n■ Experiment 파일 초기 구간 분석");
  const firstImpulseExpTime = expImpulses[0].time;
  const firstImpulseOrigTime = origImpulses[0].time;

  const initDelay = (firstImpulseExpTime - firstImpulseOrigTime) * 1000;
  console.log(
    `첫 Impulse: Original @ ${firstImpulseOrigTime.toFixed(3)}s → Experiment @ ${firstImpulseExpTime.toFixed(3)}s`,
  );
  console.log(`초기 지연: ${initDelay.toFixed(1)}ms`);

  if (firstImpulseExpTime > 0.05) {
    console.log(
      `\n⚠️ Experiment 파일이 ${firstImpulseExpTime.toFixed(3)}s부터 데이터를 가짐 ` +
        `→ 처음 ${(firstImpulseExpTime * 1000).toFixed(0)}ms는 음소거 또는 missing`,
    );
  }
}

main();
