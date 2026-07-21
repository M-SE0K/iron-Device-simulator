"use client";

// Electron 네이티브 CoreAudio 캡처 경로 (useCaptureSession 공용 — 파일/마이크 모드 공통).
// 상주 헬퍼(audio-device-helper capture)가 캡처 I/O(IOProc)를 직접 소유하므로
// BufferFrameSize가 실제로 적용·유지된다 — getUserMedia 경로에서는 캡처를 여는
// Chromium이 버퍼 크기의 주인이라(TN2321) 요청값을 강제할 수 없었다.
// params.playback이 있으면(파일 모드) capture 대신 play-capture 헬퍼를 쓴다 — 같은 IOProc이
// 재생 파일을 출력 ch0으로 내보내며 캡처하므로 재생과 캡처가 단일 클록에 놓인다. 두 헬퍼의
// 스트리밍 프로토콜이 동일해 이 훅의 나머지 로직(reframe/원본 버퍼/perf 계측)은 전부 공유된다.
import { useCallback, type MutableRefObject } from "react";
import type { AppStatus } from "@/features/audio/types";
import { perf } from "@/features/audio/lib/perf/collector";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import type { CaptureStreamEvent } from "./useCaptureSession";
import { createNativeFrameReframer } from "./reframeNativeChunk";

export interface NativeCaptureParams {
  sampleRate: number;
  bufferSize: number;
  /** calibration.channels (문자열) — 최소 2ch로 보정된다 */
  channels: string;
  /** calibration.captureDeviceUID — 빈 문자열이면 OS 기본 입력 */
  captureDeviceUID: string;
  /**
   * 파일 모드 재생 — 있으면 capture 대신 play-capture 헬퍼(window.audioPlayCapture)를 쓴다:
   * 같은 IOProc의 출력 ch0으로 pcm(요청 SR·mono로 디코드된 재생 파일 전체)을 연속 재생하며
   * 캡처한다(단일 클록 — 수신 캡처 프레임 수 = 재생 프레임 수). onEnded는 재생이 끝까지
   * 도달해 헬퍼가 exit 0으로 자기 종료했을 때 불린다(WaveSurfer "finish" 대응).
   */
  playback?: {
    pcm: Float32Array;
    onEnded: () => void;
    /** ref를 내보낼 출력 채널 인덱스(calibration.outputChannel) — 생략/0이면 ch0(기본). */
    outputChannel?: number;
  };
}

/**
 * 캡처 세션 동안 메모리에 보존하는 N채널 인터리브 int16 원본 PCM.
 * 엔진에는 ch0(V)/ch1(I)만 나가지만, Calibration에서 확장한 나머지 채널도 여기 남아
 * 사용자가 저장을 요청하면 전 채널이 WAV로 내보내진다. 다음 캡처 시작 시 교체된다.
 * (메모리 사용: 8ch·48kHz 기준 약 1.5MB/s — 명시적 저장 전까지만 유지되는 세션 버퍼)
 */
export interface NativeRawCapture {
  channels: number;
  sampleRate: number;
  frames: ArrayBuffer[]; // wireSamplesPerCh sample-frame × channels, int16 인터리브
}

export interface NativeCaptureDeps {
  nativeOffsRef: MutableRefObject<Array<() => void>>;
  nativeActiveRef: MutableRefObject<boolean>;
  /** play-capture(파일 재생+캡처) 헬퍼가 활성인지 — cleanup이 audioPlayCapture.stop()을 부를지 판단 */
  playCaptureActiveRef: MutableRefObject<boolean>;
  /** 전 채널 원본 PCM 보존 버퍼 — 캡처 시작 시 새로 초기화되고 세션 내내 축적된다. */
  rawCaptureRef: MutableRefObject<NativeRawCapture | null>;
  /**
   * true인 동안만 rawCaptureRef에 프레임을 쌓는다 — 분석 소켓(WASM)에는 항상 보내지만
   * 저장용 원본 버퍼 축적은 일시정지할 수 있게 분리한다(WaveformPlayer의 재생 일시정지 시
   * "녹음도 함께 멈춤" 기대와 저장 파일에 무음 구간이 안 섞이게 하려는 목적).
   */
  recordingActiveRef: MutableRefObject<boolean>;
  /**
   * true인 동안만 분석 소켓(WASM)에 프레임을 보낸다 — 재생 일시정지 중에는 꺼서 소켓
   * frameCount(= 차트 시간축)와 WASM 온도 누적을 정지 지점에 고정한다(재개 시 끊김 없이 이어짐).
   */
  analysisActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  frameCountRef: MutableRefObject<number>;
  onStatusChange: (s: AppStatus) => void;
  setMicError: (msg: string | null) => void;
  setSampleRate: (v: number | null) => void;
  setDeviceName: (v: string | null) => void;
  setActualBufferSize: (v: number | null) => void;
  openAnalysisSocket: (actualRate: number, samplesPerCh: number) => SocketLike;
  cleanup: () => void;
  /**
   * 원본 캡처 청크를 실시간으로 알린다(ChartDetailOverlay 채널 뷰가 폴링 없이 구독) —
   * 세션 시작 시 "reset", 이후 청크마다 "chunk"(저장 버퍼에 쌓는 것과 같은 복사본).
   */
  emitStreamEvent: (ev: CaptureStreamEvent) => void;
}

