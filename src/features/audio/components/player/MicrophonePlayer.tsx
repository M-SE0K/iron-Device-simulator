"use client";

import { useEffect } from "react";
import { Mic, Save, Square } from "lucide-react";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { StreamDebugInfo, DebugLogEntry } from "@/features/audio/lib/debug/types";
import { useCaptureSession, type CaptureRecordingExport } from "./capture/useCaptureSession";

/** 저장 요청 시 상위(DashboardClient)로 넘기는 전 채널 캡처 내보내기 */
export type MicRecordingExport = CaptureRecordingExport;

interface Props {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onDebugUpdate: (info: Partial<StreamDebugInfo>) => void;
  onDebugLog?: (entry: DebugLogEntry) => void;
  onSaveRecording?: (rec: MicRecordingExport) => Promise<void> | void;
  inputParams: InputParameterValues;
}

export default function MicrophonePlayer({
  status,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  onDebugUpdate,
  onDebugLog,
  onSaveRecording,
  inputParams,
}: Props) {
  const {
    start, stop, cleanup, isRecording,
    micError, sampleRate, deviceName, actualBufferSize, actualLatency,
    saveRecording, hasRecording, saving, recordingChannels,
    frameCountRef, framesRcvdRef,
  } = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    onDebugUpdate, onDebugLog, onSaveRecording, inputParams,
  });

  // 언마운트 시 정리
  useEffect(() => () => { cleanup(); }, [cleanup]);

  return (
    <div className="card p-4 flex flex-col gap-3">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full transition-all ${
              isRecording ? "bg-red-500 animate-pulse" : "bg-iron-300"
            }`}
          />
          <span className="text-sm font-medium text-iron-700">
            {isRecording ? "녹음 중" : "마이크 대기"}
          </span>
          {deviceName !== null && (
            <span className="text-xs text-iron-400 font-mono">{deviceName}</span>
          )}
          {sampleRate !== null && (
            <span className="text-xs text-iron-400 font-mono">
              {sampleRate.toLocaleString()} Hz
            </span>
          )}
          {actualBufferSize !== null && (
            <span className="text-xs text-iron-400 font-mono">
              buf {actualBufferSize}
            </span>
          )}
          {actualLatency !== null && (
            <span className="text-xs text-iron-400 font-mono">
              latency {(actualLatency * 1000).toFixed(1)}ms
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* 전 채널 저장 — 정지 후 세션 버퍼(ch0=V, ch1=I + 확장 채널)를 WAV로 워크스페이스에 보존 */}
          {hasRecording && onSaveRecording && (
            <button
              onClick={saveRecording}
              disabled={saving}
              title={`캡처된 ${recordingChannels ?? 2}채널 전체를 WAV로 저장`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-iron-100 hover:bg-iron-200 text-iron-600 disabled:opacity-50"
            >
              <Save size={13} /> {saving ? "저장 중…" : `저장 (${recordingChannels ?? 2}ch)`}
            </button>
          )}
          <button
            onClick={isRecording ? stop : start}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              isRecording
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-brand-blue hover:bg-blue-700 text-white"
            }`}
          >
            {isRecording ? (
              <><Square size={13} /> 중지</>
            ) : (
              <><Mic size={13} /> 녹음 시작</>
            )}
          </button>
        </div>
      </div>

      {/* 오류 메시지 */}
      {micError && (
        <p className="text-xs text-red-500 px-1">{micError}</p>
      )}

      {/* 안내 */}
      {!isRecording && !micError && (
        <p className="text-xs text-iron-300 text-center py-2">
          녹음을 시작하면 마이크 오디오가 실시간으로 분석됩니다
        </p>
      )}

      {/* 녹음 중 프레임 카운터 */}
      {isRecording && (
        <div className="flex items-center justify-center gap-4 text-xs font-mono text-iron-400">
          <span>송신 {frameCountRef.current} fr</span>
          <span className="text-iron-200">|</span>
          <span>수신 {framesRcvdRef.current} fr</span>
        </div>
      )}
    </div>
  );
}
