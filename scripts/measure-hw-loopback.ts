/**
 * measure-hw-loopback.ts — CoreAudio 하드웨어 왕복(round-trip) 지연 스윕 측정
 *
 * 단일 임펄스([1, 0, 0, …])를 `duplex` 헬퍼의 --ref로 넘겨, 입출력 겸용 단일 장치
 * (예: MCHStreamer)에서 하나의 IOProc으로 방출·수신을 동시에 처리한다. 단일 IOProc =
 * 단일 클럭이므로:
 *
 *     왕복 지연(프레임) = (입력에서 임펄스가 검출된 절대 프레임) − (임펄스를 방출한 프레임)
 *
 * 이 값은 출력 프레젠테이션 + DAC + (전기적 루프백 배선) + ADC + 입력 캡처 지연의 합이며,
 * BufferFrameSize에 따라 스케일한다. test-output/처럼 재생·캡처를 별도 스트림으로 열면
 * 클럭이 달라 이 등식이 깨지므로(시작 오프셋이 지연을 삼킴), 반드시 duplex 단일 장치여야 한다.
 *
 * ── 배선 (중요) ──────────────────────────────────────────────────────────────
 *   장치 출력 ch0  →  (라인 레벨 전기적 루프백)  →  장치 입력 ch0
 *   "CoreAudio를 통한 하드웨어 왕복비용만" 재려면 앰프/스피커/마이크를 거치지 말고
 *   out0 → in0 를 직결한다. (앰프·음향 경로까지 포함하려면 그 경로로 배선.)
 *
 * ── 사용 ────────────────────────────────────────────────────────────────────
 *   # 먼저 장치 UID 확인
 *   electron/native/audio-device-helper/dist/audio-device-helper list
 *
 *   npx tsx scripts/measure-hw-loopback.ts --device <UID>
 *   npx tsx scripts/measure-hw-loopback.ts --device <UID> \
 *     --buffers 16,32,64,128,256,480,512,2048 --sr 48000 --channels 2 --bursts 12
 *
 *   --device 생략 시 OS 기본 입력장치를 노리지만, duplex는 입력+출력을 모두 가진 단일
 *   장치여야 하므로 대개 --device <MCHStreamer UID>가 필요하다.
 */

import { spawnSync, spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

const HELPER = resolve(
  process.cwd(),
  "electron/native/audio-device-helper/dist/audio-device-helper",
);

interface Args {
  device: string | null;
  buffers: number[];
  sr: number;
  channels: number;
  bursts: number;
  impulseLen: number;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    device: null,
    // MCHStreamer BufferFrameSize 범위는 5~1500 (query로 확인). 범위 밖 값은 헬퍼가 클램프하며
    // actual.bufferSize로 실제 적용값을 보고한다 — test-output의 2048은 실은 1500으로 클램프됐었다.
    buffers: [16, 32, 64, 128, 256, 480, 512, 1024, 2048],
    sr: 48000,
    channels: 2,
    bursts: 12,
    impulseLen: 1,
    label: "hwlat",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--device") a.device = argv[++i];
    else if (k === "--buffers") a.buffers = argv[++i].split(",").map((s) => parseInt(s, 10));
    else if (k === "--sr") a.sr = parseInt(argv[++i], 10);
    else if (k === "--channels") a.channels = parseInt(argv[++i], 10);
    else if (k === "--bursts") a.bursts = parseInt(argv[++i], 10);
    else if (k === "--impulse-len") a.impulseLen = Math.max(1, parseInt(argv[++i], 10));
    else if (k === "--label") a.label = argv[++i];
  }
  return a;
}

interface DuplexHeader {
  success: boolean;
  error?: string;
  actual: { sampleRate: number; bufferSize: number | null };
  refLen: number;
  emitFrames: number[];
  maxDelayFrames: number;
  totalFrames: number;
  analysisChannel: number;
  channels: number;
}