// IPC 왕복 단위 — refPcm 전체를 한 번의 구조화 복제로 넘기면(수 분 파일 기준 수십 MB)
// 메인 프로세스가 fs.writeFileSync 동안 통째로 멎으므로, 작은 조각으로 나눠 순차 전송한다.
const REF_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** 재생 파일 PCM을 청크 핸드셰이크로 메인에 업로드하고, play-capture:start가 소비할 writeId를 반환한다. */
async function uploadPlaybackRef(
  bridge: NonNullable<Window["audioPlayCapture"]>,
  pcm: Float32Array,
): Promise<string> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const started = await bridge.startWrite({ totalBytes: bytes.byteLength });
  if (!started.success || !started.writeId) {
    throw new Error(`재생 파일 전송 시작 실패: ${started.error ?? "unknown"}`);
  }
  const { writeId } = started;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += REF_UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + REF_UPLOAD_CHUNK_BYTES, bytes.byteLength));
      const res = await bridge.writeChunk({ writeId, chunk });
      if (!res.success) throw new Error(`재생 파일 전송 실패: ${res.error ?? "unknown"}`);
    }
    const finalized = await bridge.finalizeWrite({ writeId });
    if (!finalized.success) throw new Error(`재생 파일 전송 마무리 실패: ${finalized.error ?? "unknown"}`);
  } catch (err) {
    bridge.cancelWrite({ writeId });
    throw err;
  }
  return writeId;
}

