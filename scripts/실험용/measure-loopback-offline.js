#!/usr/bin/env node

// scripts/실험용/measure-loopback-offline.js
//
// 오프라인 H/W 루프백(왕복) 지연 측정 — 이미 갖고 있는 두 WAV 파일만으로 계산한다:
//   1) --ref     재생한 원본 임펄스 음원 WAV
//   2) --capture 앱에서 내려받은 V/I capture WAV (ch0=V, ch1=I)
// ref에서 임펄스 위치를 찾고, 그 주변 파형을 템플릿 삼아 capture 채널과 매치드 필터(교차상관)로
// 대조해 가장 상관이 높은 지점을 찾는다 — Adobe Audition에서 두 파형을 눈으로 맞춰보고 시간차를
// 재는 것과 원리는 같고, 샘플 단위로 기계적으로/재현 가능하게 해준다.
//
// 전제: 재생과 캡처가 같은 클럭을 공유한다(Electron play-capture 단일 IOProc 경로 — 재생 프레임 0
// = 캡처 프레임 0). 별도 스트림(getUserMedia 등 클럭 불일치)으로 받은 캡처에는 안 맞는다.
//
// 사용법:
//   npm run loopback:measure -- --ref impulse.wav --capture vi-capture.wav
//   npm run loopback:measure -- --ref impulse.wav --capture vi-capture.wav \
//     --channel 0,1 --threshold 0.5 --template-ms 3 --search-from -20 --search-to 300
"use strict";

const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------- WAV 파싱 (RIFF 청크 순회, PCM16/24/32 + float32 지원) ----------
function parseWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    fail(`${filePath} — RIFF/WAVE 형식이 아닙니다.`);
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, buf.length - body); // 헤더 크기가 잘못 적힌 파일 방어
    }
    offset = body + size + (size % 2); // 청크는 짝수 바이트 정렬
  }
  if (!fmt || dataOffset < 0) fail(`${filePath} — fmt/data 청크를 찾을 수 없습니다.`);

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * channels));
  const planar = Array.from({ length: channels }, () => new Float32Array(frameCount));

  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const o = dataOffset + (i * channels + ch) * bytesPerSample;
      let v;
      if (audioFormat === 3 && bitsPerSample === 32) {
        v = buf.readFloatLE(o);
      } else if (bitsPerSample === 16) {
        v = buf.readInt16LE(o) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = buf[o], b1 = buf[o + 1], b2 = buf[o + 2];
        let s = b0 | (b1 << 8) | (b2 << 16);
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608;
      } else if (bitsPerSample === 32 && audioFormat === 1) {
        v = buf.readInt32LE(o) / 2147483648;
      } else {
        fail(`${filePath} — 지원하지 않는 포맷(bits=${bitsPerSample}, format=${audioFormat})`);
      }
      planar[ch][i] = v;
    }
  }
  return { sampleRate, channels, frameCount, planar };
}

// ---------- 임펄스 위치 검출 (ref 채널에서) ----------
// |x[i]| >= threshold * peakAbs 인 지점들을 찾아, minGapSamples 이내로 붙어있는 검출을
// 하나의 이벤트로 묶고(그 구간의 최댓값 위치를 대표로) 이벤트 중심 목록을 돌려준다.
function detectImpulses(x, threshold, minGapSamples) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak === 0) return [];
  const th = peak * threshold;

  const events = [];
  let i = 0;
  while (i < x.length) {
    if (Math.abs(x[i]) >= th) {
      let clusterEnd = i;
      let bestIdx = i;
      let bestAmp = Math.abs(x[i]);
      let j = i + 1;
      while (j < x.length && j - clusterEnd <= minGapSamples) {
        if (Math.abs(x[j]) >= th) {
          clusterEnd = j;
          if (Math.abs(x[j]) > bestAmp) { bestAmp = Math.abs(x[j]); bestIdx = j; }
        }
        j++;
      }
      events.push(bestIdx);
      i = clusterEnd + minGapSamples + 1;
    } else {
      i++;
    }
  }
  return events;
}

