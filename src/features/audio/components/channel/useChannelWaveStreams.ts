"use client";

// 캡처 세션의 원본 채널 파형 스트리밍 관리 — 대시보드의 View 탭/동적 채널 카드가 쓰는 공용
// 훅이다. 채널별 ChannelWaveStore를 소유하고, 선택 시점의 1회 백필(getChannelsSnapshot) +
// 라이브 청크 구독(subscribeChannelStream)으로 스토어를 채운다. 파형 데이터 자체는 React
// 상태를 거치지 않는다 — 상태는 헤더(채널 수/샘플레이트)뿐이다.
import { useCallback, useEffect, useRef, useState } from "react";
import { BYTES_PER_SAMPLE, INT16_SCALE } from "@/features/audio/lib/engine/core";
import { yieldToMain } from "@/shared/lib/yield-to-main";
import type {
  CaptureSnapshot,
  CaptureStreamEvent,
  CaptureStreamListener,
} from "@/features/audio/components/player/capture/types";
import { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";

/**
 * 백필 루프가 메인 스레드를 한 번에 붙잡는 시간 예산(ms). 캡처 콜백 주기(48 kHz/480
 * samples 기준 10 ms)의 절반 이하로 잡아, 예산을 넘겨 양보하는 시점까지 캡처 콜백이 최악
 * 경우에도 그 주기를 넘게 기다리지 않도록 한다. 이 예산을 넘기면 지금까지 쌓인 버킷을
 * flush하고 yieldToMain()으로 한 프레임 양보한 뒤 이어간다.
 */
const SLICE_BUDGET_MS = 4;

/**
 * 채널 뷰 헤더 — WavHeader 전체가 아니라 UI/축 계산에 필요한 만큼만 들고 있는다.
 * 세션 길이는 여기 두지 않는다: 청크마다 늘어나는 값이라 상태로 두면 초당 100번 리렌더가
 * 되고, 필요한 쪽(채널 파형)은 스토어 스냅샷에서 직접 읽는다.
 */
export interface ChannelStreamHeader {
  channels: number;
  sampleRate: number;
}

interface Options {
  /** 표시 중인 채널 인덱스(오름차순) — 여기 포함된 채널만 스토어/백필이 유지된다. */
  wantedChannels: number[];
  /** 캡처 청크 스트림을 구독할 조건 — 뷰/드로어가 열려 있거나 채널이 선택된 동안. */
  listen: boolean;
  /** true인 동안 헤더를 스냅샷으로 1회 확인한다(뷰를 여는 시점의 채널 목록 즉시 표시용). */
  probe: boolean;
  getChannelsSnapshot?: () => CaptureSnapshot | null;
  subscribeChannelStream?: (fn: CaptureStreamListener) => () => void;
  /** 세션 리셋(reset 이벤트) 직후 호출 — 호출부의 세션 단위 상태(자동 선택 등) 초기화용. */
  onSessionReset?: () => void;
}

export function useChannelWaveStreams({
  wantedChannels,
  listen,
  probe,
  getChannelsSnapshot,
  subscribeChannelStream,
  onSessionReset,
}: Options) {
  const [header, setHeader] = useState<ChannelStreamHeader | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);

  // 채널별 표시 스토어. 메인 차트의 ChartStore와 같은 역할이라 React 상태가 아니라 ref다 —
  // 청크가 도착해도 setState 없이 스토어가 직접 구독자(차트)에게 알린다.
  const storesRef = useRef<Map<number, ChannelWaveStore>>(new Map());
  const getStore = useCallback((ch: number): ChannelWaveStore => {
    let waveStore = storesRef.current.get(ch);
    if (!waveStore) {
      waveStore = new ChannelWaveStore();
      storesRef.current.set(ch, waveStore);
    }
    return waveStore;
  }, []);

  // 현재 렌더의 wantedChannels를 청크 콜백(안정된 참조로 한 번만 구독)이 항상 최신으로
  // 읽을 수 있게 ref로 미러링한다 — 매 청크마다 구독을 재생성하지 않기 위함.
  const wantedChannelsRef = useRef<number[]>(wantedChannels);
  useEffect(() => { wantedChannelsRef.current = wantedChannels; }, [wantedChannels]);
  const onSessionResetRef = useRef(onSessionReset);
  onSessionResetRef.current = onSessionReset;
  // 세션 누적 프레임 수 — 청크가 들어올 때마다 늘어나며, durationSec = 이 값/sampleRate.
  const totalFramesRef = useRef(0);
  // 이미 세션 시작~현재를 백필(seed)한 채널 집합 — 한 번만 백필하고, 그 뒤로는 청크 push로만
  // 이어붙인다.
  const seededRef = useRef<Set<number>>(new Set());
  // 세션 세대 토큰 — 리셋 때 올려서, 진행 중이던 백필이 새 세션 스토어에 옛 데이터를 흘려
  // 넣지 못하게 한다.
  const sessionTokenRef = useRef(0);
  // 라이브 청크를 채널별 평면 샘플로 풀어낼 때 쓰는 재사용 버퍼 — 청크마다(초당 100회)
  // 채널 수만큼 새 Float32Array를 만들지 않기 위함이다. addBlock()은 값을 즉시 버킷으로
  // 소화하고 배열 참조를 보관하지 않으므로 채널 사이에 돌려 써도 안전하다(백필 루프가
  // 쓰는 scratch와 같은 규약).
  const chunkScratchRef = useRef<Float32Array>(new Float32Array(0));

  // 선택 해제된 채널은 스토어/시드 여부를 지워 메모리를 되돌린다 — 나중에 다시 선택되면
  // 처음 선택했을 때와 동일하게 세션 전체를 다시 백필한다.
  useEffect(() => {
    const wantedSet = new Set(wantedChannels);
    for (const ch of seededRef.current) {
      if (!wantedSet.has(ch)) seededRef.current.delete(ch);
    }
    for (const ch of storesRef.current.keys()) {
      if (!wantedSet.has(ch)) storesRef.current.delete(ch);
    }
  }, [wantedChannels]);

  // 캡처 청크가 들어올 때마다 즉시 호출된다(Temperature/Excursion과 동일한 push 타이밍) —
  // 선택된 채널의 새 샘플을 세션 시각 그대로 스토어에 넣는다. 폴링도, React 커밋도 없다.
  const handleChunk = useCallback((chunk: ArrayBuffer, channels: number, sampleRate: number) => {
    const bytesPerFrame = channels * BYTES_PER_SAMPLE;
    const frameCount = Math.floor(chunk.byteLength / bytesPerFrame);
    if (frameCount === 0) return;
    const startSec = totalFramesRef.current / sampleRate;
    totalFramesRef.current += frameCount;
    // 채널 수/샘플레이트가 그대로면 같은 객체를 돌려줘 리렌더를 건너뛴다 — 세션 길이는
    // 헤더에 담지 않으므로 이 setState는 세션당 사실상 한 번만 실제 갱신된다.
    setHeader((prev) => (
      prev && prev.channels === channels && prev.sampleRate === sampleRate
        ? prev
        : { channels, sampleRate }
    ));

    const wanted = wantedChannelsRef.current;
    if (wanted.length === 0) return;

    const view = new DataView(chunk);
    // 프레임 수가 바뀔 때만 다시 잡는다 — 헬퍼가 고정 크기로 보내므로 세션당 사실상 한 번이다.
    let samples = chunkScratchRef.current;
    if (samples.length !== frameCount) {
      samples = new Float32Array(frameCount);
      chunkScratchRef.current = samples;
    }
    for (const ch of wanted) {
      if (ch >= channels) continue;
      const waveStore = getStore(ch);
      for (let i = 0; i < frameCount; i++) {
        samples[i] = view.getInt16(i * bytesPerFrame + ch * BYTES_PER_SAMPLE, true) / INT16_SCALE;
      }
      waveStore.addBlock(samples, startSec, sampleRate);
      waveStore.flush();
    }
  }, [getStore]);

  const handleStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    if (ev.type === "reset") {
      sessionTokenRef.current += 1; // 진행 중이던 백필 무효화 — 새 세션은 0부터 라이브로만 채운다
      totalFramesRef.current = 0;
      seededRef.current.clear();
      storesRef.current.forEach((waveStore) => waveStore.reset());
      setChannelError(null);
      setHeader({ channels: ev.channels, sampleRate: ev.sampleRate });
      onSessionResetRef.current?.();
      return;
    }
    // "protected"(보호 감쇠 PCM)는 이 훅의 관심사가 아니다 — 원본 채널 파형만 그린다.
    if (ev.type !== "chunk") return;
    handleChunk(ev.chunk, ev.channels, ev.sampleRate);
  }, [handleChunk]);

  // 채널 뷰가 필요한 동안(listen) 원본 캡처 청크 스트림을 구독한다 — setInterval로 Blob을
  // 다시 열어보는 폴링이 아니라 청크 도착 즉시 push되는 경로다.
  useEffect(() => {
    if (!subscribeChannelStream || !listen) return;
    return subscribeChannelStream(handleStreamEvent);
  }, [subscribeChannelStream, listen, handleStreamEvent]);

  // 뷰를 열었을 때 채널 목록/길이를 즉시 보여주기 위한 1회성 헤더 확인 — 그 뒤로는
  // 위 구독이 청크가 들어올 때마다 header를 계속 최신으로 유지한다. 스냅샷은 복사 없이
  // ref를 그대로 읽으므로(useCaptureSession.getCaptureSnapshot) 동기로 끝난다.
  useEffect(() => {
    if (!probe || !getChannelsSnapshot) return;
    const snap = getChannelsSnapshot();
    if (!snap) return;
    if (totalFramesRef.current === 0) totalFramesRef.current = snap.totalFrames;
    setHeader((prev) => (
      prev && prev.channels === snap.channels && prev.sampleRate === snap.sampleRate
        ? prev
        : { channels: snap.channels, sampleRate: snap.sampleRate }
    ));
  }, [probe, getChannelsSnapshot]);

  // 채널을 새로 선택한 순간 — 청크 스트림에는 "지금부터"만 쌓이므로, 세션 시작부터 지금까지를
  // getChannelsSnapshot()에서 딱 한 번 백필한다. 스토어는 버킷을 절대 시각으로 찾으므로 백필이
  // 진행되는 동안 도착한 라이브 청크(항상 백필 구간보다 뒤의 시각)와 섞여도 서로 덮어쓰지 않는다.
  //
  // 백필은 이펙트가 아니라 **배치 단위**로 살아 있다(대개 채널 1개 = 배치 1개 — 체크박스가
  // 한 번에 하나씩 토글되므로). 다른 채널을 추가로 선택했다고 진행 중인 배치를 취소해버리면
  // 그 채널의 앞부분이 영영 비게 된다(이미 seed 완료로 표시된 뒤라 재시도도 안 된다) — 그래서
  // 새 채널은 별도의 새 배치(이펙트 재실행)로 처리하고, 진행 중이던 배치는 그대로 둔다.
  // 중단 조건은 두 가지뿐: 배치 안의 채널이 선택 해제됐거나(스토어가 지워짐), 세션이
  // 리셋됐거나(토큰 변경) — stale()이 매 양보 지점마다 이 둘을 확인한다.
  useEffect(() => {
    const batch = wantedChannels.filter((ch) => !seededRef.current.has(ch));
    if (batch.length === 0 || !getChannelsSnapshot) return;
    batch.forEach((ch) => seededRef.current.add(ch)); // 재진입 방지 — 실패해도 라이브로는 계속 그린다

    const token = sessionTokenRef.current;
    const targets = batch.map((ch) => [ch, getStore(ch)] as const);
    // 스토어 인스턴스까지 비교한다 — 백필 중 해제했다가 다시 선택하면 새 스토어 + 새 배치가
    // 뜨므로, 옛 배치는 자기 채널의 스토어가 더 이상 현역이 아님을 보고 조용히 물러난다.
    const stale = () =>
      sessionTokenRef.current !== token
      || targets.some(([ch, s]) => storesRef.current.get(ch) !== s);

    (async () => {
      // 스냅샷은 복사 없이 rawCaptureRef.frames를 그대로 참조한다 — frames.length는
      // 이후에도 라이브 청크로 계속 자라지만, frames.length(스냅샷 시점)는 지금 이 호출
      // 시점의 값으로 고정해 둔다. 백필은 "지금까지"만 채우고, 그 이후 도착분은 라이브
      // 청크 경로(handleChunk)가 이어받으므로 이중 반영이나 누락이 없다.
      const snap = getChannelsSnapshot();
      if (!snap) return;
      const { channels, sampleRate, samplesPerFrame, frames } = snap;
      const liveTargets = targets.filter(([ch]) => ch < channels);
      if (liveTargets.length === 0) return;

      // 데이터는 인터리브라 프레임 하나를 읽으면 그 프레임의 모든 채널이 이미 손안에
      // 있다 — 프레임이 바깥, 채널이 안쪽이라야 배치 안의 채널 수만큼 같은 구간을
      // 중복해서 다시 훑지 않는다(예: ch0·ch1을 동시에 볼 때 절반으로 줄어든다).
      // scratch는 배치 전체에서 재사용 — 프레임마다 새 Float32Array를 할당하지 않는다.
      const scratch = new Float32Array(samplesPerFrame);
      const frameCount = frames.length;
      let deadline = performance.now() + SLICE_BUDGET_MS;

      for (let fi = 0; fi < frameCount; fi++) {
        const view = new Int16Array(frames[fi]);
        const startSec = (fi * samplesPerFrame) / sampleRate;
        for (const [ch, waveStore] of liveTargets) {
          for (let i = 0; i < samplesPerFrame; i++) {
            scratch[i] = view[i * channels + ch] / INT16_SCALE;
          }
          waveStore.addBlock(scratch, startSec, sampleRate);
        }
        // 시간 예산을 넘기면 지금까지 쌓인 걸 화면에 반영하고 한 프레임 양보한다 — 그
        // 사이 도착한 캡처 IPC 콜백(WASM 분석·차트 커밋)이 처리될 틈을 준다.
        if (performance.now() >= deadline) {
          liveTargets.forEach(([, s]) => s.flush());
          await yieldToMain();
          if (stale()) return;
          deadline = performance.now() + SLICE_BUDGET_MS;
        }
      }
      liveTargets.forEach(([, s]) => s.flush());

      if (sessionTokenRef.current !== token) return;
      setHeader((prev) => (
        prev && prev.channels === channels && prev.sampleRate === sampleRate
          ? prev
          : { channels, sampleRate }
      ));
    })();
  }, [wantedChannels, getChannelsSnapshot, getStore]);

  return { header, channelError, getStore };
}
