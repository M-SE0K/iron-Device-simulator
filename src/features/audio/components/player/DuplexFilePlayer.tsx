"use client";

// Electron 파일 모드 전용 플레이어 — 재생과 캡처를 네이티브 play-capture 헬퍼의 단일
// IOProc(단일 클록)으로 돌린다. WaveformPlayer(웹 파일 모드)와 동일한 Props/Handle 계약이라
// DashboardClient 배선은 그대로지만, 재생 자체가 네이티브로 넘어가므로 WaveSurfer 없이
// 표시 전용 진행바만 그린다(파형 없음, 클릭 seek 없음 — v1 결정).
//
// 재생 위치는 별도 타이머 없이 캡처 스트림에서 유도한다: 단일 IOProc이므로 수신한 캡처
// 프레임 수 = 재생된 프레임 수이고, pause 중에는 chunk 이벤트가 recordingActiveRef 게이트에
// 막혀 오지 않으므로 진행바도 저절로 멈춘다.
import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, Square, Save, X } from "lucide-react";
import { cn, formatTime } from "@/shared/lib/utils";
import { AppStatus, AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { SAMPLE_RATE } from "@/features/audio/lib/engine/core";
import { useCaptureSession } from "./capture/useCaptureSession";
import type { WaveformPlayerHandle } from "./WaveformPlayer";

interface Props {
  audioFile: File | null;
  status: AppStatus;
  onTimeUpdate: (currentTime: number) => void;
  onStatusChange: (status: AppStatus) => void;
  /** 캡처 세션(V/I)에서 분석된 프레임 콜백 */
  onFrameReceived: (frame: AnalysisFrame) => void;
  /** 새 캡처 세션 시작 시 — 누적 프레임 초기화 신호 */
  onStreamStart: () => void;
  /** AMP 출력 전력 / 스피커 모델 파라미터 */
  inputParams?: InputParameterValues;
  /** 오디오 총 길이 확정 시 콜백 (초 단위) */
  onDurationReady?: (duration: number) => void;
  /** 작업 영역에 현재 음원+분석 그래프 저장 (플로팅 독의 저장 아이콘) */
  onSave?: () => void;
  canSave?: boolean;
  /** 선택된 파일 초기화 (플로팅 독의 X 아이콘) */
  onReset?: () => void;
  /** 전체 화면 오버레이 위로 독을 끌어올릴 때 (WaveformPlayer와 동일) */
  elevated?: boolean;
}

/** 재생용으로 디코드된 파일 — pcm은 rate(요청 SR)의 mono mixdown, 헬퍼 --ref로 그대로 나간다 */
interface DecodedPlayback {
  pcm: Float32Array;
  rate: number;
  duration: number;
}

/** File → 요청 SR·mono Float32 (표준 Web Audio 다운믹스 + 리샘플을 OfflineAudioContext 한 번에) */
async function decodeFileToMono(file: File, targetRate: number): Promise<DecodedPlayback> {
  const arrayBuf = await file.arrayBuffer();
  const probeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuf);
  } finally {
    void probeCtx.close();
  }
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  // getChannelData가 돌려주는 버퍼를 그대로 refPcm 전송에 쓰므로 복사해 소유권을 확실히 한다
  return { pcm: rendered.getChannelData(0).slice(), rate: targetRate, duration: decoded.duration };
}

