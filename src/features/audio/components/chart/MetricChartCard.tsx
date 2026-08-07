"use client";

// Temperature/ExcursionChart가 공유하는 카드 셸 — 헤더(제목/확대 버튼/현재값)와
// UPlotChart 마운트+empty state만 그린다. 시리즈 스타일·y축 범위·값 색상 판정처럼
// 메트릭마다 다른 부분은 각 차트 컴포넌트가 options/source/색상을 만들어 그대로 넘긴다.
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import type { DrawControl } from "./hooks/useDrawMode";
import ChartDrawControls from "./ChartDrawControls";

interface Props {
  id: string;
  title: string;
  valueId: string;
  valueLabel: string | null;
  valueUnit: string;
  valueColor: string;
  unitClassName?: string;
  showChart: boolean;
  audioDuration?: number | null;
  streaming: boolean;
  options: UPlotOptions;
  source: UPlotDataSource;
  /** 있으면 헤더에 연필(그리기 모드)·지우개(전체 지우기) 버튼을 노출한다. */
  draw?: DrawControl;
}

export default function MetricChartCard({
  id,
  title,
  valueId,
  valueLabel,
  valueUnit,
  valueColor,
  unitClassName = "",
  showChart,
  audioDuration,
  streaming,
  options,
  source,
  draw,
}: Props) {
  return (
    <div id={id} className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">{title}</span>
          <ChartDrawControls chartLabel={title} draw={draw} />
        </div>

        <div className="flex items-center gap-2">
          {valueLabel !== null ? (
            <span id={valueId} className="font-mono text-lg font-semibold" style={{ color: valueColor }}>
              {valueLabel}
              <span className={`text-xs ml-0.5 font-normal ${unitClassName}`}>{valueUnit}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {showChart ? (
          <UPlotChart
            key={audioDuration ?? "live"}
            options={options}
            source={source}
            streamFollow={streaming}
            yZoom
          />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            Data will appear here in real time during playback
          </div>
        )}
      </div>
    </div>
  );
}
