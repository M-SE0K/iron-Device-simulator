import { Eraser, Pencil } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { DrawControl } from "./hooks/useDrawMode";

interface Props {
  chartLabel: string;
  draw?: DrawControl;
}

export default function ChartDrawControls({ chartLabel, draw }: Props) {
  if (!draw) return null;

  return (
    <>
      <button
        type="button"
        onClick={draw.onToggle}
        aria-pressed={draw.active}
        aria-label={`Connect points on ${chartLabel} chart`}
        title="Connect points (click two points)"
        className={cn(
          "p-1 rounded transition-colors",
          draw.active
            ? "text-rose-500 bg-rose-50"
            : "text-iron-300 hover:text-rose-500 hover:bg-rose-50",
        )}
      >
        <Pencil size={13} />
      </button>
      {draw.active && (
        <button
          type="button"
          onClick={draw.onClear}
          aria-label={`Clear drawn lines on ${chartLabel} chart`}
          title="Clear drawn lines"
          className="p-1 rounded text-iron-300 hover:text-iron-600 hover:bg-iron-100 transition-colors"
        >
          <Eraser size={13} />
        </button>
      )}
    </>
  );
}