// ---------- 매치드 필터: x 안에서 template의 시작 위치를 [lo,hi] 범위에서 스윕해 최적 위치 탐색 ----------
function matchedFilterSearch(x, template, lo, hi) {
  let templateEnergy = 0;
  for (let k = 0; k < template.length; k++) templateEnergy += template[k] * template[k];
  templateEnergy = templateEnergy || 1;

  const from = Math.max(0, lo);
  const to = Math.min(x.length - template.length, hi);
  if (to < from) return null;

  let bestLag = from;
  let bestAmp = -1;
  const amps = [];
  for (let lag = from; lag <= to; lag++) {
    let acc = 0;
    for (let k = 0; k < template.length; k++) acc += x[lag + k] * template[k];
    const amp = Math.abs(acc) / templateEnergy;
    amps.push(amp);
    if (amp > bestAmp) { bestAmp = amp; bestLag = lag; }
  }
  const sorted = [...amps].sort((a, b) => a - b);
  const noise = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const snr = bestAmp / (noise + 1e-9);
  return { lag: bestLag, amp: bestAmp, snr };
}

function summarize(values) {
  if (values.length === 0) return { median: null, mean: null, sd: null, min: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { median: s[Math.floor(s.length / 2)], mean, sd, min: s[0], max: s[s.length - 1] };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const a = {
    // --ref를 안 주면 LOOPBACK_REF_WAV 환경변수를 기본값으로 쓴다 — 매번 같은 임펄스 원본
    // 파일을 쓸 때 절대경로를 반복 입력하지 않기 위함(경로가 사람마다 다르므로 스크립트에
    // 하드코딩하지 않고 셸 프로필(~/.zshrc 등)에서 한 번만 export해두는 방식).
    ref: process.env.LOOPBACK_REF_WAV || null,
    capture: null,
    refChannel: 0,
    channels: [0], // capture 채널들(기본 ch0=V만) — "--channel 0,1"로 V/I 둘 다
    threshold: 0.5,
    templateMs: 3,   // ref 임펄스 주변에서 템플릿으로 뜯어낼 반경(ms)
    minGapMs: 20,    // 같은 임펄스 반복 구간 최소 간격(ms) — 이보다 가까운 검출은 한 이벤트로 병합
    searchFromMs: -20, // capture에서 검색할 범위(ref 위치 기준 상대, ms) — 왕복 지연이 음수일 리는
    searchToMs: 300,   // 없지만 정렬 오차를 대비해 약간의 음수 여유를 둔다
    snrHit: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--ref") a.ref = next();
    else if (k === "--capture") a.capture = next();
    else if (k === "--ref-channel") a.refChannel = Number(next());
    else if (k === "--channel") a.channels = next().split(",").map(Number);
    else if (k === "--threshold") a.threshold = Number(next());
    else if (k === "--template-ms") a.templateMs = Number(next());
    else if (k === "--min-gap-ms") a.minGapMs = Number(next());
    else if (k === "--search-from") a.searchFromMs = Number(next());
    else if (k === "--search-to") a.searchToMs = Number(next());
    else if (k === "--snr-hit") a.snrHit = Number(next());
    else fail(`알 수 없는 옵션: ${k}`);
  }
  if (!a.ref || !a.capture) {
    fail(
      "사용법: npm run loopback:measure -- --ref <원본임펄스.wav> --capture <VI캡처.wav>\n" +
      "  [--ref-channel 0] [--channel 0,1] [--threshold 0.5] [--template-ms 3]\n" +
      "  [--min-gap-ms 20] [--search-from -20] [--search-to 300] [--snr-hit 4]\n\n" +
      "--ref는 LOOPBACK_REF_WAV 환경변수로 고정할 수 있다(매번 같은 원본 음원을 쓸 때):\n" +
      '  export LOOPBACK_REF_WAV="/path/to/impulse.wav"   # ~/.zshrc 등에 한 번만 추가\n' +
      "  npm run loopback:measure -- --capture <VI캡처.wav>   # --ref 생략 가능"
    );
  }
  return a;
}

const CHANNEL_LABEL = { 0: "V(ch0)", 1: "I(ch1)" };

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (!argv.includes("--ref")) {
    console.log(`(--ref 생략 — LOOPBACK_REF_WAV 환경변수 값을 사용: ${args.ref})`);
  }
  const ref = parseWav(path.resolve(process.cwd(), args.ref));
  const cap = parseWav(path.resolve(process.cwd(), args.capture));

  if (args.refChannel >= ref.channels) fail(`--ref-channel ${args.refChannel} — ref 파일은 ${ref.channels}채널뿐입니다.`);
  for (const ch of args.channels) {
    if (ch >= cap.channels) fail(`--channel ${ch} — capture 파일은 ${cap.channels}채널뿐입니다.`);
  }

  console.log(`ref:     ${args.ref}  (${ref.sampleRate}Hz, ${ref.channels}ch, ${ref.frameCount} samples)`);
  console.log(`capture: ${args.capture}  (${cap.sampleRate}Hz, ${cap.channels}ch, ${cap.frameCount} samples)`);
  if (ref.sampleRate !== cap.sampleRate) {
    console.warn(
      `⚠️  샘플레이트 불일치: ref=${ref.sampleRate}Hz, capture=${cap.sampleRate}Hz — ` +
      "리샘플링은 하지 않고 ref 위치를 시간(ms) 환산 후 capture 샘플레이트로 다시 매핑만 한다. " +
      "가능하면 같은 세션·같은 SR로 다시 받는 걸 권장."
    );
  }

  const refCh = ref.planar[args.refChannel];
  const minGapSamples = Math.round((args.minGapMs / 1000) * ref.sampleRate);
  const templateHalf = Math.max(1, Math.round((args.templateMs / 1000) * ref.sampleRate));
  const impulsePositions = detectImpulses(refCh, args.threshold, minGapSamples);

  if (impulsePositions.length === 0) {
    fail(`ref 신호에서 임계값(${args.threshold} × 피크)을 넘는 임펄스를 찾지 못했습니다 — --threshold를 낮춰보세요.`);
  }
  console.log(`\nref에서 임펄스 ${impulsePositions.length}개 검출 (샘플 위치: ${impulsePositions.join(", ")})`);

  const searchFromSamples = Math.round((args.searchFromMs / 1000) * cap.sampleRate);
  const searchToSamples = Math.round((args.searchToMs / 1000) * cap.sampleRate);

  for (const ch of args.channels) {
    const capCh = cap.planar[ch];
    const label = CHANNEL_LABEL[ch] ?? `ch${ch}`;
    console.log(`\n=== capture ${label} ===`);

    const rows = {};
    const hitMs = [];
    impulsePositions.forEach((p, idx) => {
      const templateStart = Math.max(0, p - templateHalf);
      const templateEnd = Math.min(refCh.length, p + templateHalf);
      const template = refCh.subarray(templateStart, templateEnd);
      const templatePeakOffset = p - templateStart; // 템플릿 배열 안에서 임펄스 중심의 상대 위치

      // t=0(재생 시작=캡처 시작)이 정확히 맞았다고 가정했을 때 이 임펄스가 capture에 나타날
      // 위치(샘플레이트 다르면 ms로 환산 후 capture SR로 재매핑) — 실제 왕복 지연만큼 이 지점보다
      // 뒤에서 검출될 것으로 기대한다.
      const expectedPeakInCapture = Math.round((p / ref.sampleRate) * cap.sampleRate);
      const lo = expectedPeakInCapture - templatePeakOffset + searchFromSamples;
      const hi = expectedPeakInCapture - templatePeakOffset + searchToSamples;

      const result = matchedFilterSearch(capCh, template, lo, hi);
      const label2 = `#${idx + 1} @${(p / ref.sampleRate * 1000).toFixed(1)}ms`;
      if (!result) {
        rows[label2] = { "지연(ms)": "-", SNR: "-", 유효: "검색창 범위 오류" };
        return;
      }
      const actualPeakInCapture = result.lag + templatePeakOffset;
      const delaySamples = actualPeakInCapture - expectedPeakInCapture;
      const delayMs = (delaySamples / cap.sampleRate) * 1000;
      const hit = result.snr >= args.snrHit;
      if (hit) hitMs.push(delayMs);

      rows[label2] = {
        "지연(ms)": Number(delayMs.toFixed(3)),
        SNR: Number(result.snr.toFixed(1)),
        유효: hit ? "✓" : "✗(노이즈 의심)",
      };
    });
    console.table(rows);

    const st = summarize(hitMs);
    if (hitMs.length > 0) {
      console.log(
        `유효 ${hitMs.length}/${impulsePositions.length}건 — median ${st.median.toFixed(3)}ms, ` +
        `mean ${st.mean.toFixed(3)}ms, sd ${st.sd.toFixed(3)}ms, range [${st.min.toFixed(3)}, ${st.max.toFixed(3)}]ms`
      );
    } else {
      console.log(
        "유효 판정된 임펄스가 없습니다 — --threshold/--snr-hit를 조정하거나 검색창" +
        "(--search-from/--search-to)을 넓혀보세요."
      );
    }
  }
}

main();
