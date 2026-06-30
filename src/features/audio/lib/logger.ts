/**
 * logger.ts — 터미널 ANSI 컬러 로거
 *
 * 환경변수:
 *   LOG_FRAME_INTERVAL=N  프레임 N개마다 한 줄 출력 (기본 10, 0이면 전체)
 *   LOG_LEVEL=silent       프레임 로그 완전 억제
 */

const R  = "\x1b[0m";   // reset
const B  = "\x1b[1m";   // bold
const DIM = "\x1b[2m";  // dim

const GREEN   = "\x1b[32m";
const YELLOW  = "\x1b[33m";
const CYAN    = "\x1b[36m";
const RED     = "\x1b[31m";
const GRAY    = "\x1b[90m";
const MAGENTA = "\x1b[35m";
const BLUE    = "\x1b[34m";
const WHITE   = "\x1b[37m";

function ts(): string {
  const d  = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${GRAY}${hh}:${mm}:${ss}.${ms}${R}`;
}

// ─── 섹션 태그 ────────────────────────────────────────────────────────────────
const TAG = {
  SERVER: `${BLUE}${B}[SERVER]${R}`,
  WS:     `${CYAN}${B}[WS]   ${R}`,
  INIT:   `${GREEN}${B}[INIT]  ${R}`,
  FRAME:  `${MAGENTA}${B}[FRAME] ${R}`,
  PROT:   `${YELLOW}${B}[PROT]  ${R}`,
  CTRL:   `${WHITE}${B}[CTRL]  ${R}`,
  ERR:    `${RED}${B}[ERROR] ${R}`,
};

// ─── 공개 로거 함수 ───────────────────────────────────────────────────────────

export function logServerReady(host: string, port: number, dev: boolean): void {
  console.log(`\n${ts()} ${TAG.SERVER} ${GREEN}Ready${R} on ${B}${host}:${port}${R} ${DIM}[${dev ? "dev" : "prod"}]${R}`);
  console.log(`${ts()} ${TAG.SERVER} WebSocket ${CYAN}ws://${host}:${port}/ws/audio${R}\n`);
}

export function logWsUpgrade(pathname: string): void {
  console.log(`${ts()} ${TAG.WS} HTTP Upgrade → ${CYAN}${pathname}${R}`);
}

export function logWsConnect(): void {
  console.log(`${ts()} ${TAG.WS} ${GREEN}연결 수립${R} — 핸들러 진입`);
}

export function logWsClose(): void {
  console.log(`${ts()} ${TAG.WS} ${GRAY}연결 종료${R}`);
}

export function logInitReceived(mode: "mock" | "native"): void {
  console.log(`${ts()} ${TAG.INIT} init 수신 → mode=${B}${mode.toUpperCase()}${R}`);
}

export function logProtCall(fn: string, retCode: number, elapsedMs: number): void {
  const ok = retCode === 0;
  const mark = ok ? `${GREEN}✓${R}` : `${RED}✗${R}`;
  console.log(
    `${ts()} ${TAG.PROT} ${mark} ${B}${fn}${R}()` +
    ` → ret=${ok ? GREEN : RED}${retCode}${R}` +
    ` ${DIM}(${elapsedMs.toFixed(2)}ms)${R}`
  );
}

export function logReady(): void {
  console.log(`${ts()} ${TAG.INIT} ${GREEN}ready 전송 완료${R} — 스트리밍 대기 중\n`);
}

export function logFrame(
  frameIdx:    number,
  procMs:      number,
  temperature: number,
  excursion:   number,
  mode:        "mock" | "native",
): void {
  // 온도 색상
  const tColor = temperature >= 75 ? RED : temperature >= 65 ? YELLOW : CYAN;
  // 익스커션 색상
  const eColor = Math.abs(excursion) > 6.8 ? RED : GREEN;
  const excStr = (excursion >= 0 ? "+" : "") + excursion.toFixed(3);

  console.log(
    `${ts()} ${TAG.FRAME} #${String(frameIdx).padStart(5, "0")}` +
    `  proc=${DIM}${procMs.toFixed(2)}ms${R}` +
    `  T=${tColor}${temperature.toFixed(1)}°C${R}` +
    `  Exc=${eColor}${excStr}mm${R}` +
    `  ${GRAY}[${mode}]${R}`
  );
}

export function logCtrl(type: "pause" | "stop"): void {
  const color = type === "stop" ? RED : YELLOW;
  console.log(`${ts()} ${TAG.CTRL} ${color}${type.toUpperCase()}${R} 수신`);
}

export function logProtStop(elapsedMs: number): void {
  console.log(`${ts()} ${TAG.PROT} ${B}ff_prot_stop_exec${R}() ${DIM}(${elapsedMs.toFixed(2)}ms)${R}`);
}

export function logError(context: string, err: unknown): void {
  console.error(`${ts()} ${TAG.ERR} [${context}] ${RED}${String(err)}${R}`);
}

/** 브라우저에서 역전송된 전체 파이프라인 레이턴시 로그 */
export function logPipelineMetrics(p: {
  frameIdx:          number;
  audioTime:         number;
  rttMs:             number | null;
  serverProcMs:      number | null;
  reactRenderMs:     number | null;
  echartsRenderMs:   number | null;
  totalRecvRenderMs: number | null;
  totalE2eMs:        number | null;
}): void {
  const fmt  = (v: number | null, unit = "ms") =>
    v === null ? `${DIM}—${R}   ` : `${v.toFixed(2)}${unit}`;

  // E2E 색상
  const e2e  = p.totalE2eMs;
  const e2eColor = e2e === null ? DIM : e2e > 100 ? RED : e2e > 50 ? YELLOW : GREEN;

  const PIPE = `${MAGENTA}${B}[PIPE]  ${R}`;

  console.log(
    `${ts()} ${PIPE}` +
    ` #${String(p.frameIdx).padStart(5, "0")}` +
    `  ${GRAY}t=${p.audioTime.toFixed(3)}s${R}` +
    `  RTT:${CYAN}${fmt(p.rttMs)}${R}` +
    `  srv:${YELLOW}${fmt(p.serverProcMs)}${R}` +
    `  react:${BLUE}${fmt(p.reactRenderMs)}${R}` +
    `  ech:${MAGENTA}${fmt(p.echartsRenderMs)}${R}` +
    `  recv→rndr:${WHITE}${fmt(p.totalRecvRenderMs)}${R}` +
    `  E2E:${e2eColor}${B}${fmt(e2e)}${R}`
  );
}

// ─── 프레임 로그 간격 제어 ────────────────────────────────────────────────────
const _interval = (() => {
  if (process.env.LOG_LEVEL === "silent") return null; // 완전 억제
  const v = parseInt(process.env.LOG_FRAME_INTERVAL ?? "10", 10);
  return isNaN(v) ? 10 : v;
})();

/** frameIdx가 로그 출력 대상인지 여부 */
export function shouldLogFrame(frameIdx: number): boolean {
  if (_interval === null) return false;
  if (_interval === 0)    return true;  // 전체 출력
  return frameIdx % _interval === 0;
}