/** 헬퍼 duplex 1회 실행 → 헤더 + 입력 PCM(Int16 인터리브) 수집 */
function runDuplex(
  args: Args,
  bufferSize: number,
  refPath: string,
): Promise<{ header: DuplexHeader; pcm: Buffer }> {
  const cli = [
    ...(args.device ? ["--device", args.device] : []),
    "duplex",
    "--ref", refPath,
    String(args.sr),
    String(bufferSize),
    String(args.channels),
    String(args.bursts),
  ];
  return new Promise((res, rej) => {
    const child = spawn(HELPER, cli);
    const chunks: Buffer[] = [];
    let headerBuf = Buffer.alloc(0);
    let header: DuplexHeader | null = null;
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (header) {
        chunks.push(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const nl = headerBuf.indexOf(0x0a); // 첫 개행 = 헤더 종료(헤더는 PCM보다 먼저 완전히 기록됨)
      if (nl >= 0) {
        try {
          header = JSON.parse(headerBuf.subarray(0, nl).toString("utf8"));
        } catch (e) {
          rej(new Error(`헤더 파싱 실패: ${(e as Error).message}`));
          child.kill();
          return;
        }
        if (!header!.success) {
          rej(new Error(`헬퍼 오류: ${header!.error}`));
          child.kill();
          return;
        }
        const rest = headerBuf.subarray(nl + 1);
        if (rest.length) chunks.push(rest);
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (code) => {
      if (!header) return rej(new Error(`헤더 없음 (exit ${code}) ${stderr}`));
      res({ header, pcm: Buffer.concat(chunks) });
    });
    // stdin 열어둠(헬퍼는 부모 EOF를 종료 신호로 봄) — 측정은 totalFrames로 자체 종료
  });
}

/** Int16 인터리브 PCM에서 특정 채널만 Float 평면으로 */
function extractChannel(pcm: Buffer, channels: number, ch: number): Float64Array {
  const n = Math.floor(pcm.length / 2 / channels);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = pcm.readInt16LE((i * channels + ch) * 2) / 32768;
  }
  return out;
}

/** 방출 프레임 e 이후 [e, e+maxDelay] 창에서 |x| 피크 위치 → 왕복 프레임 */
function measureBurst(
  x: Float64Array,
  emit: number,
  maxDelay: number,
): { delayFrames: number; peak: number } | null {
  const end = Math.min(x.length, emit + maxDelay);
  let bestIdx = -1;
  let bestAmp = 0;
  for (let i = emit; i < end; i++) {
    const a = Math.abs(x[i]);
    if (a > bestAmp) {
      bestAmp = a;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return { delayFrames: bestIdx - emit, peak: bestAmp };
}

function stats(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(HELPER)) {
    throw new Error(`헬퍼 바이너리 없음: ${HELPER}\n먼저 빌드: (cd electron/native/audio-device-helper && ./build-mac.sh)`);
  }
  if (process.platform !== "darwin") throw new Error("macOS 전용 (CoreAudio)");

  // 참조 임펄스: [1, 0, …] (impulse-len개 1.0 이후 0). raw little-endian Float32 mono.
  const ref = new Float32Array(args.impulseLen);
  ref.fill(1.0);
  const refPath = resolve(tmpdir(), `iron-hwlat-impulse-${process.pid}.f32`);
  writeFileSync(refPath, Buffer.from(ref.buffer));

  console.log(`■ CoreAudio H/W 루프백 지연 스윕`);
  console.log(`  helper : ${HELPER}`);
  console.log(`  device : ${args.device ?? "(OS 기본 — duplex엔 대개 --device 필요)"}`);
  console.log(`  sr=${args.sr}  channels=${args.channels}  bursts=${args.bursts}  impulseLen=${args.impulseLen}`);
  console.log(`  buffers: ${args.buffers.join(", ")}`);
  console.log(`  ref    : ${refPath}\n`);

  const rows: Record<string, unknown>[] = [];
  const outDir = resolve(process.cwd(), "measurements");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  for (const buf of args.buffers) {
    try {
      const { header, pcm } = await runDuplex(args, buf, refPath);
      const fs = header.actual.sampleRate || args.sr;
      const x = extractChannel(pcm, header.channels, header.analysisChannel);
      const delays: number[] = [];
      const peaks: number[] = [];
      for (const e of header.emitFrames) {
        const r = measureBurst(x, e, header.maxDelayFrames);
        if (r && r.peak > 0.0005) {
          delays.push(r.delayFrames);
          peaks.push(r.peak);
        }
      }
      if (!delays.length) {
        console.log(`  buf=${String(buf).padStart(5)}  ⚠️  임펄스 검출 실패(피크 미약 — 배선/게인 확인)`);
        rows.push({ buffer: buf, actualBuf: header.actual.bufferSize, hits: 0 });
        continue;
      }
      const ms = delays.map((d) => (d / fs) * 1000);
      const st = stats(ms);
      const peakStat = stats(peaks);
      console.log(
        `  buf=${String(buf).padStart(5)} (actual ${String(header.actual.bufferSize).padStart(5)})  ` +
          `왕복 median=${st.median.toFixed(3)}ms  mean=${st.mean.toFixed(3)}±${st.sd.toFixed(3)}ms  ` +
          `[${st.min.toFixed(3)}~${st.max.toFixed(3)}]  hits=${delays.length}/${header.emitFrames.length}  ` +
          `peak≈${peakStat.median.toFixed(3)}`,
      );
      rows.push({
        buffer: buf,
        actualBuf: header.actual.bufferSize,
        median_ms: +st.median.toFixed(3),
        mean_ms: +st.mean.toFixed(3),
        sd_ms: +st.sd.toFixed(3),
        min_ms: +st.min.toFixed(3),
        max_ms: +st.max.toFixed(3),
        hits: delays.length,
        theo_buf_ms: +((buf / fs) * 1000).toFixed(3),
      });
    } catch (e) {
      console.log(`  buf=${String(buf).padStart(5)}  ❌ ${(e as Error).message}`);
      rows.push({ buffer: buf, error: (e as Error).message });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = resolve(outDir, `${args.label}_${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ args, rows }, null, 2));
  console.log(`\n■ 요약 (버퍼 vs 왕복 지연)`);
  console.table(rows);
  console.log(`저장: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
