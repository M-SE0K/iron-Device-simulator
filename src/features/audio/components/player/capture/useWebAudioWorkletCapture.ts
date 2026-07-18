"use client";

// 웹 getUserMedia + AudioWorklet 캡처 경로 (네이티브 브리지가 없는 웹/모바일 폴백).
// BufferSize는 캡처를 여는 Chromium이 주인이라 강제할 수 없고, latency 제약으로
// 힌트만 전달한다(반영 보장 없음 — 진짜 제어는 useNativeCapture 경로).
import { useCallback, type MutableRefObject } from "react";
import { perf } from "@/features/audio/lib/perf/collector";
import type { SocketLike } from "@/features/audio/lib/engine/protocol/local-socket";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";

export interface WebCaptureParams {
  sampleRate: number;
  bufferSize: number;
  /** calibration.inputDeviceId — 빈 문자열이면 시스템 기본 입력 */
  inputDeviceId: string;
  /** calibration.inputDeviceLabel — 실제 장치 라벨을 못 얻었을 때의 표시용 폴백 */
  inputDeviceLabel: string;
}

export interface WebCaptureDeps {
  audioCtxRef: MutableRefObject<AudioContext | null>;
  streamRef: MutableRefObject<MediaStream | null>;
  workletRef: MutableRefObject<AudioWorkletNode | null>;
  /**
   * true인 동안만 분석 소켓(WASM)에 프레임을 보낸다 — 재생 일시정지 중에는 꺼서 소켓
   * frameCount(= 차트 시간축)와 WASM 온도 누적을 정지 지점에 고정한다(재개 시 끊김 없이 이어짐).
   */
  analysisActiveRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  frameCountRef: MutableRefObject<number>;
  setSampleRate: (v: number | null) => void;
  setDeviceName: (v: string | null) => void;
  setActualBufferSize: (v: number | null) => void;
  setActualLatency: (v: number | null) => void;
  openAnalysisSocket: (actualRate: number, samplesPerCh: number) => SocketLike;
}

export function useWebAudioWorkletCapture(deps: WebCaptureDeps) {
  const {
    audioCtxRef, streamRef, workletRef, analysisActiveRef, isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  } = deps;

  const start = useCallback(async (params: WebCaptureParams) => {
    const latencyHint = params.bufferSize / params.sampleRate;

    // 1) 마이크 권한 요청
    // latency는 lib.dom.d.ts의 MediaTrackConstraints에 아직 없어(신규/실험적 제약) 캐스팅한다.
    const audioConstraints: MediaTrackConstraints & { latency?: ConstrainDouble } = {
      channelCount:     2,
      sampleRate:       { ideal: params.sampleRate },
      latency:          { ideal: latencyHint },
      echoCancellation: false, // 스피커 보호 분석 — 원음 필요
      noiseSuppression: false,
      autoGainControl:  false,
    };
    // 캘리브레이션에서 특정 입력 장치를 골랐으면 그 장치로 정확히 캡처(exact) — 미지정 시 기본 장치.
    if (params.inputDeviceId) {
      audioConstraints.deviceId = { exact: params.inputDeviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    streamRef.current = stream;
    setDeviceName(stream.getAudioTracks()[0]?.label || params.inputDeviceLabel || null);

    // 실제 협상된 latency 확인(요청이 그대로 반영됐다는 보장은 없음 — 참고용 표시)
    const trackSettings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
    setActualLatency(trackSettings?.latency ?? null);

    // 2) AudioContext 생성 (실제 샘플레이트 확인)
    const ctx           = new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const actualRate    = ctx.sampleRate;
    setSampleRate(actualRate);

    // 3) AudioWorklet 로드 — bufferSize를 processorOptions로 전달해 워클릿이 그 샘플 수
    // 단위로 청킹하게 한다. sampleRate/latency와 달리 이건 브라우저가 협상하는 값이 아니라
    // 워클릿 코드가 그대로 지키는 값이므로(mic-processor.js), 화면에도 요청값 그대로 표시한다.
    await ctx.audioWorklet.addModule("/mic-processor.js");
    const worklet = new AudioWorkletNode(ctx, "mic-processor", {
      processorOptions: { samplesPerCh: params.bufferSize },
    });
    workletRef.current = worklet;
    setActualBufferSize(params.bufferSize);

    // 4) MediaStream → Worklet → 무음 GainNode (destination 필요, 스피커 출력 방지)
    const source      = ctx.createMediaStreamSource(stream);
    const silentGain  = ctx.createGain();
    silentGain.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(ctx.destination);

    // 5) 분석 소켓 연결 (브라우저 WASM 엔진, LocalWasmSocket)
    const ws = openAnalysisSocket(actualRate, params.bufferSize);

    // 5단계 지연 측정 세션 시작 — 이전 세션의 측정 데이터를 버리고 새로 수집한다.
    perf.startSession({
      mode: "web", sampleRate: actualRate, samplesPerCh: params.bufferSize,
      channels: 2, deviceName: stream.getAudioTracks()[0]?.label || params.inputDeviceLabel || null,
    });

    // 6) Worklet 프레임 → WebSocket 전송
    worklet.port.onmessage = (e: MessageEvent<{ L: Float32Array; R: Float32Array }>) => {
      if (!isActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
      // 1. HW capture — 워클릿 메시지 도착 간격(버퍼 채움 시간 근사). 일시정지 체크보다
      // 먼저 찍어야 재개 첫 프레임에 정지 시간만큼의 outlier가 실리지 않는다(네이티브 경로 동일).
      perf.markChunkArrival();
      // 재생 일시정지 중에는 분석 프레임을 보내지 않는다 — 소켓 frameCount(차트 시간축)와
      // WASM 온도 누적을 정지 지점에 고정해, 재개 시 시간축이 튀지 않고 그대로 이어지게 한다.
      if (!analysisActiveRef.current) return;

      // 2. Encoding — Float32 → int16 인터리브 패킹. 워클릿은 메시지 1개 = 와이어 프레임
      // 1개라 send 직전 그대로 페어링된다.
      const encStartAt = performance.now();
      const interleaved = encodeToInt16(e.data.L, e.data.R);
      perf.markFrameSent(performance.now() - encStartAt);
      ws.send(interleaved.buffer as ArrayBuffer);
      ++frameCountRef.current;
    };
  }, [
    audioCtxRef, streamRef, workletRef, analysisActiveRef, isActiveRef, frameCountRef,
    setSampleRate, setDeviceName, setActualBufferSize, setActualLatency,
    openAnalysisSocket,
  ]);

  return { start };
}
