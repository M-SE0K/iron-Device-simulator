// perf-e2e/types.ts — N1~N12 E2E 지연 실험 노드 정의. src/features/audio/lib/perf/ (기존 5단계
// 하네스)와는 독립된 별도 수집기다 — docs/e2e-latency-experiment.md 참고.
import type { StatBlock } from "../perf/statistics";

export type E2ENodeId =
  | "N1" | "N2" | "N3" | "N4" | "N5" | "N6"
  | "N7" | "N8" | "N9" | "N10" | "N11" | "N12";

export interface E2ENodeMeta {
  label: string;
  desc: string;
}

export const E2E_NODES: Record<E2ENodeId, E2ENodeMeta> = {
  N1:  { label: "네이티브 IPC 릴레이",     desc: "헬퍼 stdout 수신(Electron main) → renderer bridge.onData 도착 (프로세스 경계, Electron 전용)" },
  N2:  { label: "리프레이밍/인코딩",       desc: "원시 캡처 청크 → 분석 프레임 재구성 (reframeNativeChunk / encodeToInt16)" },
  N3:  { label: "송신→워커 진입",          desc: "ws.send() → dsp-worker onmessage 진입 (메인→워커 스레드 경계, 워커 엔진 경로 전용)" },
  N4:  { label: "워커 배치 큐잉",          desc: "워커 소켓 pendingFrames 적재 → 실제 flush(postMessage) 실행까지 대기 (워커 엔진 경로 전용)" },
  N5:  { label: "엔진 호출(WASM)",         desc: "ff_prot_start_exec 마샬링+호출 구간 (createAnalysisFrame 내부)" },
  N6:  { label: "JS 후처리",              desc: "디인터리브/결과 판독/processedPcm 인코딩 등 — processingMs 중 N5를 제외한 나머지" },
  N7:  { label: "워커→메인 반환",          desc: "워커 postMessage → 메인 onmessage 진입 (워커→메인 스레드 경계, 워커 엔진 경로 전용)" },
  N8:  { label: "메인 파싱",              desc: "소켓 onmessage 진입 → JSON.parse 및 frame 핸들러 진입" },
  N9:  { label: "출력 큐 대기",            desc: "outputQueueRef 적재 → drain() 처리 (drain은 rAF마다 1회이므로 설계상 최대 한 프레임 배치 지연)" },
  N10: { label: "coalesce/detectEvents",  desc: "버킷 다운샘플링(coalesceFrames) + 이벤트 검출(detectEvents) 연산 시간" },
  N11: { label: "차트 커밋 전파",           desc: "ChartStore.flush() → 차트가 uPlot에 setData 커밋 (rAF로 합쳐지므로 최대 한 프레임)" },
  N12: { label: "uPlot 렌더",             desc: "uPlot setData 동기 캔버스 드로우 구간 (paint 전 layout effect에서 측정)" },
};

export interface E2ESample {
  ms: number;
  tag?: string;
}

export type E2EStatBlock = StatBlock;

export interface E2ESessionMeta {
  mode: "native" | "web";
  sampleRate: number;
  samplesPerCh: number;
  channels: number;
  deviceName: string | null;
  engine: "worker" | "main-thread";
}

export interface E2EExport {
  meta: E2ESessionMeta & { startedAt: string };
  nodes: Record<E2ENodeId, E2ENodeMeta>;
  summary: Record<E2ENodeId, E2EStatBlock & { label: string }>;
  raw: Record<E2ENodeId, E2ESample[]>;
}