export function useNativeCapture(deps: NativeCaptureDeps) {
  const {
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  } = deps;

  const start = useCallback(async (params: NativeCaptureParams) => {
    const { playback } = params;

    // 캡처 채널 수 — Calibration에서 장치 스펙(inputChannels) 이하로 지정한다.
    // 엔진 분석에는 ch0(V)/ch1(I)만 쓰이고, 나머지 채널은 rawCaptureRef에 보존된다.
    const captureChannels = clampCaptureChannels(params.channels);
    const baseOpts = {
      sampleRate: params.sampleRate,
      bufferSize: params.bufferSize,
      channels:   captureChannels,
      deviceUID:  params.captureDeviceUID?.trim() || undefined,
    };

    // 파일 재생이 딸려 있으면 play-capture(재생+캡처 단일 IOProc), 아니면 순수 capture.
    // 두 브리지는 start 결과·onData/onEnded 프로토콜이 같아 이후 로직(actual 우선 원칙,
    // 분석 소켓, reframe, perf 계측)을 전부 공유한다.
    let res;
    if (playback) {
      const playCapture = window.audioPlayCapture;
      if (!playCapture) throw new Error("파일 재생(play-capture) 브리지를 사용할 수 없습니다.");
      const refWriteId = await uploadPlaybackRef(playCapture, playback.pcm);
      res = await playCapture.start({ ...baseOpts, refWriteId, outputChannel: playback.outputChannel });
      if (!res.success && res.error?.includes("device-has-no-output")) {
        throw new Error(
          "선택한 캡처 장치에 출력 채널이 없어 파일 재생이 불가합니다. " +
          "입·출력 겸용 장치(예: MCHStreamer)를 Capture Device로 선택하세요."
        );
      }
    } else {
      const nativeCapture = window.audioCapture;
      if (!nativeCapture) throw new Error("네이티브 캡처 브리지를 사용할 수 없습니다.");
      res = await nativeCapture.start(baseOpts);
    }
    if (!res.success) {
      throw new Error(`네이티브 캡처 시작 실패: ${res.error ?? "unknown"}`);
    }

    const actualRate = res.actual?.sampleRate ?? params.sampleRate;
    // 재생 ref는 요청 SR로 미리 디코드돼 있다 — 장치가 다른 SR로 열리면 피치/클록이 왜곡되므로
    // 세션을 거부한다(useDeviceOptionAutoCorrect가 지원 SR만 고르게 해 실제로는 드묾).
    if (playback && Math.abs(actualRate - params.sampleRate) >= 1) {
      window.audioPlayCapture?.stop();
      throw new Error(
        `장치가 요청 샘플레이트(${params.sampleRate} Hz)를 적용하지 못했습니다(실제 ${actualRate} Hz) — ` +
        "Calibration에서 장치가 지원하는 샘플레이트를 선택하세요."
      );
    }
    if (playback) playCaptureActiveRef.current = true;
    else nativeActiveRef.current = true;
    // 와이어로 나가는 프레임 크기 — 장치가 실제 적용한 bufferSize를 우선한다(sampleRate와
    // 동일한 "actual 우선" 원칙). 이 값이 그대로 init 메시지의 bufferSize로 실려
    // ff_prot_start_exec의 dt 계산에 쓰인다.
    const wireSamplesPerCh = res.actual?.bufferSize ?? params.bufferSize;
    setSampleRate(actualRate);
    setActualBufferSize(res.actual?.bufferSize ?? null);
    setDeviceName(res.device || null);

    const ws = openAnalysisSocket(actualRate, wireSamplesPerCh);

    // 새 캡처 세션 시작 — 이전 세션의 전 채널 버퍼를 교체한다(저장하지 않았다면 여기서 소멸).
    rawCaptureRef.current = { channels: captureChannels, sampleRate: actualRate, frames: [] };
    recordingActiveRef.current = true;
    emitStreamEvent({ type: "reset", channels: captureChannels, sampleRate: actualRate });

    // 5단계 지연 측정 세션 시작 — 이전 세션의 측정 데이터를 버리고 새로 수집한다.
    perf.startSession({
      mode: "native", sampleRate: actualRate, samplesPerCh: wireSamplesPerCh,
      channels: captureChannels, deviceName: res.device || null,
    });

    // 2. Encoding 시작점 — onData(청크 도착)가 찍고, 와이어 프레임이 완성돼 send 직전인
    // 아래 onFrame에서 경과를 잰다. send() 안에서 WASM analyze가 동기 실행되므로 반드시
    // send "이전"에 재야 3단계(WASM)가 섞이지 않는다.
    let encStartAt = 0;
    const reframe = createNativeFrameReframer(
      captureChannels,
      wireSamplesPerCh,
      (frame) => {
        // 재생 일시정지 중에는 분석 프레임을 보내지 않는다 — 소켓 frameCount(차트 시간축)와
        // WASM 온도 누적을 정지 지점에 고정해, 재개 시 시간축이 튀지 않고 그대로 이어지게 한다.
        if (!analysisActiveRef.current) return;
        perf.markFrameSent(encStartAt > 0 ? performance.now() - encStartAt : null);
        // Int16Array.buffer는 ArrayBuffer | SharedArrayBuffer → 명시적 캐스트. outPcm은
        // 재사용하므로 slice(0)로 복사본 전송.
        ws.send((frame.buffer as ArrayBuffer).slice(0));
        ++frameCountRef.current;
      },
      (rawFrame) => {
        // 저장용 원본 버퍼는 recordingActiveRef가 꺼져 있으면(재생 일시정지 중) 쌓지 않는다 —
        // 저장용 원본 버퍼는 recordingActiveRef로, WASM 전송은 analysisActiveRef로 별도 제어된다.
        if (!recordingActiveRef.current) return;
        // outRaw도 재사용 버퍼 → 복사본을 세션 메모리에 축적 (전 채널, 프레임 순서 보존).
        // 채널 뷰 실시간 구독자에게도 같은 복사본을 그대로 흘려보낸다(추가 복사 없음).
        const copy = (rawFrame.buffer as ArrayBuffer).slice(0);
        rawCaptureRef.current?.frames.push(copy);
        emitStreamEvent({ type: "chunk", chunk: copy, channels: captureChannels, sampleRate: actualRate });
      },
    );

    // onData/onEnded 프로토콜은 두 브리지가 동일 — 활성 브리지에만 리스너를 건다.
    const bridge = playback ? window.audioPlayCapture! : window.audioCapture!;
    const offData = bridge.onData((chunk) => {
      if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
      // 1. HW capture — 캡처 콜백 도착 간격(버퍼 채움 시간 근사) + 2. Encoding 시작점.
      perf.markChunkArrival();
      encStartAt = performance.now();
      reframe(chunk);
    });
    const offEnded = bridge.onEnded((info) => {
      if (!isActiveRef.current) return;
      // play-capture의 exit 0 = 재생이 끝까지 도달해 헬퍼가 자기 종료한 것("재생 완료" 신호,
      // 사용자 stop은 main이 ended 이벤트 자체를 억제하므로 여기 오지 않는다) — 에러가 아니다.
      if (playback && info.code === 0) {
        playback.onEnded();
        return;
      }
      // exit 3 = 헬퍼가 kAudioDevicePropertyDeviceIsAlive 리스너로 장치 연결 해제(USB 분리 등)를
      // 감지해 스스로 종료한 것 — 이 신호가 없으면 IOProc이 조용히 멈춰 차트가 얼어붙은 채
      // 사용자가 직접 정지할 때까지 아무 안내도 없었다(mac.swift installDeviceIsAliveListener 참고).
      if (info.code === 3) {
        setMicError("캡처 장치와의 연결이 끊겼습니다(USB 분리 등). 장치를 다시 연결한 뒤 재시작하세요.");
        cleanup();
        onStatusChange("error");
        return;
      }
      setMicError("네이티브 캡처가 예기치 않게 종료되었습니다.");
      cleanup();
      onStatusChange("error");
    });
    nativeOffsRef.current = [offData, offEnded];
  }, [
    nativeOffsRef, nativeActiveRef, playCaptureActiveRef, rawCaptureRef, recordingActiveRef, analysisActiveRef,
    isActiveRef, frameCountRef,
    onStatusChange, setMicError, setSampleRate, setDeviceName,
    setActualBufferSize, openAnalysisSocket, cleanup, emitStreamEvent,
  ]);

  return { start };
}
