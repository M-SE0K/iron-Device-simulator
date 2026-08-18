import {
  EngineSessionCore,
  type EngineOutput,
  type WorkerRequest,
} from "../protocol/session-core";

const core = new EngineSessionCore();

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data as WorkerRequest;
  if (!data || typeof data !== "object") return;

  if (data.type === "init") {
    void core.init(data.payload, data.wasmBinary).then((msg) => {
      ctx.postMessage({ results: [{ msg, pcm: null }] });
    });
    return;
  }

  if (data.type === "stop") {
    core.stop();
    return;
  }

  if (data.type === "frames") {
    const results: EngineOutput[] = [];
    const transfer: Transferable[] = [];
    for (const buf of data.frames) {
      const out = core.processFrame(buf);
      if (!out) continue;
      results.push(out);
      if (out.pcm) {
        transfer.push(out.pcm.input.buffer, out.pcm.processed.buffer);
      }
    }
    if (results.length > 0) {
      ctx.postMessage({ results }, transfer);
    }
  }
};
