"use client";

import { useEffect, forwardRef, useImperativeHandle } from "react";
import { Mic, Save, Square } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCaptureSession, type CaptureRecordingExport, type CaptureStreamListener } from "./capture/useCaptureSession";

export type MicRecordingExport = CaptureRecordingExport;

export interface MicrophonePlayerHandle {
  exportRecordedAudio: () => Blob | null;
  exportProtectedAudio: () => Blob | null;
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
}

interface Props {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onSaveRecording?: (rec: MicRecordingExport) => Promise<void> | void;
  inputParams: InputParameterValues;
  elevated?: boolean;
}

const MicrophonePlayer = forwardRef<MicrophonePlayerHandle, Props>(function MicrophonePlayer({
  status,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  onSaveRecording,
  inputParams,
  elevated = false,
}: Props, ref) {
  const {
    start, stop, cleanup, isRecording,
    sampleRate, deviceName, actualBufferSize, actualLatency,
    saveRecording, hasRecording, saving, recordingChannels,
    getRecordedBlob, getProtectedBlob, subscribeCaptureStream, frameCountRef, framesRcvdRef,
  } = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    onSaveRecording, inputParams,
  });

  useImperativeHandle(ref, () => ({
    exportRecordedAudio: getRecordedBlob,
    exportProtectedAudio: getProtectedBlob,
    subscribeCaptureStream,
  }), [getRecordedBlob, getProtectedBlob, subscribeCaptureStream]);

  useEffect(() => () => { cleanup(); }, [cleanup]);

  return (
    <div
      className={cn(
        "absolute left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white rounded-full shadow-[0_12px_40px_rgba(15,23,42,0.16)] py-2 pl-2 pr-4 sm:pr-7 w-[calc(100%-1.5rem)] sm:w-[640px] max-w-[640px]",
        elevated ? "z-[65]" : "z-30",
      )}
      style={{ bottom: "calc(28px + env(safe-area-inset-bottom))" }}
    >
      <button
        onClick={isRecording ? stop : () => start()}
        aria-label={isRecording ? "Stop Recording" : "Start Recording"}
        className={cn(
          "flex items-center justify-center w-12 h-12 rounded-full shrink-0 transition-colors text-white",
          isRecording ? "bg-red-500 hover:bg-red-600" : "bg-brand-blue hover:bg-brand-blue-dark",
        )}
      >
        {isRecording ? <Square size={16} /> : <Mic size={16} />}
      </button>

      <div className="flex-1 min-w-0 flex items-center gap-3">
        <span className="shrink-0 flex items-center gap-1.5 text-sm font-semibold text-iron-900">
          <span
            className={cn(
              "inline-block w-[7px] h-[7px] rounded-full",
              isRecording ? "bg-red-500 animate-pulse" : "bg-iron-300",
            )}
          />
          {isRecording ? "Recording" : "Mic Standby"}
        </span>

        {isRecording ? (
          <span className="hidden sm:inline text-xs text-iron-400 font-mono truncate tabular-nums">
            Sent {frameCountRef.current}fr · Received {framesRcvdRef.current}fr
          </span>
        ) : (
          <span className="hidden sm:inline text-xs text-iron-400 truncate tabular-nums">
            {deviceName ?? "Unknown Device"}
            {sampleRate !== null && ` · ${sampleRate.toLocaleString()}Hz`}
            {actualBufferSize !== null && ` · buf ${actualBufferSize}`}
            {actualLatency !== null && ` · ${(actualLatency * 1000).toFixed(1)}ms`}
          </span>
        )}
      </div>

      {hasRecording && onSaveRecording && (
        <button
          onClick={saveRecording}
          disabled={saving}
          title={`Save all ${recordingChannels ?? 2} captured channels as WAV`}
          aria-label="Save to Workspace"
          className="shrink-0 p-1.5 rounded-full text-iron-400 hover:bg-iron-100 hover:text-brand-blue transition-colors disabled:opacity-50"
        >
          <Save size={14} />
        </button>
      )}
    </div>
  );
});

export default MicrophonePlayer;
