/**
 * measure.ts — 5단계 지연 측정 하네스 자동화 러너
 *
 * 앱에 내장된 수집기(src/features/audio/lib/perf/, window.__ironPerf)가 세션 동안
 * 프레임 단위로 재는 다섯 구간을 Puppeteer로 자동 수집한다:
 *
 *   1. HW capture  — 캡처 콜백 도착 간격 (버퍼 채움 시간 근사)
 *   2. Encoding    — PCM → int32 와이어 프레임 패킹
 *   3. WASM        — ff_prot_start_exec (processingMs)
 *   4. Decoding    — frame 메시지 파싱 → AnalysisFrame 구성
 *   5. Render      — 프레임 커밋 → ECharts rendered (차트별)
 *
 * 두 가지 실행 방식:
 *   기본(launch)  — 가짜 마이크(fake device)를 단 헤드리스 Chromium을 띄워 웹 폴백
 *                   (getUserMedia+AudioWorklet) 경로를 측정한다. dev 서버가 먼저 떠
 *                   있어야 한다(npm run dev).
 *   --attach      — 이미 실행 중인 브라우저/Electron(원격 디버깅 포트 개방)에 붙어
 *                   네이티브 CoreAudio 경로를 실 하드웨어 기준으로 측정한다.
 *                   예) IRON_REMOTE_DEBUG_PORT=9222 npm run electron:preview 후
 *                       npx tsx scripts/measure.ts --attach http://127.0.0.1:9222 \
 *                         --url http://127.0.0.1:17872
 *
 * 옵션:
 *   --label <name>     출력 파일 라벨 (기본: "perf")
 *   --duration <sec>   측정 시간 초 (기본: 30)
 *   --url <url>        측정 페이지 URL (기본: http://localhost:3000)
 *   --attach <url>     CDP 엔드포인트 — 지정 시 launch 대신 connect
 *   --no-headless      launch 모드에서 브라우저 표시
 *
 * 출력: measurements/<label>_<mode>_<timestamp>.json (PerfExport 스키마,
 *       lib/perf/types.ts 참고) + 콘솔 요약 표
 *
 * 세션은 마이크 모드로 연다 — 파일 모드도 동일한 캡처 파이프라인(useCaptureSession)을
 * 쓰므로 다섯 구간의 측정 지점이 같다. 파일 재생을 낀 측정(출력 라우팅 포함)이 필요하면
 * 앱에서 직접 재생한 뒤 콘솔에서 window.__ironPerf.download()로 받는다.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

interface Args {
  label: string;
  duration: number;
  url: string;
  attach: string | null;
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { label: "perf", duration: 30, url: "http://localhost:3000", attach: null, headless: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") args.label = argv[++i];
    else if (a === "--duration") args.duration = Number(argv[++i]) || 30;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--attach") args.attach = argv[++i];
    else if (a === "--no-headless") args.headless = false;
    else if (a === "--headless") args.headless = true;
    else {
      console.error(`알 수 없는 옵션: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

/** 표시 텍스트가 정확히 일치하는 버튼을 찾아 클릭 (SegmentedControl 등 라벨 기반) */
async function clickButtonByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t) => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
    if (!btn) return false;
    (btn as HTMLButtonElement).click();
    return true;
  }, text);
}

async function clickButtonByAriaLabel(page: Page, label: string): Promise<boolean> {
  return page.evaluate((l) => {
    const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="${l}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(process.cwd(), "measurements");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  let browser: Browser;
  if (args.attach) {
    console.log(`▶ CDP attach: ${args.attach}`);
    browser = await puppeteer.connect({ browserURL: args.attach, defaultViewport: null });
  } else {
    console.log("▶ Chromium launch (fake microphone, 웹 폴백 경로)");
    browser = await puppeteer.launch({
      headless: args.headless,
      args: [
        "--use-fake-ui-for-media-capture",     // 마이크 권한 프롬프트 자동 허용
        "--use-fake-device-for-media-capture", // 가짜 오디오 입력 장치(톤 신호)
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  }

  try {
    // attach 모드에선 이미 열린 앱 페이지를 찾고, launch 모드에선 새로 연다.
    let page: Page;
    if (args.attach) {
      const pages = await browser.pages();
      const found = pages.find((p) => p.url().startsWith(args.url));
      if (!found) {
        throw new Error(`열려 있는 페이지 중 ${args.url} 로 시작하는 페이지를 찾지 못했습니다.`);
      }
      page = found;
    } else {
      // 헤드리스에선 fake-device 플래그만으로는 getUserMedia가 거부될 수 있어 권한을 명시 부여
      await browser.defaultBrowserContext().overridePermissions(new URL(args.url).origin, ["microphone"]);
      page = await browser.newPage();
      await page.goto(args.url, { waitUntil: "networkidle2", timeout: 60_000 });
    }

    // 수집기가 로드됐는지 확인
    await page.waitForFunction(() => typeof window.__ironPerf !== "undefined", { timeout: 30_000 });

    // 마이크 모드 전환 → 세션 시작
    if (!(await clickButtonByText(page, "마이크"))) {
      throw new Error('입력 소스 토글("마이크" 버튼)을 찾지 못했습니다.');
    }
    await sleep(300);
    if (!(await clickButtonByAriaLabel(page, "녹음 시작"))) {
      throw new Error('"녹음 시작" 버튼을 찾지 못했습니다.');
    }

    // 프레임이 실제로 흐르기 시작할 때까지 대기
    await page.waitForFunction(() => (window.__ironPerf?.frameCount() ?? 0) > 0, { timeout: 20_000 });
    console.log(`▶ 세션 시작 — ${args.duration}s 측정`);

    const startedAt = Date.now();
    while (Date.now() - startedAt < args.duration * 1000) {
      await sleep(2000);
      const n = await page.evaluate(() => window.__ironPerf?.frameCount() ?? 0);
      process.stdout.write(`\r  수집 프레임: ${n} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }
    process.stdout.write("\n");

    // 세션 종료 후 스냅샷 — endSession이 durationSec을 고정한다.
    await clickButtonByAriaLabel(page, "녹음 중지");
    await sleep(500);
    const data = await page.evaluate(() => window.__ironPerf?.export() ?? null);
    if (!data) throw new Error("측정 데이터가 비어 있습니다 (세션이 시작되지 않았을 수 있음).");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outPath = resolve(outDir, `${args.label}_${data.meta.mode}_${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(data, null, 2));

    // ── 콘솔 요약 ──────────────────────────────────────────────────────────
    console.log(`\n■ 측정 완료 — mode=${data.meta.mode}, device=${data.meta.deviceName ?? "?"}, ` +
      `sr=${data.meta.sampleRate}, buf=${data.meta.samplesPerCh}, ch=${data.meta.channels}, ` +
      `frames=${data.meta.frameCount}, ${data.meta.durationSec}s`);
    const rows: Record<string, unknown>[] = [];
    const push = (stage: string, s: { count: number; avg: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null }) =>
      rows.push({ stage, count: s.count, avg: s.avg, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max });
    push("1. HW capture", data.summary.hwCapture);
    push("2. Encoding", data.summary.encoding);
    push("3. WASM", data.summary.wasm);
    push("4. Decoding", data.summary.decoding);
    push("5. Render(temp)", data.summary.render.temperature);
    push("5. Render(exc)", data.summary.render.excursion);
    console.table(rows);
    console.log(`저장: ${outPath}`);
  } finally {
    if (args.attach) browser.disconnect();
    else await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
