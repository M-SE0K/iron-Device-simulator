"use client";

// 표시 항목 스택 — ChannelSelectDrawer에서 체크한 항목들(메인 차트 + 채널)을 하나의 부모
// 컨테이너 안에 세로로 쌓는다. 체크/해제 시 대응하는 자식 패널이 그대로 마운트/언마운트되어
// 인터랙티브하게 추가/제거되고, 각 패널 하단의 손잡이를 드래그하면 그 패널의 높이만
// 독립적으로 조절할 수 있다(전체 컨테이너는 overflow-y-auto로 스크롤). 헤더의 그립 아이콘을
// 드래그하면 패널 순서 자체를 재배치할 수 있다(HTML5 드래그&드롭, 기본 순서는 호출자가
// items 배열로 넘긴 순서 그대로).
import { useCallback, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { GripHorizontal, GripVertical } from "lucide-react";
import { cn } from "@/shared/lib/utils";

const DEFAULT_MIN_HEIGHT = 72;
const DEFAULT_MAX_HEIGHT = 480;

function ResizeHandle({
  height,
  minHeight,
  maxHeight,
  onResize,
}: {
  height: number;
  minHeight: number;
  maxHeight: number;
  onResize: (next: number) => void;
}) {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(maxHeight, Math.max(minHeight, drag.startHeight + (e.clientY - drag.startY)));
    onResize(next);
  }, [onResize, minHeight, maxHeight]);

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="separator"
      aria-orientation="horizontal"
      aria-label="패널 크기 조절"
      className="flex items-center justify-center h-3 shrink-0 cursor-row-resize touch-none group/handle border-t border-iron-50 bg-iron-50/60 hover:bg-iron-100 transition"
    >
      <GripHorizontal className="w-3.5 h-3.5 text-iron-300 group-hover/handle:text-iron-500 transition" />
    </div>
  );
}

export interface StackItem {
  id: string;
  header: ReactNode;
  content: ReactNode;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
}

interface Props {
  items: StackItem[];
  emptyLabel?: string;
  /** 패널을 드래그로 재배치했을 때, 화면에 보이는 항목들의 새 id 순서를 통째로 넘긴다. */
  onReorder?: (ids: string[]) => void;
}

export default function ChannelStackView({ items, emptyLabel, onReorder }: Props) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const resize = useCallback((id: string, next: number) => {
    setHeights((prev) => ({ ...prev, [id]: next }));
  }, []);

  const handleDrop = useCallback((targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(dragId);
    if (from === -1) return;
    ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    ids.splice(to === -1 ? ids.length : to, 0, dragId);
    onReorder?.(ids);
  }, [dragId, items, onReorder]);

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-iron-400 text-center px-6">
        {emptyLabel ?? "표시 항목 드로어에서 항목을 선택하면 여기에 표시됩니다."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto">
      {items.map((item) => {
        const minHeight = item.minHeight ?? DEFAULT_MIN_HEIGHT;
        const maxHeight = item.maxHeight ?? DEFAULT_MAX_HEIGHT;
        const height = Math.min(maxHeight, Math.max(minHeight, heights[item.id] ?? item.defaultHeight ?? minHeight));
        return (
          <div
            key={item.id}
            onDragOver={(e: DragEvent<HTMLDivElement>) => {
              if (!dragId) return;
              e.preventDefault();
              setOverId(item.id);
            }}
            onDragLeave={() => setOverId((prev) => (prev === item.id ? null : prev))}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              handleDrop(item.id);
              setDragId(null);
              setOverId(null);
            }}
            className={cn(
              "animate-expand-down flex flex-col rounded-xl border bg-white overflow-hidden shrink-0 transition-colors",
              overId === item.id && dragId && dragId !== item.id ? "border-brand-blue" : "border-iron-100",
              dragId === item.id && "opacity-50",
            )}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-iron-50 shrink-0">
              <span
                draggable
                onDragStart={(e: DragEvent<HTMLSpanElement>) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(item.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                role="button"
                aria-label="패널 순서 변경"
                title="드래그해서 순서 변경"
                className="cursor-grab active:cursor-grabbing text-iron-300 hover:text-iron-500 shrink-0 touch-none"
              >
                <GripVertical className="w-3.5 h-3.5" />
              </span>
              {item.header}
            </div>
            <div style={{ height }} className="shrink-0 min-h-0">
              {item.content}
            </div>
            <ResizeHandle
              height={height}
              minHeight={minHeight}
              maxHeight={maxHeight}
              onResize={(next) => resize(item.id, next)}
            />
          </div>
        );
      })}
    </div>
  );
}
