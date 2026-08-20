"use client";

import { AlertTriangle } from "lucide-react";
import { TEMP_OVERFLOW_LIMIT_C } from "@/features/audio/lib/engine/core";

interface Props {
  message: string;
  detail?: string;
}

/* 차트 카드의 chart-body 안에 얹는 경고 배지. 전역 ErrorPopupModal 과 달리 화면을 막지 않고,
 * 어느 차트가 왜 0 으로 깔렸는지를 그 차트 위에서 바로 보여준다. 부모 chart-body 는
 * `relative` 여야 한다(MetricChartCard / ChannelChartCard 가 지정). */
export default function ChartAlertOverlay({ message, detail }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center p-3">
      <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50/95 px-3 py-1.5 shadow-sm backdrop-blur-[1px]">
        <AlertTriangle className="w-4 h-4 shrink-0 text-red-500" />
        <span className="text-xs font-semibold text-red-700">{message}</span>
        {detail && <span className="text-[11px] text-red-500">{detail}</span>}
      </div>
    </div>
  );
}

/** 온도 가드에 걸린 차트(Temperature / Excursion / CH1) 공통 오버레이. */
export function SpeakerOpenOverlay() {
  return (
    <ChartAlertOverlay
      message="Speaker open"
      detail={`temperature ≥ ${TEMP_OVERFLOW_LIMIT_C}°C`}
    />
  );
}
