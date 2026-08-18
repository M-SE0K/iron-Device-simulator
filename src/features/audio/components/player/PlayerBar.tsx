"use client";

import type { ReactNode } from "react";
import { Play, Pause, Square, Save, X, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import type { PlaybackMode } from "./capture/types";

interface Props {
  isReady: boolean;
  isPlaying: boolean;
  isConnecting?: boolean;
  currentTime: number;
  duration: number;
  fileName: string | null;
  onPlayPause: () => void;
  onStop: () => void;
  onSave?: () => void;
  canSave?: boolean;
  onReset?: () => void;
  playbackMode?: PlaybackMode;
  onPlaybackModeChange?: (mode: PlaybackMode) => void;
  playbackModeLocked?: boolean;
  children: ReactNode;
}

export default function PlayerBar({
  isReady,
  isPlaying,
  isConnecting = false,
  currentTime,
  duration,
  fileName,
  onPlayPause,
  onStop,
  onSave,
  canSave = false,
  onReset,
  playbackMode,
  onPlaybackModeChange,
  playbackModeLocked = false,
  children,
}: Props) {
  const isProtected = playbackMode !== "original";
  return (
    <div
      id="waveform-player"
      className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-white rounded-full shadow-[0_12px_40px_rgba(15,23,42,0.16)] py-2 pl-2 pr-4 sm:pr-7 w-[calc(100%-1.5rem)] sm:w-[640px] max-w-[640px]"
      style={{ bottom: "calc(28px + env(safe-area-inset-bottom))" }}
    >
      <button
        id="play-pause-btn"
        onClick={onPlayPause}
        disabled={!isReady || isConnecting}
        aria-label={isConnecting ? "Connecting" : isPlaying ? "Pause" : "Play"}
        className={cn(
          "flex items-center justify-center w-12 h-12 rounded-full shrink-0 transition-colors",
          isReady
            ? isConnecting
              ? "bg-brand-blue/60 text-white cursor-wait"
              : "bg-brand-blue text-white hover:bg-brand-blue-dark"
            : "bg-iron-100 text-iron-300 cursor-not-allowed"
        )}
      >
        {isConnecting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : isPlaying ? (
          <Pause size={16} />
        ) : (
          <Play size={16} className="ml-0.5" />
        )}
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

      {playbackMode && onPlaybackModeChange && (
        <button
          onClick={() => onPlaybackModeChange(isProtected ? "original" : "protected")}
          disabled={playbackModeLocked}
          title={
            isProtected
              ? "Speaker output runs through the protection algorithm. Click to play the original instead."
              : "Speaker output is the unprocessed original. Click to play the protected signal instead."
          }
          aria-label={isProtected ? "Playing protected signal" : "Playing original signal"}
          className={cn(
            "hidden md:flex shrink-0 items-center gap-1 pl-1.5 pr-2 py-1 rounded-full text-[11px] font-semibold transition-colors",
            isProtected ? "bg-brand-blue/10 text-brand-blue" : "bg-iron-100 text-iron-500",
            playbackModeLocked
              ? "opacity-50 cursor-not-allowed"
              : isProtected
                ? "hover:bg-brand-blue/20"
                : "hover:bg-iron-200"
          )}
        >
          {isProtected ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
          {isProtected ? "Protected" : "Original"}
        </button>
      )}

      <span className="hidden md:inline shrink-0 max-w-[150px] truncate text-[13px] text-iron-500">
        {fileName ?? "—"}
      </span>

      <span className="hidden sm:flex shrink-0 items-center gap-1.5 text-xs text-iron-500">
        <span
          className={cn(
            "inline-block w-[7px] h-[7px] rounded-full",
            isConnecting
              ? "bg-amber-400 animate-pulse"
              : isPlaying
                ? "bg-emerald-500 animate-pulse"
                : "bg-iron-300"
          )}
        />
        <span className="truncate">
          {isConnecting ? "Connecting to device…" : isPlaying ? "Streaming" : "Paused"}
        </span>
      </span>

      <button
        id="stop-btn"
        onClick={onStop}
        disabled={!isReady}
        title="Stop"
        aria-label="Stop"
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
          title="Save to Workspace"
          aria-label="Save to Workspace"
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
          title="Reset File"
          aria-label="Reset File"
          className="shrink-0 p-1.5 rounded-full text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
