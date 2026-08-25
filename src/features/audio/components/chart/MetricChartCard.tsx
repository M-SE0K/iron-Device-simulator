"use client";

import type { SpeakerFault } from "@/features/audio/types";
import UPlotChart, { type UPlotDataSource, type UPlotOptions } from "@/shared/components/UPlotChart";
import type { DrawControl } from "./hooks/useDrawMode";
import ChartDrawControls from "./ChartDrawControls";
import { SpeakerFaultOverlay } from "./ChartAlertOverlay";

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
  draw?: DrawControl;
  speakerFault?: SpeakerFault | null;
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
  speakerFault = null,
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

      <div className="chart-body relative flex-1 p-2 min-h-[160px]">
        <SpeakerFaultOverlay fault={speakerFault} />
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
