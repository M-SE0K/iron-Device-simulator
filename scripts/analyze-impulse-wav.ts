/**
 * analyze-impulse-wav.ts — WAV 파일에서 Impulse 위치 분석
 *
 * 사용:
 *   npx tsx scripts/analyze-impulse-wav.ts <wav-path>
 */

import { readFileSync } from "fs";

interface WAVHeader {
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataSize: number;
}

function parseWAV(buffer: Buffer): { header: WAVHeader; samples: Int16Array } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);

  // RIFF 헤더
  const riffId = buffer.toString("ascii", 0, 4); // "RIFF"
  const riffSize = view.getUint32(4, true);
  const riffFormat = buffer.toString("ascii", 8, 12); // "WAVE"

  if (riffId !== "RIFF" || riffFormat !== "WAVE") {
    throw new Error("유효한 WAV 파일이 아닙니다");
  }

  // fmt 청크 찾기
  let fmtPos = 12;
  while (fmtPos < buffer.length) {
    const chunkId = buffer.toString("ascii", fmtPos, fmtPos + 4);
    const chunkSize = view.getUint32(fmtPos + 4, true);

    if (chunkId === "fmt ") {
      const numChannels = view.getUint16(fmtPos + 8, true);
      const sampleRate = view.getUint32(fmtPos + 12, true);
      const byteRate = view.getUint32(fmtPos + 16, true);
      const blockAlign = view.getUint16(fmtPos + 20, true);
      const bitsPerSample = view.getUint16(fmtPos + 22, true);

      // data 청크 찾기
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

          return {
            header: {
              numChannels,
              sampleRate,
              byteRate,
              blockAlign,
              bitsPerSample,
              dataSize: dataChunkSize,
            },
            samples,
          };
        }

        dataPos += 8 + dataChunkSize;
      }

      throw new Error("data 청크를 찾을 수 없습니다");
    }

    fmtPos += 8 + chunkSize;
  }

  throw new Error("fmt 청크를 찾을 수 없습니다");
}

function findImpulses(
  samples: Int16Array,
  sampleRate: number,
  numChannels: number,
  threshold: number = 20000, // RMS threshold
): Array<{ frameIdx: number; time: number; rms: number }> {
  const impulses: Array<{ frameIdx: number; time: number; rms: number }> = [];
  const windowSize = Math.floor(sampleRate / 100); // 10ms 윈도우

  for (let i = 0; i < samples.length - windowSize * numChannels; i += windowSize * numChannels) {
    let sum = 0;
    for (let j = 0; j < windowSize * numChannels; j++) {
      sum += samples[i + j] * samples[i + j];
    }
    const rms = Math.sqrt(sum / (windowSize * numChannels));

    if (rms > threshold) {
      impulses.push({
        frameIdx: Math.floor(i / numChannels),
        time: (i / numChannels) / sampleRate,
        rms: Math.round(rms),
      });
    }
  }

  // 중복 제거 (같은 임펄스의 연속 감지)
  const deduped: Array<{ frameIdx: number; time: number; rms: number }> = [];
  let lastTime = -1;
  for (const imp of impulses) {
    if (imp.time - lastTime > 0.1) {
      // 0.1초 이상 떨어짐
      deduped.push(imp);
      lastTime = imp.time;
    }
  }

  return deduped;
}

function main() {
  const wavPath = process.argv[2];
  if (!wavPath) {
    console.error("사용: npx tsx scripts/analyze-impulse-wav.ts <wav-path>");
    process.exit(1);
  }

  console.log(`▶ 분석 중: ${wavPath}`);
  const buffer = readFileSync(wavPath);
  const { header, samples } = parseWAV(buffer);

  console.log(`\n■ WAV 정보`);
  console.log(`  Channels: ${header.numChannels}`);
  console.log(`  Sample Rate: ${header.sampleRate} Hz`);
  console.log(`  Bits per Sample: ${header.bitsPerSample}`);
  console.log(`  Duration: ${(samples.length / header.numChannels / header.sampleRate).toFixed(2)}s`);

  console.log(`\n▶ Impulse 탐지 (threshold=20000 RMS)...`);
  const impulses = findImpulses(samples, header.sampleRate, header.numChannels, 20000);

  if (impulses.length === 0) {
    console.log("Impulse를 찾을 수 없습니다. 임계값을 낮춰 봅시다.");
    const lowThresholdImpulses = findImpulses(samples, header.sampleRate, header.numChannels, 5000);
    console.log(`\n(낮은 임계값 5000으로) 감지된 에너지 스파이크:`);
    lowThresholdImpulses.slice(0, 20).forEach((imp) => {
      console.log(`  ${imp.time.toFixed(3)}s — RMS ${imp.rms}`);
    });
  } else {
    console.log(`\n감지된 ${impulses.length}개 Impulse:`);
    impulses.forEach((imp) => {
      console.log(`  Frame #${imp.frameIdx} @ ${imp.time.toFixed(3)}s — RMS ${imp.rms}`);
    });
  }

  // ── 채널별 분석 ──────────────────────────────────────────────────
  if (header.numChannels > 1) {
    console.log(`\n▶ 채널별 첫 5초 RMS:`);
    const windowSize = Math.floor(header.sampleRate / 10); // 100ms 윈도우

    for (let ch = 0; ch < Math.min(header.numChannels, 2); ch++) {
      const peaks: number[] = [];
      for (let i = ch; i < Math.min(windowSize * 50 * header.numChannels, samples.length); i += windowSize * header.numChannels) {
        let sum = 0;
        for (let j = 0; j < windowSize && i + j * header.numChannels < samples.length; j++) {
          sum += samples[i + j * header.numChannels] ** 2;
        }
        const rms = Math.sqrt(sum / windowSize);
        peaks.push(Math.round(rms));
      }

      const chName = ch === 0 ? "L" : ch === 1 ? "R" : `ch${ch}`;
      const avgRms = Math.round(peaks.reduce((a, b) => a + b) / peaks.length);
      const maxRms = Math.max(...peaks);
      console.log(`  ${chName}: avg=${avgRms}, max=${maxRms}`);
    }
  }
}

main();
