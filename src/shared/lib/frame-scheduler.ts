type FramePhase = "compute" | "draw";

const MAX_DRAW_TASKS_PER_FRAME = 4;

interface FrameTask {
  id: string;
  phase: FramePhase;
  isDirty: () => boolean;
  run: () => void;
}

class FrameScheduler {
  private readonly tasks = new Map<string, FrameTask>();
  private computeOrdered: FrameTask[] = [];
  private drawOrdered: FrameTask[] = [];
  private drawCursor = 0;
  private raf = 0;

  register(task: FrameTask): () => void {
    this.tasks.set(task.id, task);
    this.reorder();
    this.start();

    return () => {
      if (this.tasks.get(task.id) !== task) return;
      this.tasks.delete(task.id);
      this.reorder();
      if (this.tasks.size === 0) this.stop();
    };
  }

  private reorder(): void {
    const compute: FrameTask[] = [];
    const draw: FrameTask[] = [];
    for (const task of this.tasks.values()) {
      (task.phase === "compute" ? compute : draw).push(task);
    }
    this.computeOrdered = compute;
    this.drawOrdered = draw;
  }

  private start(): void {
    if (this.raf !== 0) return;
    if (typeof requestAnimationFrame === "undefined") return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf === 0) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (): void => {
    this.raf = 0;

    const compute = this.computeOrdered;
    for (const task of compute) {
      if (this.tasks.get(task.id) !== task) continue;
      try {
        if (task.isDirty()) task.run();
      } catch (err) {
        console.error(`[frameScheduler] task "${task.id}" failed`, err);
      }
    }

    const draw = this.drawOrdered;
    const n = draw.length;
    let executed = 0;
    for (let step = 0; step < n; step++) {
      const idx = (this.drawCursor + step) % n;
      const task = draw[idx];
      if (this.tasks.get(task.id) !== task) continue;
      try {
        if (!task.isDirty()) continue;
        if (executed === MAX_DRAW_TASKS_PER_FRAME) {
          this.drawCursor = idx;
          break;
        }
        task.run();
        executed++;
      } catch (err) {
        console.error(`[frameScheduler] task "${task.id}" failed`, err);
      }
    }

    if (this.tasks.size > 0) this.start();
  };
}

export const frameScheduler = new FrameScheduler();
