"use client";

import type { ReactNode } from "react";
import { Play, Pause, Square, Save, X } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";

interface Props {
  isReady: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  fileName: string | null;
  onPlayPause: () => void;
  onStop: () => void;
  /** 상태 영역에 표시할 에러 — 있으면 빨간 점/텍스트로 대체된다. */
  errorText?: string | null;
  onSave?: () => void;
  canSave?: boolean;
  onReset?: () => void;
  elevated?: boolean;
  /** 가운데 슬롯 — 파형 캔버스(WaveformPlayer) 또는 진행바(DuplexFilePlayer). */
  children: ReactNode;
}

/** 하단 중앙 재생 컨트롤 알약 UI — WaveformPlayer/DuplexFilePlayer가 공유하는 프레젠테이션 셸. */
export default function PlayerBar({
  isReady,
  isPlaying,
  currentTime,
  duration,
  fileName,
  onPlayPause,
  onStop,
  errorText = null,
  onSave,
  canSave = false,
  onReset,
  elevated = false,
  children,
}: Props) {
  return (
    <div
      id="waveform-player"
      className={cn(
        "absolute left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white rounded-full shadow-[0_12px_40px_rgba(15,23,42,0.16)] py-2 pl-2 pr-4 sm:pr-7 w-[calc(100%-1.5rem)] sm:w-[640px] max-w-[640px]",
        elevated ? "z-[65]" : "z-30",
      )}
      style={{ bottom: "calc(28px + env(safe-area-inset-bottom))" }}
    >
      <button
        id="play-pause-btn"
        onClick={onPlayPause}
        disabled={!isReady}
        aria-label={isPlaying ? "일시정지" : "재생"}
        className={cn(
          "flex items-center justify-center w-12 h-12 rounded-full shrink-0 transition-colors",
          isReady
            ? "bg-brand-blue text-white hover:bg-brand-blue-dark"
            : "bg-iron-100 text-iron-300 cursor-not-allowed"
        )}
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>

      {children}

      <span
        id="playback-time"
        className={cn(
          "hidden sm:inline shrink-0 font-semibold text-sm tabular-nums",
          isReady ? "text-iron-900" : "text-iron-300"
        )}
      >
        {formatTime(currentTime)}
        <span className="text-iron-400 font-normal"> / {formatTime(duration)}</span>
      </span>

      <div className="hidden sm:block w-px h-5 bg-iron-200 shrink-0" />

      <span className="hidden md:inline shrink-0 max-w-[150px] truncate text-[13px] text-iron-500">
        {fileName ?? "—"}
      </span>

      <span
        className={cn(
          "hidden sm:flex shrink-0 items-center gap-1.5 text-xs",
          errorText ? "text-red-500 max-w-[160px]" : "text-iron-500"
        )}
        title={errorText ?? undefined}
      >
        <span
          className={cn(
            "inline-block w-[7px] h-[7px] rounded-full",
            errorText ? "bg-red-500" : isPlaying ? "bg-emerald-500 animate-pulse" : "bg-iron-300"
          )}
        />
        <span className="truncate">{errorText ?? (isPlaying ? "스트리밍 중" : "일시정지됨")}</span>
      </span>

      <button
        id="stop-btn"
        onClick={onStop}
        disabled={!isReady}
        title="정지"
        aria-label="정지"
        className={cn(
          "shrink-0 p-1.5 rounded-full transition-colors",
          isReady ? "text-iron-400 hover:bg-iron-100 hover:text-iron-700" : "text-iron-200 cursor-not-allowed"
        )}
      >
        <Square size={14} />
      </button>

      {onSave && (
        <button
          onClick={onSave}
          disabled={!canSave}
          title="작업 영역에 저장"
          aria-label="작업 영역에 저장"
          className={cn(
            "shrink-0 p-1.5 rounded-full transition-colors",
            canSave ? "text-iron-400 hover:bg-iron-100 hover:text-brand-blue" : "text-iron-200 cursor-not-allowed"
          )}
        >
          <Save size={14} />
        </button>
      )}

      {onReset && (
        <button
          onClick={onReset}
          title="파일 초기화"
          aria-label="파일 초기화"
          className="shrink-0 p-1.5 rounded-full text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
