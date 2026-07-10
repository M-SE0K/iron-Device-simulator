// 채널 번호 → 표시 라벨/색상 — ch0=V(전압 센스), ch1=I(전류 센스), ch2 이후는 Calibration에서
// 확장한 예비 채널이라는 프로젝트 공통 규약(ChannelViewerOverlay, ChartDetailOverlay가 공유).

export function channelLabel(ch: number): { name: string; role: string } {
  if (ch === 0) return { name: "CH0", role: "V (전압)" };
  if (ch === 1) return { name: "CH1", role: "I (전류)" };
  return { name: `CH${ch}`, role: "확장" };
}

const CHANNEL_COLORS = ["#0B4171", "#6B9BD1", "#10B981", "#F97316", "#0EA5E9", "#EC4899", "#84CC16", "#F43F5E"];

export function channelColor(ch: number): string {
  return CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
}
