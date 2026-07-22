"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, History, Music, Pencil, Trash2 } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import { cn, formatTime } from "@/shared/lib/utils";
import { formatMm } from "@/features/audio/lib/units";
import type { WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";
import ChannelViewerOverlay from "./ChannelViewerOverlay";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import SideDrawer from "@/shared/components/overlay/SideDrawer";
import CountBadge from "@/shared/components/ui/CountBadge";

interface FileGroup {
  key: string;
  fileName: string;
  items: WorkspaceItemMeta[];
}

function RecordRow({ item }: { item: WorkspaceItemMeta }) {
  const { rename, remove, exportJson, exportCsv, downloadAudio, downloadProtectedAudio } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name);
  const [channelView, setChannelView] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== item.name) void rename(item.id, trimmed);
    else setDraft(item.name);
  };

  const modeLabel = item.analysisMode === "batch" ? "분석" : "실시간";
  const peakText =
    item.peakTemp !== null && item.peakTemp !== undefined ? `Peak ${item.peakTemp.toFixed(1)}°C` : "Peak —";

  const exportActions = [
    { key: "json", label: "JSON", onClick: () => exportJson(item) },
    { key: "csv", label: "CSV", onClick: () => exportCsv(item) },
    ...(item.audioFileName
      ? [
          { key: "audio", label: "오디오", onClick: () => downloadAudio(item) },
        ]
      : []),
    ...(item.hasProtectedAudio
      ? [
          { key: "protected", label: "보호 WAV", onClick: () => downloadProtectedAudio(item) },
        ]
      : []),
  ];

  return (
    <div className="group/rec my-0.5 flex flex-col gap-1.5 rounded-lg px-2.5 py-2 transition hover:bg-iron-50">
      <div className="flex items-center gap-1.5 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(item.name);
                setEditing(false);
              }
            }}
            autoFocus
            className="flex-1 min-w-0 rounded border border-brand-blue bg-white px-1.5 py-0.5 text-sm font-medium text-iron-800 focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setEditing(true)}
            title="더블클릭하여 이름 변경"
            className="flex-1 min-w-0 truncate text-left text-sm font-semibold text-iron-900"
          >
            {item.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="이름 변경"
          className="shrink-0 rounded p-1 text-iron-300 opacity-0 transition hover:bg-iron-100 hover:text-iron-700 group-hover/rec:opacity-100"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => remove(item.id)}
          aria-label="삭제"
          className="shrink-0 rounded p-1 text-iron-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover/rec:opacity-100"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-iron-400 tabular-nums">
        <span>{new Date(item.createdAt).toLocaleString()}</span>
        <span>· {modeLabel}</span>
        <span>· {peakText}</span>
        <span>· {formatMm(item.peakExcursion)}mm</span>
        {item.audioDuration != null && <span>· {formatTime(item.audioDuration)}</span>}
        <span>· {item.frameCount}fr</span>
      </div>

      <div className="flex items-center gap-1.5">
        {exportActions.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            className="rounded border border-iron-200 px-1.5 py-0.5 text-[11px] text-iron-500 transition hover:border-iron-400 hover:text-iron-800"
          >
            {action.label}
          </button>
        ))}
      </div>

      {channelView && <ChannelViewerOverlay item={item} onClose={() => setChannelView(false)} />}
    </div>
  );
}

function RecordsDrawer() {
  const { items } = useWorkspace();
  const { active, openDrawer, closeDrawer } = useActiveDrawer();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const open = active === "records";
  const setOpen = (v: boolean) => (v ? openDrawer("records") : closeDrawer());

  useEscapeKey(() => setOpen(false), open);

  const groups = useMemo<FileGroup[]>(() => {
    const byFile = new Map<string, WorkspaceItemMeta[]>();
    for (const item of items) {
      const key = item.audioFileName ?? item.name;
      const bucket = byFile.get(key);
      if (bucket) bucket.push(item);
      else byFile.set(key, [item]);
    }
    return Array.from(byFile.entries())
      .map(([key, groupItems]) => ({
        key,
        fileName: key,
        items: [...groupItems].sort((a, b) => b.createdAt - a.createdAt),
      }))
      .sort((a, b) => b.items[0].createdAt - a.items[0].createdAt);
  }, [items]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="측정 기록"
      title="측정 기록"
      count={items.length}
    >
      {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <History className="w-6 h-6 text-iron-200" />
              <p className="text-xs text-iron-400 leading-relaxed">
                저장된 측정 기록이 없습니다.
                <br />
                대시보드의 저장 버튼을 눌러보세요.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-sm font-medium text-iron-400">파일별 기록</span>
                <CountBadge count={groups.length} suffix="개 파일" />
              </div>

              {groups.map((group) => {
                const isOpen = expanded.has(group.key);
                return (
                  <div key={group.key} className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => toggle(group.key)}
                      className={cn(
                        "flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition",
                        isOpen ? "bg-iron-100" : "hover:bg-iron-50",
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          "w-3.5 h-3.5 shrink-0 text-iron-400 transition-transform duration-200",
                          isOpen && "rotate-90",
                        )}
                      />
                      <Music className="w-4 h-4 shrink-0 text-brand-blue fill-brand-blue" />
                      <span className="flex-1 min-w-0 truncate text-sm font-bold text-iron-900">
                        {group.fileName}
                      </span>
                      <span className="shrink-0 rounded-full bg-brand-blue/10 px-2 py-0.5 text-[11px] font-semibold text-brand-blue tabular-nums">
                        {group.items.length}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="ml-[25px] mt-1 flex flex-col border-l border-iron-200 animate-expand-down">
                        {group.items.map((item) => (
                          <div key={item.id} className="relative pl-3.5">
                            <span aria-hidden className="absolute left-0 top-[18px] h-px w-3 bg-iron-200" />
                            <div className="flex-1 min-w-0">
                              <RecordRow item={item} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
    </SideDrawer>
  );
}

export default memo(RecordsDrawer);
