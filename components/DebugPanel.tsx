"use client";

import { useRef, useEffect } from "react";
import { StreamDebugInfo, DebugLogEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  info: StreamDebugInfo;
  logs: DebugLogEntry[];
  isMeasuring?: boolean;
  measureFrameCount?: number;
  onMeasureToggle?: () => void;
}

// ── 숫자 표시 + 색상 ──────────────────────────────────────────────────────────
function Metric({
  label, value, unit = "", highlight,
}: {
  label: string; value: number | string | null; unit?: string;
  highlight?: "warn" | "danger" | "ok";
}) {
  const color =
    highlight === "danger" ? "text-red-400"
    : highlight === "warn" ? "text-yellow-400"
    : highlight === "ok"   ? "text-green-400"
    : "text-iron-200";
  return (
    <div className="flex flex-col gap-0.5 min-w-[80px]">
      <span className="text-[9px] text-iron-500 uppercase tracking-widest">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", color)}>
        {value === null ? <span className="text-iron-600">—</span> : `${value}${unit}`}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-8 bg-iron-800 self-center mx-1" />;
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-0.5 justify-end pb-1">
      <span className="text-[9px] text-iron-600 italic">{label}</span>
    </div>
  );
}

// ── 레이턴시 색상 ──────────────────────────────────────────────────────────────
function latencyHighlight(ms: number | null, warnAt: number, dangerAt: number) {
  if (ms === null) return undefined;
  if (ms > dangerAt) return "danger" as const;
  if (ms > warnAt)   return "warn"   as const;
  return "ok" as const;
}

function fmtMs(v: number | null) {
  return v === null ? null : parseFloat(v.toFixed(2));
}

