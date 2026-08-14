"use client";

/**
 * 아주 작은 값이 "0.0000"으로 뭉개지지 않게 한다 — V/I 센스는 정상 동작 중에도 풀스케일의
 * 1/1000 수준(수십 LSB)에 머무는 일이 흔해서, 고정 소수점 4자리로는 살아있는 신호와 진짜
 * 무음이 화면에서 똑같이 0으로 보였다.
 */
function formatLevel(v: number): string {
  return v > 0 && v < 1e-4 ? v.toExponential(1) : v.toFixed(4);
}

/**
 * 채널 레벨 배지. 샘플은 들어왔는데 피크가 **정확히** 0이면 숫자 대신 경고를 띄운다 —
 * 파형만으로는 "전부 0인 채널"과 "아주 조용한 채널"이 똑같이 평평한 선이라, 센스 배선이
 * 빠졌는지 화면만 보고는 구분할 수 없었다.
 */
export function ChannelLevelBadge({ peak, rms }: { peak: number; rms: number }) {
  if (peak === 0) {
    return (
      <span
        className="ml-auto text-[10px] font-mono text-amber-600"
        title="This channel was exactly zero for the whole session — the sense input is most likely unconnected, or nothing was driving the output."
      >
        no signal (all zeros)
      </span>
    );
  }
  return (
    <span className="ml-auto text-[10px] font-mono text-iron-400">
      {`peak ${formatLevel(peak)} · rms ${formatLevel(rms)}`}
    </span>
  );
}
