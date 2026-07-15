/**
 * scan-wav-impulses.ts — WAV 파일 전체 스캔해서 모든 Impulse 위치 출력
 */

import { readFileSync } from "fs";

interface WAVHeader {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataSize: number;
}

function parseWAV(buffer: Buffer): { header: WAVHeader; samples: Int16Array } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);

  let fmtPos = 12;
  while (fmtPos < buffer.length) {
    const chunkId = buffer.toString("ascii", fmtPos, fmtPos + 4);
    const chunkSize = view.getUint32(fmtPos + 4, true);

    if (chunkId === "fmt ") {
      const numChannels = view.getUint16(fmtPos + 8, true);
      const sampleRate = view.getUint32(fmtPos + 12, true);
      const bitsPerSample = view.getUint16(fmtPos + 22, true);

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
            header: { numChannels, sampleRate, bitsPerSample, dataSize: dataChunkSize },
            samples,
          };
        }
        dataPos += 8 + dataChunkSize;
      }
    }
    fmtPos += 8 + chunkSize;
  }

  throw new Error("유효하지 않은 WAV");
}

function main() {
  const wavPath = process.argv[2];
  if (!wavPath) {
    console.error("사용: npx tsx scripts/scan-wav-impulses.ts <wav-path>");
    process.exit(1);
  }

  const buffer = readFileSync(wavPath);
  const { header, samples } = parseWAV(buffer);

  const duration = (samples.length / header.numChannels) / header.sampleRate;
  console.log(`\n■ 파일: ${wavPath.split("/").pop()}`);
  console.log(`  Duration: ${duration.toFixed(2)}s`);
  console.log(`  Sample Rate: ${header.sampleRate} Hz\n`);

  // 1ms 윈도우로 RMS 계산
  const windowSize = Math.floor(header.sampleRate / 1000);
  const energies: Array<{ time: number; rms: number }> = [];

  for (let i = 0; i < samples.length - windowSize * header.numChannels; i += windowSize * header.numChannels) {
    let sum = 0;
    for (let j = 0; j < windowSize * header.numChannels; j++) {
      sum += samples[i + j] ** 2;
    }
    const rms = Math.sqrt(sum / (windowSize * header.numChannels));
    const time = (i / header.numChannels) / header.sampleRate;
    energies.push({ time, rms });
  }

  // 에너지가 높은 구간 찾기
  const maxEnergy = Math.max(...energies.map((e) => e.rms));
  const threshold = maxEnergy * 0.1;

  console.log("▶ 에너지 높은 구간 (threshold=10% of max):");
  let inSpike = false;
  let spikeStart = 0;

  for (let i = 0; i < energies.length; i++) {
    const e = energies[i];
    if (e.rms > threshold && !inSpike) {
      spikeStart = e.time;
      inSpike = true;
    } else if (e.rms <= threshold && inSpike) {
      console.log(`  ${spikeStart.toFixed(3)}s ~ ${energies[i - 1].time.toFixed(3)}s`);
      inSpike = false;
    }
  }
  if (inSpike) {
    console.log(`  ${spikeStart.toFixed(3)}s ~ ${energies[energies.length - 1].time.toFixed(3)}s (끝)`);
  }

  console.log("\n▶ 상위 10개 에너지 피크:");
  const top10 = [...energies].sort((a, b) => b.rms - a.rms).slice(0, 10);
  top10.forEach((e) => {
    console.log(`  ${e.time.toFixed(3)}s: RMS=${Math.round(e.rms)}`);
  });
}

main();
