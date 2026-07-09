// coalesce/detectEvents가 공유하는 출력 큐 프레임 타입 정의.
import type { AnalysisFrame } from "../../types";

/** 출력 큐(DashboardClient)에 잠시 쌓아두는 단위 — coalesce/detectEvents 공용 입력 타입 */
export interface QueuedFrame {
  frame: AnalysisFrame;
  recvAt: number;
}