const DuplexFilePlayer = forwardRef<WaveformPlayerHandle, Props>(function DuplexFilePlayer({
  audioFile,
  status,
  onTimeUpdate,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  inputParams,
  onDurationReady,
  onSave,
  canSave = false,
  onReset,
  elevated = false,
}: Props, ref) {
  const { values: calibration } = useCalibration();

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const decodedRef = useRef<DecodedPlayback | null>(null);
  // WaveformPlayer와 동일한 세션 재사용 규칙 — 열려 있으면 pause/resume만, 재시작하면
  // WASM 온도 누적이 리셋되므로 세션은 파일당 한 번만 연다.
  const captureStartedRef = useRef(false);
  // 캡처 스트림 기반 재생 위치 — 수신 프레임 수를 세션 SR로 나눈 값 (단일 클록 전제)
  const capturedFramesRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  const captureSession = useCaptureSession({
    status, onStatusChange, onFrameReceived, onStreamStart,
    inputParams,
  });

  // ── 파일 변경 시: 이전 세션 정리 + 재생용 디코드 (WaveSurfer 초기화 대응) ──────
  useEffect(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    capturedFramesRef.current = 0;
    decodedRef.current = null;
    setIsReady(false);
    setDecodeError(null);
    setCurrentTime(0);
    setDuration(0);

    if (!audioFile) return;
    let cancelled = false;

    (async () => {
      try {
        const reqRate = Number(calibration.sampleRate) || SAMPLE_RATE;
        const decoded = await decodeFileToMono(audioFile, reqRate);
        if (cancelled) return;
        decodedRef.current = decoded;
        setDuration(decoded.duration);
        setIsReady(true);
        onStatusChange("ready");
        onDurationReady?.(decoded.duration);
      } catch {
        if (cancelled) return;
        setDecodeError("오디오 파일을 디코드할 수 없습니다.");
        onStatusChange("error");
      }
    })();

    return () => { cancelled = true; };
    // calibration.sampleRate는 의도적으로 제외 — SR 변경은 "다음 세션 시작"에 적용한다는
    // 규칙(CLAUDE.md)에 따라 재생 시작 시점에 rate가 다르면 그때 다시 디코드한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile]);

  // ── 에러 전이 시 세션 재시작 가능하게 리셋 ─────────────────────────────────
  // useCaptureSession이 에러(예: 디스커넥트 exit 3)에서 이미 cleanup()으로 세션을 정리했지만,
  // captureStartedRef는 이 컴포넌트 소유라 훅이 직접 못 건드린다 — 리셋 안 하면 다음 "재생"
  // 클릭이 handlePlayPause의 "재개(resumeRecording)" 분기로 빠져 죽은 세션에 재개 신호만
  // 보내고 끝난다(captureSession.start()가 안 불리므로 micError도 안 지워짐 — 새로고침
  // 없이는 재시작 불가능해지는 버그).
  useEffect(() => {
    if (status === "error") captureStartedRef.current = false;
  }, [status]);

  // ── 진행바: 캡처 스트림 구독 — chunk 프레임 수 누적 = 재생 위치 (단일 클록) ──────
  useEffect(() => {
    const off = captureSession.subscribeCaptureStream((ev) => {
      if (ev.type === "reset") {
        capturedFramesRef.current = 0;
        return;
      }
      capturedFramesRef.current += ev.chunk.byteLength / (ev.channels * 2);
      const pos = Math.min(capturedFramesRef.current / ev.sampleRate, decodedRef.current?.duration ?? Infinity);
      // 청크는 ~10ms마다 오므로 UI 갱신은 100ms로 스로틀 (진행바 10Hz면 충분)
      const now = performance.now();
      if (now - lastUiUpdateRef.current >= 100) {
        lastUiUpdateRef.current = now;
        setCurrentTime(pos);
        onTimeUpdate(pos);
      }
    });
    return off;
  }, [captureSession.subscribeCaptureStream, onTimeUpdate]);

  // ── 재생 완료 (헬퍼 exit 0) — WaveSurfer "finish"와 동일 의미론 ────────────────
  const handlePlaybackEnded = useCallback(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    setCurrentTime(decodedRef.current?.duration ?? 0);
    onStatusChange("paused");
  }, [captureSession.cleanup, onStatusChange]);

  // ── 일시정지 — 세션 유지, 헬퍼 재생 위치 동결 + 데이터 게이트만 닫는다 ─────────
  const pausePlayback = useCallback(() => {
    if (!captureStartedRef.current || status !== "playing") return;
    captureSession.pauseRecording();
    onStatusChange("paused");
  }, [status, captureSession.pauseRecording, onStatusChange]);

  // ── 재생/일시정지 ─────────────────────────────────────────────────────────
  const handlePlayPause = useCallback(async () => {
    if (!isReady) return;

    if (status === "playing") {
      pausePlayback();
      return;
    }
    if (captureStartedRef.current) {
      // 일시정지에서 재개 — 헬퍼 재생 위치와 데이터 게이트를 함께 다시 연다.
      captureSession.resumeRecording();
      onStatusChange("playing");
      return;
    }
    // 최초 재생 — SR이 디코드 시점과 달라졌으면(캘리브레이션 변경) 다시 디코드한 뒤,
    // 디코드 PCM을 그대로 헬퍼 --ref로 넘겨 재생+캡처 세션을 연다. "playing" 전이는
    // 분석 소켓의 ready 메시지가 담당한다(마이크 모드와 동일).
    let decoded = decodedRef.current;
    if (!decoded) return;
    const reqRate = Number(calibration.sampleRate) || SAMPLE_RATE;
    if (decoded.rate !== reqRate && audioFile) {
      try {
        decoded = await decodeFileToMono(audioFile, reqRate);
        decodedRef.current = decoded;
        setDuration(decoded.duration);
      } catch {
        setDecodeError("오디오 파일을 디코드할 수 없습니다.");
        onStatusChange("error");
        return;
      }
    }
    captureStartedRef.current = true;
    setCurrentTime(0);
    void captureSession.start({
      playbackPcm: decoded.pcm,
      onPlaybackEnded: handlePlaybackEnded,
    });
  }, [
    isReady, status, audioFile, calibration.sampleRate, pausePlayback,
    captureSession.resumeRecording, captureSession.start, handlePlaybackEnded, onStatusChange,
  ]);

  // ── 정지 ─────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    captureSession.cleanup();
    captureStartedRef.current = false;
    capturedFramesRef.current = 0;
    setCurrentTime(0);
    onStatusChange("ready");
  }, [captureSession.cleanup, onStatusChange]);

  useImperativeHandle(ref, () => ({
    sendMessage: captureSession.sendMessage,
    pause: pausePlayback,
    exportRecordedAudio: captureSession.getRecordedBlob,
    subscribeCaptureStream: captureSession.subscribeCaptureStream,
  }), [captureSession.sendMessage, pausePlayback, captureSession.getRecordedBlob, captureSession.subscribeCaptureStream]);

  const isPlaying = status === "playing";
  const errorText = decodeError ?? captureSession.micError;
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  // 플로팅 필 독 — WaveformPlayer와 같은 레이아웃, 파형 캔버스 자리에 표시 전용 진행바.
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
        onClick={handlePlayPause}
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

      {/* 진행바 (표시 전용 — seek 없음) */}
      <div id="duplex-progress" className="flex-1 min-w-0 h-9 flex items-center">
        {audioFile ? (
          <div className="w-full h-1.5 rounded-full bg-iron-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand-blue transition-[width] duration-100 ease-linear"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        ) : (
          <p className="waveform-placeholder text-xs text-iron-300 truncate mx-auto">
            파일을 업로드하면 재생할 수 있습니다
          </p>
        )}
      </div>

      {/* 현재 재생 시간 */}
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

      {/* 파일명 */}
      <span className="hidden md:inline shrink-0 max-w-[150px] truncate text-[13px] text-iron-500">
        {audioFile?.name ?? "—"}
      </span>

      {/* 스트리밍 연결 상태 / 에러 */}
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
        onClick={handleStop}
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

      {onReset && audioFile && (
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
});

export default DuplexFilePlayer;
