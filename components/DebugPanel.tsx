"use client";

import { useRef, useEffect } from "react";
import { StreamDebugInfo, DebugLogEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  info: StreamDebugInfo;
  logs: DebugLogEntry[];
}

function Metric({
  label,
  value,
  unit = "",
  highlight,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  highlight?: "warn" | "danger" | "ok";
}) {
  const color =
    highlight === "danger" ? "text-red-400"
    : highlight === "warn" ? "text-yellow-400"
    : highlight === "ok"   ? "text-green-400"
    : "text-iron-200";

  return (
    <div className="flex flex-col gap-0.5 min-w-[90px]">
      <span className="text-[9px] text-iron-500 uppercase tracking-widest">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", color)}>
        {value === null ? <span className="text-iron-600">—</span> : `${value}${unit}`}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-8 bg-iron-700 self-center" />;
}

/** 오디오 시각을 MM:SS.mmm 형식으로 변환 */
function fmtAudioTime(sec: number): string {
  const m   = Math.floor(sec / 60);
  const s   = Math.floor(sec % 60);
  const ms  = Math.round((sec % 1) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function rttColor(rtt: number | null): string {
  if (rtt === null) return "text-iron-600";
  if (rtt > 50)    return "text-red-400";
  if (rtt > 20)    return "text-yellow-400";
  return "text-green-400";
}

function LogRow({ entry }: { entry: DebugLogEntry }) {
  const rttStr = entry.rttMs !== null ? `${entry.rttMs.toFixed(2)}ms` : "  —   ";
  const color  = rttColor(entry.rttMs);

  return (
    <div className="flex gap-3 items-baseline text-[11px] font-mono leading-5 hover:bg-white/5 px-1 rounded">
      {/* 오디오 타임스탬프 */}
      <span className="text-iron-500 shrink-0 w-[70px]">{fmtAudioTime(entry.audioTime)}</span>
      {/* 프레임 번호 */}
      <span className="text-iron-600 shrink-0 w-[62px]">fr#{String(entry.frameIdx).padStart(5, "0")}</span>
      {/* RTT */}
      <span className={cn("shrink-0 w-[64px]", color)}>
        RTT {rttStr}
      </span>
      {/* 서버 처리 */}
      <span className="text-iron-400 shrink-0 w-[58px]">
        srv {entry.serverProcMs.toFixed(2)}ms
      </span>
      {/* 온도 */}
      <span className={cn(
        "shrink-0 w-[64px]",
        entry.temperature >= 75 ? "text-red-400"
        : entry.temperature >= 65 ? "text-yellow-400"
        : "text-blue-400"
      )}>
        {entry.temperature.toFixed(1).padStart(5, " ")}°C
      </span>
      {/* 익스커션 */}
      <span className={cn(
        "shrink-0",
        Math.abs(entry.excursion) > 6.8 ? "text-red-400" : "text-emerald-400"
      )}>
        {(entry.excursion >= 0 ? "+" : "") + entry.excursion.toFixed(3)}mm
      </span>
    </div>
  );
}

export default function DebugPanel({ info, logs }: Props) {
  const logEndRef = useRef<HTMLDivElement>(null);

  // 새 로그 추가 시 자동 스크롤
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [logs]);

  const rttHighlight =
    info.latestRttMs === null ? undefined
    : info.latestRttMs > 50 ? "danger"
    : info.latestRttMs > 20 ? "warn"
    : "ok";

  const srvHighlight =
    info.serverProcessingMs === null ? undefined
    : info.serverProcessingMs > 10 ? "danger"
    : info.serverProcessingMs > 2  ? "warn"
    : "ok";

  const lostFrames =
    info.framesSent > 0 ? info.framesSent - info.framesReceived : null;

  return (
    <div
      id="debug-panel"
      className="rounded-lg bg-[#0d1117] border border-iron-700 flex flex-col"
    >
      {/* ── 메트릭 요약 바 ────────────────────────────────────────────── */}
      <div className="px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-iron-800">
        <div className="w-full flex items-center gap-2 mb-1">
          <span
            className={cn(
              "inline-block w-1.5 h-1.5 rounded-full",
              info.wsConnected ? "bg-green-400 animate-pulse" : "bg-red-500"
            )}
          />
          <span className="text-[10px] font-semibold text-iron-400 uppercase tracking-widest">
            Latency Debug
          </span>
          <span className={cn(
            "ml-auto text-[10px] font-mono",
            info.wsConnected ? "text-green-400" : "text-red-400"
          )}>
            {info.wsConnected ? "CONNECTED" : "DISCONNECTED"}
          </span>
        </div>

        <Metric label="RTT Latest" value={info.latestRttMs}    unit="ms" highlight={rttHighlight} />
        <Metric label="RTT Avg"    value={info.avgRttMs}       unit="ms" highlight={rttHighlight} />
        <Metric label="RTT Min"    value={info.minRttMs}       unit="ms" />
        <Metric label="RTT Max"    value={info.maxRttMs}       unit="ms"
          highlight={info.maxRttMs !== null && info.maxRttMs > 50 ? "danger" : undefined}
        />

        <Divider />

        <Metric label="Srv Proc"   value={info.serverProcessingMs} unit="ms" highlight={srvHighlight} />

        <Divider />

        <Metric label="Sent"       value={info.framesSent}     unit=" fr" />
        <Metric label="Received"   value={info.framesReceived} unit=" fr" />
        <Metric label="In-flight"  value={lostFrames}          unit=" fr"
          highlight={lostFrames !== null && lostFrames > 5 ? "warn" : undefined}
        />

        <Divider />

        <Metric label="Send Rate"  value={info.sendRateFps}    unit=" fr/s" />

        <div className="w-full flex gap-3 mt-1">
          <span className="text-[9px] text-green-400">● &lt;20ms OK</span>
          <span className="text-[9px] text-yellow-400">● 20–50ms WARN</span>
          <span className="text-[9px] text-red-400">● &gt;50ms HIGH</span>
          <span className="text-[9px] text-iron-600 ml-auto">최근 {logs.length} 엔트리 (최대 500)</span>
        </div>
      </div>

      {/* ── 로그 스트림 ──────────────────────────────────────────────── */}
      <div className="overflow-y-auto h-[220px] px-3 py-2 space-y-0">
        {/* 컬럼 헤더 */}
        <div className="flex gap-3 items-baseline text-[9px] font-mono text-iron-600 uppercase tracking-wider pb-1 border-b border-iron-800 mb-1 sticky top-0 bg-[#0d1117]">
          <span className="w-[70px]">Audio Time</span>
          <span className="w-[62px]">Frame</span>
          <span className="w-[64px]">RTT</span>
          <span className="w-[58px]">Srv Proc</span>
          <span className="w-[64px]">Temp</span>
          <span>Excursion</span>
        </div>

        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] text-iron-700 font-mono">
            재생하면 프레임 로그가 표시됩니다
          </div>
        ) : (
          logs.map((entry, i) => (
            <LogRow key={i} entry={entry} />
          ))
        )}

        {/* 자동 스크롤 앵커 */}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
