"use client";

import { useEffect, forwardRef, useImperativeHandle } from "react";
import { Mic, Save, Square } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCaptureSession, type CaptureRecordingExport, type CaptureStreamListener } from "./capture/useCaptureSession";

/** 저장 요청 시 상위(DashboardClient)로 넘기는 전 채널 캡처 내보내기 */
export type MicRecordingExport = CaptureRecordingExport;

/** page.tsx에서 ref로 접근할 수 있는 MicrophonePlayer 핸들 — WaveformPlayerHandle과 동일 계약 */
export interface MicrophonePlayerHandle {
  /** 캡처 세션 버퍼(ch0=V/ch1=I + 확장 채널)를 WAV로 인코딩해 반환한다. 캡처 이력이 없으면 null. */
  exportRecordedAudio: () => Blob | null;
  /** 원본 캡처 청크 실시간 스트림을 구독한다(ChartDetailOverlay 채널 뷰) — WaveformPlayer와 동일 계약. */
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
}

interface Props {
  status: AppStatus;
  onStatusChange: (s: AppStatus) => void;
  onFrameReceived: (frame: AnalysisFrame) => void;
  onStreamStart: () => void;
  onSaveRecording?: (rec: MicRecordingExport) => Promise<void> | void;
  inputParams: InputParameterValues;
  /** ChartDetailOverlay(z-[60])가 열려 있을 때 플로팅 독을 그 위로 끌어올린다 — WaveformPlayer와 동일 계약. */
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
    micError, sampleRate, deviceName, actualBufferSize, actualLatency,
    saveRecording, hasRecording, saving, recordingChannels,
    getRecordedBlob, subscribeCaptureStream, frameCountRef, framesRcvdRef,
  } = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    onSaveRecording, inputParams,
  });

  useImperativeHandle(ref, () => ({
    exportRecordedAudio: getRecordedBlob,
    subscribeCaptureStream,
  }), [getRecordedBlob, subscribeCaptureStream]);

  // 언마운트 시 정리
  useEffect(() => () => { cleanup(); }, [cleanup]);

  // 플로팅 필 독 — WaveformPlayer(파일 모드)와 같은 위치/폭. 파형 스크러버 대신 녹음
  // 상태/장치 정보(대기) 또는 송수신 프레임 카운터(녹음 중)를 보여준다.
  return (
    <div
      className={cn(
        "absolute left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white rounded-full shadow-[0_12px_40px_rgba(15,23,42,0.16)] py-2 pl-2 pr-4 sm:pr-7 w-[calc(100%-1.5rem)] sm:w-[640px] max-w-[640px]",
        elevated ? "z-[65]" : "z-30",
      )}
      style={{ bottom: "calc(28px + env(safe-area-inset-bottom))" }}
    >
      <button
        onClick={isRecording ? stop : start}
        aria-label={isRecording ? "녹음 중지" : "녹음 시작"}
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
          {isRecording ? "녹음 중" : "마이크 대기"}
        </span>

        {micError ? (
          <span className="hidden sm:inline text-xs text-red-500 truncate">{micError}</span>
        ) : isRecording ? (
          <span className="hidden sm:inline text-xs text-iron-400 font-mono truncate tabular-nums">
            송신 {frameCountRef.current}fr · 수신 {framesRcvdRef.current}fr
          </span>
        ) : (
          <span className="hidden sm:inline text-xs text-iron-400 truncate tabular-nums">
            {deviceName ?? "장치 미확인"}
            {sampleRate !== null && ` · ${sampleRate.toLocaleString()}Hz`}
            {actualBufferSize !== null && ` · buf ${actualBufferSize}`}
            {actualLatency !== null && ` · ${(actualLatency * 1000).toFixed(1)}ms`}
          </span>
        )}
      </div>

      {/* 전 채널 저장 — 정지 후 세션 버퍼(ch0=V, ch1=I + 확장 채널)를 WAV로 워크스페이스에 보존 */}
      {hasRecording && onSaveRecording && (
        <button
          onClick={saveRecording}
          disabled={saving}
          title={`캡처된 ${recordingChannels ?? 2}채널 전체를 WAV로 저장`}
          aria-label="작업 영역에 저장"
          className="shrink-0 p-1.5 rounded-full text-iron-400 hover:bg-iron-100 hover:text-brand-blue transition-colors disabled:opacity-50"
        >
          <Save size={14} />
        </button>
      )}
    </div>
  );
});

export default MicrophonePlayer;
