import "@/shared/lib/dpr-cap";
import uPlot from "uplot";

export interface ThresholdLine {
  y: number;
  color: string;
  label: string;
}

export function thresholdsPlugin(lines: ThresholdLine[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        if (lines.length === 0) return;
        const ctx = u.ctx;
        const pxRatio = uPlot.pxRatio || 1;
        const { left, width } = u.bbox;
        ctx.save();
        for (const line of lines) {
          const yMin = u.scales.y.min ?? -Infinity;
          const yMax = u.scales.y.max ?? Infinity;
          if (line.y < yMin || line.y > yMax) continue;
          const cy = Math.round(u.valToPos(line.y, "y", true));

          ctx.strokeStyle = line.color;
          ctx.lineWidth = pxRatio;
          ctx.setLineDash([4 * pxRatio, 4 * pxRatio]);
          ctx.beginPath();
          ctx.moveTo(left, cy);
          ctx.lineTo(left + width, cy);
          ctx.stroke();

          ctx.fillStyle = line.color;
          ctx.font = `${9 * pxRatio}px system-ui, sans-serif`;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(line.label, left + width - 4 * pxRatio, cy - 2 * pxRatio);
        }
        ctx.restore();
      },
    },
  };
}
