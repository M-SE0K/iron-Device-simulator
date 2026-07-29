#!/usr/bin/env node
"use strict";

// scripts/실험용/sweep-sw-latency.js — S/W 지연 실험(N1~N12)을 버퍼사이즈별로 반자동 스윕한다.
//
// 자동화하는 것: 창 크기 보정, Workspace 폴더 연결(네이티브 다이얼로그 스텁), 버퍼사이즈
// 변경 + Calibration Apply, window.__ironE2E.export() 결과를 JSON으로 저장.
// 사람이 직접 하는 것: Workspace 목록에서 재생할 파일 클릭, 재생(Play) 시작/종료 확인.
//   → Play/Stop 버튼 상태를 Playwright로 자동 판별하는 게 이 머신에서 안정적이지 않아서
//     (뷰포트/좌표 이슈로 몇 차례 실패) 그 두 동작만 사람이 하고 터미널에서 Enter로
//     "다음 단계로 진행해도 됨"을 알려주는 구조로 바꿨다.
//
// 전제:
//   - out/ 와 electron-dist/ 가 이미 빌드돼 있어야 한다: npm run build:electron:mac
//     (또는 build:electron:main 을 포함하는 다른 build:electron:* 한 번으로 충분).
//   - 실제 오디오 하드웨어(캡처 디바이스)가 연결되어 있어야 한다.
//
// 사용법:
//   node scripts/실험용/sweep-sw-latency.js
//   REF_FOLDER=... BUFFER_SIZES=16,32 REPEATS=1 OUT_DIR=... node scripts/실험용/sweep-sw-latency.js

const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { _electron: electron } = require("playwright");

const REF_FOLDER = process.env.REF_FOLDER
  || "/Users/m._.se0k/m._.se0k/2026_1/iron-Device/exp/music/MCHStreamer";
const BUFFER_SIZES = (process.env.BUFFER_SIZES || "16,32,64,128,256,480,1024,2048").split(",");
const REPEATS = Number(process.env.REPEATS || 3);
const OUT_DIR = process.env.OUT_DIR || path.resolve(process.cwd(), "sw-latency-sweep-results");

function log(msg) {
  console.log(`[sweep] ${msg}`);
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n👉 ${promptText}\n   (준비되면 Enter) `, () => {
      rl.close();
      resolve();
    });
  });
}

// Electron 창의 CSS 뷰포트 폭이 Tailwind의 `lg` 브레이크포인트(1024px) 밑으로 잡히면
// 사이드바가 모바일 오프캔버스 모드로 바뀐다(이 머신은 물리 1280px인데 devicePixelRatio가
// 1.31이라 CSS로는 974px로 잡혀 항상 이 모드였다). 창 자체를 키워서 데스크톱 레이아웃으로
// 강제한다 — 사이드바가 항상 보이는 상태라야 사람이 클릭할 때도 헷갈리지 않는다.
async function enlargeWindow(app) {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(2000, 1200);
  });
}

async function applyBufferSize(page, bufferSize) {
  await page.getByRole("button", { name: "Calibration", exact: true }).click();
  await page.getByRole("button", { name: "Buffer Size", exact: true }).click();
  await page.getByRole("option", { name: bufferSize, exact: true }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  // 네이티브 브리지가 있으면(Electron) "Applied — requested ..." 텍스트가 뜬다.
  await page
    .getByText(/^Applied —/)
    .waitFor({ timeout: 15000 })
    .catch(() => log(`  ("Applied" 텍스트를 못 봤음 — 그래도 계속 진행)`));
  await page.keyboard.press("Escape");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`out dir: ${OUT_DIR}`);
  log(`buffer sizes: ${BUFFER_SIZES.join(", ")} / repeats: ${REPEATS}`);

  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await enlargeWindow(app);

  // "로컬 폴더 연결" 네이티브 다이얼로그를 스텁 — 항상 고정 폴더를 즉시 반환.
  await app.evaluate(async ({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
  }, REF_FOLDER);

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Connect Folder", exact: true }).click();

  await waitForEnter(
    "Workspace 목록에서 재생할 파일을 클릭해 플레이어에 로드하세요 (드로어는 닫아도, 안 닫아도 무방)."
  );

  log("E2E 계측 활성화");
  await page.evaluate(() => window.__ironE2E && window.__ironE2E.enable());

  const savedFiles = [];
  for (const bufferSize of BUFFER_SIZES) {
    log(`버퍼사이즈 ${bufferSize} 적용`);
    await applyBufferSize(page, bufferSize);

    for (let rep = 1; rep <= REPEATS; rep++) {
      await waitForEnter(
        `[buffer=${bufferSize}, rep=${rep}/${REPEATS}] Play를 눌러 재생하세요. 재생이 끝나면(자동 정지 확인 후) Enter.`
      );

      const data = await page.evaluate(() => window.__ironE2E && window.__ironE2E.export());
      if (!data) {
        log(`  ⚠️ export() 결과 없음 — 스킵 (buffer=${bufferSize}, rep=${rep})`);
        continue;
      }

      const outFile = path.join(OUT_DIR, `e2e-sw-mac-48khz_${bufferSize}-${rep}.json`);
      fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
      savedFiles.push(outFile);
      log(`  → 저장: ${outFile}`);
    }
  }

  await waitForEnter("전체 스윕이 끝났습니다. Enter를 누르면 앱을 닫습니다.");
  await app.close();
  log(`완료 — 총 ${savedFiles.length}개 파일 저장 (${OUT_DIR})`);
}

main().catch((err) => {
  console.error("[sweep] 실패:", err);
  process.exit(1);
});
