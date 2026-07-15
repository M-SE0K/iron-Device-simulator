/**
 * measure-file.ts — 파일 모드 성능 측정
 *
 * 사용:
 *   npx tsx scripts/measure-file.ts --file <path> --attach http://127.0.0.1:9222 \
 *     --url http://127.0.0.1:17872
 *
 * 또는 (헤드리스 웹 폴백):
 *   npx tsx scripts/measure-file.ts --file <path>
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import * as fs from "fs";

interface Args {
  file: string;
  label: string;
  attach: string | null;
  url: string;
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: "",
    label: "perf-file",
    attach: null,
    url: "http://localhost:3000",
    headless: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--attach") args.attach = argv[++i];
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--no-headless") args.headless = false;
    else if (a === "--headless") args.headless = true;
  }
  if (!args.file) {
    throw new Error("--file <path> 필수");
  }
  if (!existsSync(args.file)) {
    throw new Error(`파일을 찾을 수 없습니다: ${args.file}`);
  }
  return args;
}

async function clickButtonByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t) => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
    if (!btn) return false;
    (btn as HTMLButtonElement).click();
    return true;
  }, text);
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
    console.log("▶ Chromium launch (헤드리스)");
    browser = await puppeteer.launch({
      headless: args.headless,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
  }

  try {
    let page: Page;
    if (args.attach) {
      const pages = await browser.pages();
      const found = pages.find((p) => p.url().startsWith(args.url));
      if (!found) {
        throw new Error(`열려 있는 페이지 중 ${args.url} 로 시작하는 페이지를 찾지 못했습니다.`);
      }
      page = found;
    } else {
      page = await browser.newPage();
      await page.goto(args.url, { waitUntil: "networkidle2", timeout: 60_000 });
    }

    // 수집기 로드 대기
    await page.waitForFunction(() => typeof window.__ironPerf !== "undefined", { timeout: 30_000 });

    // 파일 입력 요소에 파일 업로드
    console.log(`▶ 파일 업로드: ${args.file}`);
    const inputSelector = 'input[type="file"]';
    const fileInput = await page.$(inputSelector);
    if (!fileInput) {
      throw new Error("파일 입력 요소를 찾을 수 없습니다");
    }
    await fileInput.uploadFile(args.file);

    // 파일 로드 대기
    await page.waitForFunction(
      () => {
        const el = document.querySelector<HTMLElement>('[data-testid="selected-file-name"]');
        return el && el.textContent && el.textContent.length > 0;
      },
      { timeout: 10_000 },
    ).catch(() => console.warn("파일 로드 UI 타임아웃 — 계속 진행"));

    await sleep(500);

    // 재생 시작
    console.log(`▶ 재생 시작`);
    if (!(await clickButtonByText(page, "재생"))) {
      throw new Error('"재생" 버튼을 찾을 수 없습니다');
    }

    // 프레임 수집 대기
    await page.waitForFunction(() => (window.__ironPerf?.frameCount() ?? 0) > 0, { timeout: 20_000 });
    console.log(`▶ 재생 중 — 데이터 수집`);

    // 재생이 끝날 때까지 대기 (최대 2분)
    const maxWait = 120_000;
    const startWait = Date.now();
    let lastFrameCount = 0;
    let noProgressCount = 0;

    while (Date.now() - startWait < maxWait) {
      const frameCount = await page.evaluate(() => window.__ironPerf?.frameCount() ?? 0);
      process.stdout.write(`\r  프레임: ${frameCount}`);

      if (frameCount === lastFrameCount) {
        noProgressCount++;
        if (noProgressCount > 5) {
          // 5초 동안 새 프레임 없음 = 재생 완료
          console.log("\n  (재생 완료)");
          break;
        }
      } else {
        noProgressCount = 0;
        lastFrameCount = frameCount;
      }

      await sleep(1000);
    }
    process.stdout.write("\n");

    // 데이터 수집
    const data = await page.evaluate(() => window.__ironPerf?.export() ?? null);
    if (!data) throw new Error("측정 데이터가 비어 있습니다");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${args.label}_file_${stamp}.json`;
    const outPath = resolve(outDir, filename);
    writeFileSync(outPath, JSON.stringify(data, null, 2));

    // ── 콘솔 요약 ──────────────────────────────────────────────────────────
    console.log(
      `\n■ 측정 완료 — mode=${data.meta.mode}, sr=${data.meta.sampleRate}, ` +
        `buf=${data.meta.samplesPerCh}, frames=${data.meta.frameCount}, ${data.meta.durationSec}s`,
    );

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
    console.log(`\n저장: ${outPath}`);

    // CSV 생성
    const csvPath = outPath.replace(".json", ".csv");
    const csvData = [
      ["frameIdx", "audioTime", "hwCaptureMs", "encodingMs", "wasmMs", "decodingMs", "totalMs"].join(","),
      ...data.frames.map((f) =>
        [
          f.frameIdx,
          f.audioTime.toFixed(3),
          f.hwCaptureMs?.toFixed(3) ?? "",
          f.encodingMs?.toFixed(3) ?? "",
          f.wasmMs.toFixed(3),
          f.decodingMs.toFixed(3),
          (
            (f.hwCaptureMs ?? 0) +
            (f.encodingMs ?? 0) +
            f.wasmMs +
            f.decodingMs
          ).toFixed(3),
        ].join(","),
      ),
    ].join("\n");
    writeFileSync(csvPath, csvData);
    console.log(`CSV: ${csvPath}`);
  } finally {
    if (args.attach) browser.disconnect();
    else await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
