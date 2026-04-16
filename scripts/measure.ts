/**
 * measure.ts — Puppeteer 기반 자동 측정 스크립트
 *
 * exp/music/ 디렉토리의 음원 파일 3개를 각각 60초씩 측정한다.
 *
 * 사용법:
 *   npx tsx scripts/measure.ts [options]
 *
 * 옵션:
 *   --label <name>       측정 라벨 (기본: "baseline")
 *   --duration <sec>     음원당 측정 시간 초 (기본: 60)
 *   --url <url>          서버 URL (기본: http://localhost:3000)
 *   --headless           헤드리스 모드 (기본: true)
 *   --no-headless        브라우저 표시
 *   --speaker <model>    스피커 모델 (기본: "Z3 SPK")
 *   --power <watt>       AMP 출력 (기본: "20")
 *
 * 출력:
 *   measurements/<label>_<trackName>_<timestamp>.json
 *
 * 주의: 서버가 미리 실행 중이어야 합니다 (npm run dev)
 */

import puppeteer from "puppeteer";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { resolve, basename, extname } from "path";

// ── 음원 파일 목록 ─────────────────────────────────────────────────────────
const MUSIC_DIR = resolve(__dirname, "..", "..", "exp", "music");
const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".ogg", ".aac"]);

function getAudioFiles(): { path: string; name: string }[] {
  if (!existsSync(MUSIC_DIR)) {
    throw new Error(`음원 디렉토리를 찾을 수 없습니다: ${MUSIC_DIR}`);
  }
  const files = readdirSync(MUSIC_DIR)
    .filter(f => AUDIO_EXTS.has(extname(f).toLowerCase()))
    .sort()
    .map(f => ({
      path: resolve(MUSIC_DIR, f),
      // 파일명에서 안전한 라벨 추출 (특수문자 제거)
      name: basename(f, extname(f))
        .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 30),
    }));

  if (files.length === 0) {
    throw new Error(`음원 파일이 없습니다: ${MUSIC_DIR}`);
  }
  return files;
}

// ── CLI 인자 파싱 ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    label:    "baseline",
    duration: 60,
    url:      "http://localhost:3000",
    headless: true,
    speaker:  "Z3 SPK",
    power:    "20",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--label":       opts.label    = args[++i]; break;
      case "--duration":    opts.duration = parseInt(args[++i]); break;
      case "--url":         opts.url      = args[++i]; break;
      case "--headless":    opts.headless = true; break;
      case "--no-headless": opts.headless = false; break;
      case "--speaker":     opts.speaker  = args[++i]; break;
      case "--power":       opts.power    = args[++i]; break;
    }
  }
  return opts;
}

// ── 서버 응답 대기 ──────────────────────────────────────────────────────────
async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`서버가 ${timeoutMs}ms 내에 응답하지 않습니다: ${url}`);
}

