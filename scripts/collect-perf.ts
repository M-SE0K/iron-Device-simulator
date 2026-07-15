import puppeteer from "puppeteer";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

async function main() {
  console.log("▶ Electron CDP에 연결...");
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages.find((p) => p.url().startsWith("http://127.0.0.1:17872"));
  if (!page) throw new Error("Electron 페이지 없음");

  console.log("⏳ 30초 동안 파일을 선택하고 재생하세요...");
  for (let i = 30; i > 0; i--) {
    process.stdout.write(`\r  ${i}초 남음`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("\n");

  const frameCount = await page.evaluate(() => window.__ironPerf?.frameCount() ?? 0);
  console.log(`✓ 수집된 프레임: ${frameCount}`);

  const data = await page.evaluate(() => window.__ironPerf?.export() ?? null);
  if (!data) throw new Error("측정 데이터 없음");

  const outDir = resolve("measurements");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = resolve(outDir, `impulse-mchstreamer_native_${stamp}.json`);
  const csvPath = jsonPath.replace(".json", ".csv");

  writeFileSync(jsonPath, JSON.stringify(data, null, 2));

  const csvLines = [
    ["frameIdx", "audioTime", "hwCaptureMs", "encodingMs", "wasmMs", "decodingMs", "totalMs"].join(","),
    ...data.frames.map((f: any) => [
      f.frameIdx,
      f.audioTime.toFixed(3),
      f.hwCaptureMs?.toFixed(3) ?? "",
      f.encodingMs?.toFixed(3) ?? "",
      f.wasmMs.toFixed(3),
      f.decodingMs.toFixed(3),
      ((f.hwCaptureMs ?? 0) + (f.encodingMs ?? 0) + f.wasmMs + f.decodingMs).toFixed(3),
    ].join(",")),
  ];
  writeFileSync(csvPath, csvLines.join("\n"));

  console.log(`\n■ 측정 완료`);
  console.log(`  Mode: ${data.meta.mode}`);
  console.log(`  SR: ${data.meta.sampleRate} Hz`);
  console.log(`  Buffer: ${data.meta.samplesPerCh} samples/ch`);
  console.log(`  Frames: ${data.meta.frameCount}`);
  console.log(`  Duration: ${data.meta.durationSec}s\n`);

  const s = data.summary;
  console.table({
    "HW capture": { avg: s.hwCapture.avg, p50: s.hwCapture.p50, p95: s.hwCapture.p95, max: s.hwCapture.max },
    "Encoding": { avg: s.encoding.avg, p50: s.encoding.p50, p95: s.encoding.p95, max: s.encoding.max },
    "WASM": { avg: s.wasm.avg, p50: s.wasm.p50, p95: s.wasm.p95, max: s.wasm.max },
    "Decoding": { avg: s.decoding.avg, p50: s.decoding.p50, p95: s.decoding.p95, max: s.decoding.max },
    "Render(temp)": { avg: s.render.temperature.avg, p50: s.render.temperature.p50, p95: s.render.temperature.p95, max: s.render.temperature.max },
    "Render(exc)": { avg: s.render.excursion.avg, p50: s.render.excursion.p50, p95: s.render.excursion.p95, max: s.render.excursion.max },
  });

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);

  browser.disconnect();
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
