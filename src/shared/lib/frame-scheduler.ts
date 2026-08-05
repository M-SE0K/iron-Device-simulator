/**
 * 전역 프레임 스케줄러 — 컴포넌트마다 따로 도는 `requestAnimationFrame` 루프를 하나로 합친다.
 *
 * 데이터가 초당 수백 번 도착하는 경로(캡처 청크, 보호 감쇠 프레임)에서 도착할 때마다 리렌더/
 * 다시 그리기를 하면 화면 주사율보다 훨씬 자주 그리게 된다. 각 소비자는 자기 쪽 변경을
 * `isDirty()`가 true를 돌려주도록 표시만 해두고, 실제 작업은 브라우저가 알려주는 표시 기회
 * (rAF)마다 한 번씩만 `run()`에서 처리한다.
 *
 * 루프를 태스크마다 하나씩 두지 않고 전역 하나로 두는 이유:
 * - 같은 프레임 안에서 phase 순서(compute → draw)가 보장된다. 루프가 따로 돌면 등록 순서와
 *   무관하게 섞여, 계산이 끝나기 전 그리기가 먼저 도는 프레임이 생긴다.
 * - rAF 콜백 자체의 오버헤드와 프레임 경계 분산이 사라진다.
 * - 등록 태스크가 0이 되면 루프가 완전히 멈춘다(백그라운드 탭에서도 rAF는 어차피 멈추지만,
 *   화면이 켜져 있고 할 일만 없는 상태에서도 비용이 0이 된다).
 */

/** 한 프레임 안의 실행 순서. 같은 phase 안에서는 등록 순서를 유지한다. */
export type FramePhase = "compute" | "draw";

export interface FrameTask {
  /** 태스크 식별자. 같은 id로 다시 등록하면 이전 태스크를 대체한다(StrictMode 이중 마운트 대비). */
  id: string;
  phase: FramePhase;
  /** false면 이번 프레임은 통째로 건너뛴다. 부수효과 없이 싸게 유지해야 한다. */
  isDirty: () => boolean;
  run: () => void;
}

const PHASE_ORDER: readonly FramePhase[] = ["compute", "draw"];

class FrameScheduler {
  private readonly tasks = new Map<string, FrameTask>();
  /** phase 순으로 정렬해둔 실행 목록. 등록/해제 때만 다시 만든다. */
  private ordered: FrameTask[] = [];
  private raf = 0;

  /** 태스크를 등록하고 해제 함수를 돌려준다 — `useEffect(() => frameScheduler.register(...), [])` 형태로 쓴다. */
  register(task: FrameTask): () => void {
    this.tasks.set(task.id, task);
    this.reorder();
    this.start();

    return () => {
      // 같은 id로 이미 다른 태스크가 재등록됐다면 그쪽을 지우면 안 된다.
      if (this.tasks.get(task.id) !== task) return;
      this.tasks.delete(task.id);
      this.reorder();
      if (this.tasks.size === 0) this.stop();
    };
  }

  private reorder(): void {
    const next: FrameTask[] = [];
    for (const phase of PHASE_ORDER) {
      for (const task of this.tasks.values()) {
        if (task.phase === phase) next.push(task);
      }
    }
    this.ordered = next;
  }

  private start(): void {
    if (this.raf !== 0) return;
    if (typeof requestAnimationFrame === "undefined") return; // SSR/프리렌더 — 등록만 받아두고 돌지 않는다
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf === 0) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (): void => {
    this.raf = 0;

    // 스냅샷을 돌린다 — run() 안에서 등록/해제가 일어나도 이번 프레임의 순회가 깨지지 않는다.
    const tasks = this.ordered;
    for (const task of tasks) {
      // 순회 도중 해제된 태스크는 실행하지 않는다.
      if (this.tasks.get(task.id) !== task) continue;
      try {
        if (task.isDirty()) task.run();
      } catch (err) {
        // 한 태스크가 던져도 나머지와 루프 자체는 계속 돌아야 한다.
        console.error(`[frameScheduler] task "${task.id}" failed`, err);
      }
    }

    if (this.tasks.size > 0) this.start();
  };
}

export const frameScheduler = new FrameScheduler();