// ── 단일 음원 측정 ──────────────────────────────────────────────────────────
async function runSingleTrack(
  opts: ReturnType<typeof parseArgs>,
  track: { path: string; name: string },
  trackIndex: number,
  totalTracks: number,
): Promise<string | null> {
  const outDir = resolve(__dirname, "..", "measurements");
  mkdirSync(outDir, { recursive: true });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[measure] Track ${trackIndex + 1}/${totalTracks}: ${track.name}`);
  console.log(`[measure] label: ${opts.label} | duration: ${opts.duration}s`);
  console.log(`[measure] speaker: ${opts.speaker} | power: ${opts.power}W`);
  console.log(`[measure] file: ${basename(track.path)}`);
  console.log(`${"=".repeat(60)}\n`);

  const browser = await puppeteer.launch({
    headless: opts.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const page = await browser.newPage();

  // 콘솔 로그 캡처
  page.on("console", (msg) => {
    if (msg.type() === "debug" || msg.type() === "log") {
      const text = msg.text();
      if (text.includes("[Pipeline]") || text.includes("[Latency]")) {
        console.log(`  [browser] ${text}`);
      }
    }
  });

  try {
    // 1. 페이지 로드
    console.log(`[measure] 페이지 로드 중...`);
    await page.goto(opts.url, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("#dashboard-root", { timeout: 10000 });
    console.log(`[measure] 페이지 로드 완료`);

    // 2. 입력 파라미터 설정
    console.log(`[measure] 입력 파라미터 설정`);
    const powerInput = await page.$('input[placeholder*="AMP"], input[type="number"]');
    if (powerInput) {
      await powerInput.click({ clickCount: 3 });
      await powerInput.type(opts.power);
    }
    const speakerSelect = await page.$("select");
    if (speakerSelect) {
      await speakerSelect.select(opts.speaker);
    }

    // 3. 파일 업로드
    console.log(`[measure] 오디오 파일 업로드: ${basename(track.path)}`);
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error("파일 업로드 input을 찾을 수 없습니다");
    await fileInput.uploadFile(track.path);

    // WaveSurfer 로드 대기
    console.log(`[measure] WaveSurfer 로드 대기...`);
    await page.waitForSelector("#play-pause-btn:not([disabled])", { timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000)); // PCM 디코딩 완료 대기
    console.log(`[measure] WaveSurfer 준비 완료`);

    // 4. Play 시작
    console.log(`[measure] 재생 시작`);
    const playBtn = await page.$("#play-pause-btn");
    if (!playBtn) throw new Error("Play 버튼을 찾을 수 없습니다");
    await playBtn.click();

    // WebSocket 연결 + 초기 안정화 대기
    await new Promise(r => setTimeout(r, 3000));

    // 5. REC 측정 시작
    console.log(`[measure] 측정 시작 (REC)`);
    // 대시보드 상단의 REC 버튼 (title="측정 모드")
    const recBtn = await page.$('button[title*="측정"]');
    if (recBtn) {
      await recBtn.click();
    } else {
      const allButtons = await page.$$("button");
      for (const btn of allButtons) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text?.includes("REC")) {
          await btn.click();
          break;
        }
      }
    }
    await new Promise(r => setTimeout(r, 500));
    console.log(`[measure] 측정 중... ${opts.duration}초 대기`);

    // 6. 지정 시간 대기
    for (let elapsed = 0; elapsed < opts.duration; elapsed++) {
      await new Promise(r => setTimeout(r, 1000));
      if ((elapsed + 1) % 10 === 0 || elapsed + 1 === opts.duration) {
        const frameCount = await page.evaluate(() => {
          const el = document.querySelector('button[title*="측정"]');
          return el?.textContent ?? "?";
        });
        console.log(`  [${elapsed + 1}/${opts.duration}s] ${frameCount}`);
      }
    }

    // 7. 측정 중지 → 데이터 캡처
    console.log(`[measure] 측정 중지`);
    const measurementData = await page.evaluate(() => {
      return new Promise<string>((resolve) => {
        let captured = "";
        const origCreateObjectURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob: Blob) => {
          const url = origCreateObjectURL(blob);
          const reader = new FileReader();
          reader.onload = () => {
            captured = reader.result as string;
            resolve(captured);
          };
          reader.readAsText(blob);
          return url;
        };

        // STOP 버튼 클릭 (■ 포함된 버튼)
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = btn.textContent ?? "";
          if (text.includes("■") && (text.includes("fr") || text.includes("STOP"))) {
            btn.click();
            break;
          }
        }

        setTimeout(() => { if (!captured) resolve(""); }, 5000);
      });
    });

    if (!measurementData) {
      console.error(`[measure] 측정 데이터 캡처 실패: ${track.name}`);
      return null;
    }

    // 8. 결과 저장
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outFile   = resolve(outDir, `${opts.label}_${track.name}_${timestamp}.json`);

    const data = JSON.parse(measurementData);
    data.meta.label        = opts.label;
    data.meta.trackName    = track.name;
    data.meta.trackFile    = basename(track.path);
    data.meta.speakerModel = opts.speaker;
    data.meta.ampPower     = opts.power;

    writeFileSync(outFile, JSON.stringify(data, null, 2));
    console.log(`[measure] 결과 저장: ${outFile}`);

    printSummary(data);
    return outFile;

  } finally {
    await browser.close();
  }
}

// ── 결과 요약 출력 ──────────────────────────────────────────────────────────
function printSummary(data: Record<string, unknown>) {
  const s    = data.summary as Record<string, Record<string, number | null>>;
  const meta = data.meta as Record<string, unknown>;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Summary: ${meta.label} / ${meta.trackName}`);
  console.log(`  Frames: ${meta.frameCount} | Duration: ${meta.measurementDurationSec}s`);
  console.log(`${"─".repeat(60)}`);

  const fmt = (v: number | null) => v === null ? "     —" : v.toFixed(2).padStart(7);

  for (const [name, stats] of Object.entries(s)) {
    if (!stats || typeof stats !== "object") continue;
    if ("p50" in stats) {
      console.log(
        `  ${name.padEnd(15)} avg:${fmt(stats.avg)} | p50:${fmt(stats.p50)} | p95:${fmt(stats.p95)} | p99:${fmt(stats.p99)} | max:${fmt(stats.max)}`
      );
    } else if ("avg" in stats && "min" in stats) {
      console.log(
        `  ${name.padEnd(15)} avg:${fmt(stats.avg)} | min:${fmt(stats.min)} | max:${fmt(stats.max)}`
      );
    } else if ("avg" in stats) {
      console.log(`  ${name.padEnd(15)} avg:${fmt(stats.avg)}`);
    }
  }

  const summary = data.summary as Record<string, unknown>;
  if (typeof summary.maxStreamingFramesLen === "number") {
    console.log(`  ${"bufferMax".padEnd(15)} ${summary.maxStreamingFramesLen} frames`);
  }

  console.log(`${"─".repeat(60)}\n`);
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  const opts   = parseArgs();
  const tracks = getAudioFiles();

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  Automated Measurement: ${opts.label}`);
  console.log(`  Tracks: ${tracks.length} | Duration: ${opts.duration}s each`);
  tracks.forEach((t, i) => console.log(`    ${i + 1}. ${basename(t.path)}`));
  console.log(`${"█".repeat(60)}\n`);

  // 서버 대기
  console.log(`[measure] 서버 대기 중: ${opts.url}`);
  await waitForServer(opts.url);
  console.log(`[measure] 서버 응답 확인\n`);

  const results: string[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const outFile = await runSingleTrack(opts, tracks[i], i, tracks.length);
    if (outFile) results.push(outFile);

    // 트랙 간 쿨다운
    if (i < tracks.length - 1) {
      console.log(`[measure] 다음 트랙까지 5초 대기...\n`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 최종 요약
  console.log(`\n${"█".repeat(60)}`);
  console.log(`  측정 완료: ${results.length}/${tracks.length} 트랙`);
  results.forEach((f, i) => console.log(`    ${i + 1}. ${basename(f)}`));
  console.log(`\n  비교 명령: npm run compare`);
  console.log(`${"█".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("[measure] 오류:", err);
  process.exit(1);
});
