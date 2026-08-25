import { humanizeIpcError } from "@/shared/lib/ipc-error";

/** 자극은 항상 인터리브 스테레오다(--stream 은 refChannels 개념 없이 2ch 고정). */
const WIRE_CHANNELS = 2;
/** 한 번의 writePcm 상한 — IPC 페이로드가 지나치게 커지지 않게만 자른다. */
const MAX_WRITE_FRAMES = 16384;

type PlayCaptureBridge = NonNullable<Window["audioPlayCapture"]>;

/** --stream 경로 자극 펌프.
 *
 * 헬퍼의 재생 링은 유한하고(mac.swift: max(prefill×8, 1 s)), 넘치면 헬퍼 stdin 스레드가
 * usleep 루프에 들어가 Rust 쪽 write_all 이 파이프에서 막힌다. 그래서 대시보드의 보호 재생
 * (useNativeCapture)과 같은 self-clocking 규약을 쓴다 — 수신한 캡처 프레임 수를 크레딧으로
 * 삼아 항상 leadFrames 만큼만 앞서 보낸다. 단일 클록이라 "캡처 프레임 수 ≒ 재생 위치"이므로
 * (sent − captured) 가 곧 링 백로그의 상한 추정이다.
 *
 * 여기서 보내는 것은 "합성한 자극 그대로"다 — 대시보드와 달리 엔진(ff_prot)을 거치지 않는다.
 * 측정 대상이 스트림 경로 자체이지 보호 알고리즘이 아니기 때문이다.
 */
export class LoopbackStreamPump {
  private readonly totalFrames: number;
  private sent = 0;
  private target = 0;
  private inFlight = false;
  private endSent = false;
  private stopped = false;

  constructor(
    private readonly bridge: PlayCaptureBridge,
    private readonly pcm: Int16Array,
    private readonly leadFrames: number,
    private readonly onFailure: (error: Error) => void,
  ) {
    this.totalFrames = Math.floor(pcm.length / WIRE_CHANNELS);
  }

  get sentFrames(): number {
    return this.sent;
  }

  get completed(): boolean {
    return this.sent >= this.totalFrames;
  }

  /** IOProc 시작 게이트(프리필)를 열기 위한 최초 푸시 — start() 직후 한 번. */
  prime(): void {
    this.pumpTo(0);
  }

  /** 캡처 프레임 수를 크레딧으로 목표 전송 위치를 밀어 올린다. */
  pumpTo(capturedFrames: number): void {
    const next = Math.min(this.totalFrames, capturedFrames + this.leadFrames);
    if (next > this.target) this.target = next;
    this.drain();
  }

  /** 측정 중단 — 이후 어떤 write/end 도 내보내지 않는다(헬퍼는 호출부가 stop 한다). */
  abort(): void {
    this.stopped = true;
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onFailure(error);
  }

  private drain(): void {
    if (this.stopped || this.inFlight) return;

    if (this.sent < this.target) {
      const frames = Math.min(MAX_WRITE_FRAMES, this.target - this.sent);
      const chunk = this.pcm.subarray(this.sent * WIRE_CHANNELS, (this.sent + frames) * WIRE_CHANNELS);
      this.sent += frames;
      this.inFlight = true;
      void this.bridge
        .writePcm(chunk)
        .then((res) => {
          if (!res.success) this.fail(new Error(humanizeIpcError(res.error, "Failed to stream the stimulus to the helper.")));
        })
        .catch((err: unknown) => this.fail(err instanceof Error ? err : new Error(String(err))))
        .finally(() => {
          this.inFlight = false;
          this.drain();
        });
      return;
    }

    /* 자극을 다 보냈으면 end 로 링의 끝을 알린다 — 헬퍼는 링을 마저 비우고 0.25 s 테일까지
     * 캡처한 뒤 exit 0 한다. 이 신호가 없으면 영원히 재생 중으로 남아 워치독에 걸린다. */
    if (this.completed && !this.endSent) {
      this.endSent = true;
      void this.bridge
        .control("end")
        .then((res) => {
          if (!res.success) this.fail(new Error(humanizeIpcError(res.error, "Failed to close the stimulus stream.")));
        })
        .catch((err: unknown) => this.fail(err instanceof Error ? err : new Error(String(err))));
    }
  }
}
