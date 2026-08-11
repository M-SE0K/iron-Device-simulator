import { INT16_SCALE } from "@/features/audio/lib/engine/core";
import type { CaptureSnapshot } from "@/features/audio/components/player/capture/types";
import type { SeriesReadBuffer } from "./read-buffer";

/**
 * 캡처 세션의 **원본 PCM**에서 [minSec, maxSec] 구간의 한 채널 샘플을 그대로 읽어 온다.
 *
 * 파형 뷰의 2단계 해상도 중 "확대" 쪽 — 엔벨로프(ChannelWaveStore)는 버킷 폭 아래로는
 * 내려가지 못하므로, 픽셀당 샘플 수가 1 근처로 떨어지면 요약본 대신 원본을 직접 읽어야
 * 개별 샘플(48 kHz에서 1샘플 = 20.83 µs)이 보인다. Audition이 축소 뷰에서는 peak file(.pkf)을,
 * 확대 뷰에서는 디스크의 원본을 seek해 읽는 것과 같은 전략이고, 이 앱은 그 "원본"이 이미
 * 메모리에 있다(useCaptureSession의 rawCaptureRef → getCaptureSnapshot).
 *
 * `samplesPerFrame`이 프레임마다 같기 때문에 시각 → 인덱스가 나눗셈 한 번으로 끝난다:
 * 읽는 양이 화면 폭에 묶여 있어 세션이 아무리 길어져도 호출 비용이 늘지 않는다.
 *
 * `snap.frames`는 라이브 세션에서 계속 append되지만 **이미 들어간 원소는 절대 바뀌지
 * 않으므로**(useNativeCapture가 복사본을 push한다) 길이만 진입 시점에 고정하면 그리는
 * 도중 경합이 없다.
 *
 * 결과는 `out`에 채우고 채운 개수를 돌려준다 — 버퍼 소유·재사용 규약은 SeriesReadBuffer 참고.
 */
export function readRawWindow(
  snap: CaptureSnapshot,
  channel: number,
  minSec: number,
  maxSec: number,
  out: SeriesReadBuffer,
): number {
  const { channels, sampleRate, samplesPerFrame, frames } = snap;
  if (!(sampleRate > 0) || samplesPerFrame <= 0) return 0;
  if (channel < 0 || channel >= channels) return 0;

  const frameCount = frames.length;
  if (frameCount === 0) return 0;

  const capacity = Math.min(out.xs.length, out.ys.length);
  if (capacity === 0) return 0;

  const totalSamples = frameCount * samplesPerFrame;
  let start = Number.isFinite(minSec) ? Math.floor(minSec * sampleRate) : 0;
  // 구간 오른쪽 끝 샘플까지 포함하고, 선이 화면 경계에서 끊겨 보이지 않게 한 샘플 더 읽는다.
  let end = Number.isFinite(maxSec) ? Math.ceil(maxSec * sampleRate) + 1 : totalSamples;
  if (start < 0) start = 0;
  if (end > totalSamples) end = totalSamples;
  if (end <= start) return 0;
  if (end - start > capacity) end = start + capacity;

  const step = 1 / sampleRate;
  let frameIdx = Math.floor(start / samplesPerFrame);
  let offset = start - frameIdx * samplesPerFrame;
  let view = new Int16Array(frames[frameIdx]);

  let w = 0;
  for (let s = start; s < end; s++) {
    if (offset >= samplesPerFrame) {
      frameIdx++;
      if (frameIdx >= frameCount) break;
      offset = 0;
      view = new Int16Array(frames[frameIdx]);
    }
    out.xs[w] = s * step;
    out.ys[w] = view[offset * channels + channel] / INT16_SCALE;
    w++;
    offset++;
  }
  return w;
}