// ── 오디오 시각 MM:SS.mmm ─────────────────────────────────────────────────────
function fmtAudio(sec: number): string {
  const m  = Math.floor(sec / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms).padStart(3,"0")}`;
}

// ── 로그 행 ───────────────────────────────────────────────────────────────────
function LogRow({ entry }: { entry: DebugLogEntry }) {
  const rttColor = entry.rttMs === null ? "text-iron-600"
    : entry.rttMs > 50 ? "text-red-400"
    : entry.rttMs > 20 ? "text-yellow-400" : "text-green-400";

  const reactColor = entry.reactRenderMs === null ? "text-iron-600"
    : entry.reactRenderMs > 30 ? "text-red-400"
    : entry.reactRenderMs > 10 ? "text-yellow-400" : "text-sky-400";

  const echColor = entry.echartsRenderMs === null ? "text-iron-600"
    : entry.echartsRenderMs > 50 ? "text-red-400"
    : entry.echartsRenderMs > 20 ? "text-yellow-400" : "text-purple-400";

  const totalColor = entry.totalRecvRenderMs === null ? "text-iron-600"
    : entry.totalRecvRenderMs > 80 ? "text-red-400"
    : entry.totalRecvRenderMs > 30 ? "text-yellow-400" : "text-emerald-400";

  const freshColor = entry.freshnessLagMs === null ? "text-iron-600"
    : entry.freshnessLagMs > 300 ? "text-red-400"
    : entry.freshnessLagMs > 100 ? "text-yellow-400" : "text-cyan-400";

  const tempColor = entry.temperature >= 75 ? "text-red-400"
    : entry.temperature >= 65 ? "text-yellow-400" : "text-blue-400";

  const excColor = Math.abs(entry.excursion) > 6.8 ? "text-red-400" : "text-emerald-400";
  const excStr   = (entry.excursion >= 0 ? "+" : "") + entry.excursion.toFixed(3);

  function cell(val: number | null, unit: string, color: string, w: string) {
    return (
      <span className={cn("shrink-0 font-mono", color, w)}>
        {val === null ? "    —   " : `${val.toFixed(2)}${unit}`}
      </span>
    );
  }

  return (
    <div className="flex gap-2 items-baseline text-[11px] leading-5 hover:bg-white/5 px-1 rounded">
      <span className="text-iron-500 shrink-0 w-[70px] font-mono">{fmtAudio(entry.audioTime)}</span>
      <span className="text-iron-600 shrink-0 w-[58px] font-mono">fr#{String(entry.frameIdx).padStart(5,"0")}</span>
      {cell(entry.rttMs,             "ms", rttColor,   "w-[58px]")}
      {cell(entry.serverProcMs,      "ms", "text-iron-400", "w-[52px]")}
      {cell(entry.reactRenderMs,     "ms", reactColor, "w-[52px]")}
      {cell(entry.echartsRenderMs,   "ms", echColor,   "w-[52px]")}
      {cell(entry.totalRecvRenderMs, "ms", totalColor, "w-[58px]")}
      {cell(entry.freshnessLagMs,    "ms", freshColor, "w-[58px]")}
      <span className={cn("shrink-0 w-[58px] font-mono", tempColor)}>
        {entry.temperature.toFixed(1).padStart(5," ")}°C
      </span>
      <span className={cn("shrink-0 font-mono", excColor)}>{excStr}mm</span>
    </div>
  );
}

// ── 메인 패널 ─────────────────────────────────────────────────────────────────
export default function DebugPanel({
  info, logs,
  isMeasuring = false, measureFrameCount = 0, onMeasureToggle,
}: Props) {
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [logs]);

  const lostFrames = info.framesSent > 0 ? info.framesSent - info.framesReceived : null;

  return (
    <div id="debug-panel" className="rounded-lg bg-[#0d1117] border border-iron-700 flex flex-col">

      {/* ── 메트릭 요약 ──────────────────────────────────────────────────── */}
      <div className="px-4 py-3 flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-iron-800">

        {/* 헤더 */}
        <div className="w-full flex items-center gap-2 mb-1">
          <span className={cn("inline-block w-1.5 h-1.5 rounded-full",
            info.wsConnected ? "bg-green-400 animate-pulse" : "bg-red-500")} />
          <span className="text-[10px] font-semibold text-iron-400 uppercase tracking-widest">
            Pipeline Latency
          </span>

          {/* 측정 모드 컨트롤 */}
          <div className="ml-auto flex items-center gap-3">
            {isMeasuring && (
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-red-400 animate-pulse">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
                REC {measureFrameCount.toLocaleString()} fr
              </span>
            )}
            {onMeasureToggle && (
              <button
                onClick={onMeasureToggle}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-mono border transition-all",
                  isMeasuring
                    ? "bg-red-950 text-red-400 border-red-700 hover:bg-red-900"
                    : "bg-transparent text-iron-500 border-iron-700 hover:border-iron-500 hover:text-iron-300"
                )}
                title={isMeasuring ? "측정 중지 후 JSON 저장" : "측정 시작"}
              >
                {isMeasuring ? "■ STOP & SAVE" : "● MEASURE"}
              </button>
            )}
            <span className={cn("text-[10px] font-mono",
              info.wsConnected ? "text-green-400" : "text-red-400")}>
              {info.wsConnected ? "CONNECTED" : "DISCONNECTED"}
            </span>
          </div>
        </div>

        {/* 네트워크 구간 */}
        <SectionLabel label="① 네트워크" />
        <Metric label="RTT Latest"  value={fmtMs(info.latestRttMs)} unit="ms"
          highlight={latencyHighlight(info.latestRttMs, 20, 50)} />
        <Metric label="RTT Avg"     value={fmtMs(info.avgRttMs)}    unit="ms"
          highlight={latencyHighlight(info.avgRttMs, 20, 50)} />
        <Metric label="RTT Min"     value={fmtMs(info.minRttMs)}    unit="ms" />
        <Metric label="RTT Max"     value={fmtMs(info.maxRttMs)}    unit="ms"
          highlight={latencyHighlight(info.maxRttMs, 20, 50)} />

        <Divider />

        {/* 서버 처리 */}
        <SectionLabel label="② 서버 처리" />
        <Metric label="Srv Proc" value={fmtMs(info.serverProcessingMs)} unit="ms"
          highlight={latencyHighlight(info.serverProcessingMs, 2, 10)} />

        <Divider />

        {/* 렌더 파이프라인 */}
        <SectionLabel label="③ 렌더" />
        <Metric label="React"   value={fmtMs(info.reactRenderMs)}    unit="ms"
          highlight={latencyHighlight(info.reactRenderMs, 10, 30)} />
        <Metric label="ECharts" value={fmtMs(info.echartsRenderMs)}  unit="ms"
          highlight={latencyHighlight(info.echartsRenderMs, 20, 50)} />

        <Divider />

        {/* 합산 */}
        <SectionLabel label="④ 합산" />
        <Metric label="Recv→Render" value={fmtMs(info.totalRecvRenderMs)} unit="ms"
          highlight={latencyHighlight(info.totalRecvRenderMs, 30, 80)} />
        <Metric label="E2E Total"   value={fmtMs(info.totalE2eMs)}        unit="ms"
          highlight={latencyHighlight(info.totalE2eMs, 50, 100)} />

        <Divider />

        {/* Freshness */}
        <SectionLabel label="⑤ Freshness" />
        <Metric label="Freshness Lag" value={fmtMs(info.freshnessLagMs)} unit="ms"
          highlight={latencyHighlight(info.freshnessLagMs, 100, 300)} />
        <Metric label="Frames Buf" value={info.streamingFramesLen} unit=" fr" />

        <Divider />

        {/* Output Queue */}
        <SectionLabel label="⑥ Queue" />
        <Metric label="Queue Len"    value={info.outputQueueLen}   unit=" fr" />
        <Metric label="Src/Tick"     value={info.sourceCount}      unit="" />
        <Metric label="Dropped"      value={info.droppedFrames}    unit=" fr"
          highlight={info.droppedFrames > 100 ? "warn" : undefined} />
        <Metric label="Events"       value={info.preservedEvents} unit=" fr"
          highlight={info.preservedEvents > 0 ? "ok" : undefined} />
        <Metric label="Render Hz"    value={info.renderUpdateRate} unit=" Hz" />

        <Divider />

        {/* 전송 통계 */}
        <SectionLabel label="⑦ 통계" />
        <Metric label="Sent"      value={info.framesSent}     unit=" fr" />
        <Metric label="Received"  value={info.framesReceived} unit=" fr" />
        <Metric label="In-flight" value={lostFrames}          unit=" fr"
          highlight={lostFrames !== null && lostFrames > 5 ? "warn" : undefined} />
        <Metric label="Send Rate" value={info.sendRateFps}    unit=" fr/s" />

        {/* 범례 */}
        <div className="w-full flex gap-4 mt-1 text-[9px]">
          <span className="text-green-400">● OK</span>
          <span className="text-yellow-400">● WARN</span>
          <span className="text-red-400">● HIGH</span>
          <span className="text-sky-400">● React</span>
          <span className="text-purple-400">● ECharts</span>
          <span className="text-cyan-400">● Fresh</span>
          <span className="text-iron-600 ml-auto">
            {logs.length} 엔트리 (최대 500)
            {isMeasuring && (
              <span className="ml-2 text-red-500">
                · 측정 {measureFrameCount.toLocaleString()} fr 수집 중
              </span>
            )}
          </span>
        </div>
      </div>

      {/* ── 로그 스트림 ──────────────────────────────────────────────────── */}
      <div className="overflow-y-auto h-[220px] px-3 py-2">
        {/* 컬럼 헤더 */}
        <div className="flex gap-2 text-[9px] font-mono text-iron-600 uppercase tracking-wider pb-1 border-b border-iron-800 mb-1 sticky top-0 bg-[#0d1117]">
          <span className="w-[70px]">Audio</span>
          <span className="w-[58px]">Frame</span>
          <span className="w-[58px] text-green-700">RTT</span>
          <span className="w-[52px] text-iron-700">Srv</span>
          <span className="w-[52px] text-sky-700">React</span>
          <span className="w-[52px] text-purple-700">ECh</span>
          <span className="w-[58px] text-emerald-700">Recv→Rndr</span>
          <span className="w-[58px] text-cyan-700">Fresh</span>
          <span className="w-[58px]">Temp</span>
          <span>Exc</span>
        </div>

        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] text-iron-700 font-mono">
            재생하면 파이프라인 로그가 표시됩니다
          </div>
        ) : (
          logs.map((entry, i) => <LogRow key={i} entry={entry} />)
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
