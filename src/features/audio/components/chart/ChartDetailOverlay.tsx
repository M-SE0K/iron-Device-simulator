"use client";

// 차트 상세(자세히 보기) 뷰 — 대시보드에서 특정 차트의 확대 버튼을 누르면 전체 화면 페이지처럼
// 전환된다(별도 라우트가 아니라 DashboardClient가 소유한 라이브 데이터를 그대로 재사용하는
// 오버레이 — 정적 export/모바일 셸에서도 동작하고 재생 중 실시간 갱신을 유지한다).
// 큰 차트(기존 Temperature/Excursion 컴포넌트 재사용) + 라이브 통계 타일로 구성.
import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, Thermometer, X } from "lucide-react";
import type { AnalysisFrame } from "@/features/audio/types";
import { findFrameIndex, formatTime } from "@/shared/lib/utils";
import TemperatureChart from "./TemperatureChart";
import ExcursionChart from "./ExcursionChart";

export type DetailMetric = "temperature" | "excursion";

interface Props {
  metric: DetailMetric;
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  audioDuration?: number | null;
  followWindow?: boolean;
  lttb?: boolean;
  /** temperature 상세 뷰의 WARN/DANGER markLine — Calibration.tempWarn/tempDanger */
  warnThreshold?: number;
  dangerThreshold?: number;
  onClose: () => void;
}

// 익스커션 raw → mm (ExcursionChart와 동일 계수)
const MM_SCALE = 1 / 1000;

function StatTile({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-iron-100 bg-white px-3 py-2 min-w-[92px]">
      <span className="text-[10px] uppercase tracking-wider text-iron-400">{label}</span>
      <span className="font-mono text-lg font-semibold leading-none" style={accent ? { color: accent } : undefined}>
        {value}
        {unit && <span className="ml-0.5 text-xs font-normal text-iron-400">{unit}</span>}
      </span>
    </div>
  );
}

export default function ChartDetailOverlay({
  metric,
  frames,
  currentTime,
  isActive,
  audioDuration,
  followWindow,
  lttb,
  warnThreshold,
  dangerThreshold,
  onClose,
}: Props) {
  const isTemp = metric === "temperature";
  const unit = isTemp ? "°C" : "mm";
  const title = isTemp ? "Speaker Temperature" : "Cone Excursion";
  const subtitle = isTemp ? "스피커 온도 상세" : "콘 변위(익스커션) 상세";
  const Icon = isTemp ? Thermometer : Activity;
  const accent = isTemp ? "#0057B8" : "#10B981";
  const accentR = isTemp ? "#7C3AED" : "#F97316";

  // 진입/이탈 애니메이션 (페이지 전환 느낌) — 마운트 후 show=true, 닫을 때 트랜지션 후 언마운트
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const close = () => {
    setShow(false);
    window.setTimeout(onClose, 250);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 선택 metric 통계 (현재값 L/R + 전체 구간 최대/최소/평균, 두 채널 결합)
  const stats = useMemo(() => {
    const conv = (v: number) => (isTemp ? v : v * MM_SCALE);
    const pick = (f: AnalysisFrame) => (isTemp ? f.temperature : f.excursion);
    if (frames.length === 0) {
      return { curL: null as number | null, curR: null as number | null, max: null as number | null, min: null as number | null, avg: null as number | null };
    }
    let max = -Infinity, min = Infinity, sum = 0, count = 0;
    for (const f of frames) {
      const [a, b] = pick(f);
      if (a > max) max = a; if (b > max) max = b;
      if (a < min) min = a; if (b < min) min = b;
      sum += a + b; count += 2;
    }
    const idx = findFrameIndex(frames.map((f) => f.time), currentTime);
    const cur = idx >= 0 && idx < frames.length ? pick(frames[idx]) : null;
    return {
      curL: cur ? conv(cur[0]) : null,
      curR: cur ? conv(cur[1]) : null,
      max: conv(max),
      min: conv(min),
      avg: conv(sum / count),
    };
  }, [frames, currentTime, isTemp]);

  const fmt = (v: number | null) => (v == null ? "—" : isTemp ? v.toFixed(1) : v.toFixed(3));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title} 자세히 보기`}
      className={`fixed inset-0 z-[60] flex flex-col bg-iron-50 transition-all duration-300 ease-out ${
        show ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* 상단 바 */}
      <header className="shrink-0 h-14 px-3 sm:px-5 flex items-center gap-3 border-b border-iron-100 bg-white">
        <button
          type="button"
          onClick={close}
          aria-label="대시보드로 돌아가기"
          className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-sm text-iron-600 hover:bg-iron-100 hover:text-iron-900 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">뒤로</span>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={16} style={{ color: accent }} className="shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-iron-900 truncate">{title}</span>
            <span className="text-[11px] text-iron-400 truncate">{subtitle}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="닫기"
          className="ml-auto flex items-center justify-center w-9 h-9 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* 통계 타일 */}
      <div className="shrink-0 px-3 sm:px-5 py-3 flex flex-wrap items-center gap-2 border-b border-iron-100 bg-white/60">
        <StatTile label="현재 L" value={fmt(stats.curL)} unit={unit} accent={accent} />
        <StatTile label="현재 R" value={fmt(stats.curR)} unit={unit} accent={accentR} />
        <div className="w-px h-8 bg-iron-100 mx-1 hidden sm:block" />
        <StatTile label="최대" value={fmt(stats.max)} unit={unit} />
        <StatTile label="평균" value={fmt(stats.avg)} unit={unit} />
        <StatTile label="최소" value={fmt(stats.min)} unit={unit} />
        <div className="ml-auto text-xs font-mono text-iron-400">
          t = {formatTime(currentTime)} · {frames.length.toLocaleString()} frames
        </div>
      </div>

      {/* 큰 차트 (기존 컴포넌트 재사용, 라이브 데이터 그대로) */}
      <div className="flex-1 min-h-0 p-3 sm:p-5">
        {isTemp ? (
          <TemperatureChart
            frames={frames}
            currentTime={currentTime}
            isActive={isActive}
            streaming
            audioDuration={audioDuration}
            followWindow={followWindow}
            lttb={lttb}
            warnThreshold={warnThreshold}
            dangerThreshold={dangerThreshold}
          />
        ) : (
          <ExcursionChart
            frames={frames}
            currentTime={currentTime}
            isActive={isActive}
            streaming
            audioDuration={audioDuration}
            followWindow={followWindow}
            lttb={lttb}
          />
        )}
      </div>
    </div>
  );
}
