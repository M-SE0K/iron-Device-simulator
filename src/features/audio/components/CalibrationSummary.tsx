"use client";

// 오디오 파일 타이틀 영역에 표시하는 캘리브레이션 적용 상태 배지(작은 글씨).
// Calibration View(드로어)에서 선택·적용한 모델/파라미터가 현재 분석에 반영되었음을
// 사용자에게 명시적으로 알린다. 값은 전역 CalibrationProvider(단일 소스)를 그대로 읽는다.
import { SlidersHorizontal } from "lucide-react";
import { useCalibration } from "@/features/audio/lib/calibration-context";
import { cn } from "@/shared/lib/utils";

export default function CalibrationSummary({ className }: { className?: string }) {
  const { values } = useCalibration();
  const applied = values.speakerModel !== "";

  return (
    <p
      className={cn(
        "mt-1 flex items-center gap-1 text-[11px] leading-tight truncate",
        applied ? "text-brand-blue" : "text-amber-600",
        className,
      )}
      title={
        applied
          ? `Calibration 적용됨 — 모델 ${values.speakerModel}, 출력 ${values.ampOutputPower || "—"}W (주변온도 ${values.ambientTemp || "—"}°C는 라이브러리 연동 예정)`
          : "Calibration View에서 스피커 모델을 선택하지 않아 기본 프로파일로 분석됩니다"
      }
    >
      <SlidersHorizontal className="w-3 h-3 shrink-0" />
      {applied ? (
        <span className="truncate">
          <span className="font-semibold">{values.speakerModel}</span>
          <span className="text-iron-400"> · </span>
          {values.ampOutputPower || "—"}W
          <span className="text-iron-400"> 적용됨 · </span>
          {values.ambientTemp || "—"}°C
          <span className="text-iron-400"> (예정)</span>
        </span>
      ) : (
        <span className="truncate">모델 미선택 · 기본 프로파일로 분석</span>
      )}
    </p>
  );
}
