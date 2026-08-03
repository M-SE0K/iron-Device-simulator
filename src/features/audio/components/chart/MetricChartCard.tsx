"use client";

// Temperature/ExcursionChart가 공유하는 카드 셸 — 헤더(제목/확대 버튼/현재값)와
// UPlotChart 마운트+empty state만 그린다. 시리즈 스타일·y축 범위·값 색상 판정처럼
// 메트릭마다 다른 부분은 각 차트 컴포넌트가 options/source/색상을 만들어 그대로 넘긴다.
import { Maximize2 } from "lucide-react";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";

interface Props {
  id: string;
  title: string;
  expandAriaLabel: string;
  expandHoverClassName: string;
  onExpand?: () => void;
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
  onRender: (ms: number) => void;
}

export default function MetricChartCard({
  id,
  title,
  expandAriaLabel,
  expandHoverClassName,
  onExpand,
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
  onRender,
}: Props) {
  return (
    <div id={id} className="card flex flex-col h-full">
      <div className="card-header">
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">{title}</span>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label={expandAriaLabel}
              title="View details"
              className={`ml-0.5 p-1 rounded text-iron-300 transition-colors ${expandHoverClassName}`}
            >
              <Maximize2 size={13} />
            </button>
          )}
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
            onRender={onRender}
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
