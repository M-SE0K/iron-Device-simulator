"use client";

// 워크스페이스 항목 한 줄 — 더블클릭/연필 아이콘으로 이름 변경, JSON/CSV/오디오 원본 다운로드,
// "채널" 액션으로 저장된 N채널 WAV의 채널별 파형 뷰(ChannelViewerOverlay)를 연다.
import { useEffect, useRef, useState } from "react";
import { Music, Pencil, Trash2 } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import { formatTime } from "@/shared/lib/utils";
import type { WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";
import ChannelViewerOverlay from "./ChannelViewerOverlay";

export default function WorkspaceItemRow({ item }: { item: WorkspaceItemMeta }) {
  const { rename, remove, exportJson, exportCsv, downloadAudio } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(item.name);
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

  // 데이터 기반 export 버튼 — JSON/CSV는 항상, 오디오/채널 뷰는 저장된 오디오가 있을 때만.
  const exportActions = [
    { key: "json", label: "JSON", onClick: () => exportJson(item) },
    { key: "csv",  label: "CSV",  onClick: () => exportCsv(item) },
    ...(item.audioFileName
      ? [
          { key: "audio",    label: "오디오", onClick: () => downloadAudio(item) },
          { key: "channels", label: "채널",   onClick: () => setChannelView(true) },
        ]
      : []),
  ];

  return (
    <div className="group flex flex-col gap-1.5 px-2.5 py-2 rounded-lg hover:bg-iron-50 transition">
      <div className="flex items-center gap-1.5 min-w-0">
        <Music className="w-3.5 h-3.5 text-iron-300 shrink-0" />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(item.name); setEditing(false); }
            }}
            autoFocus
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded border border-brand-blue bg-white text-xs font-mono text-iron-800 focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setEditing(true)}
            title="더블클릭하여 이름 변경"
            className="flex-1 min-w-0 truncate text-left text-xs font-medium text-iron-800"
          >
            {item.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="이름 변경"
          className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded text-iron-300 hover:text-iron-700 hover:bg-iron-100 transition"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => remove(item.id)}
          aria-label="삭제"
          className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded text-iron-300 hover:text-red-600 hover:bg-red-50 transition"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 text-[10px] text-iron-400 font-mono">
        <span>{new Date(item.createdAt).toLocaleString()}</span>
        {item.audioDuration != null && <span>· {formatTime(item.audioDuration)}</span>}
        <span>· {item.analysisMode === "batch" ? "분석" : "실시간"}</span>
        <span>· {item.frameCount}fr</span>
      </div>

      <div className="flex items-center gap-1.5 pl-5">
        {exportActions.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            className="px-1.5 py-0.5 rounded border border-iron-200 text-[10px] text-iron-500 hover:border-iron-400 hover:text-iron-800 transition"
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* 채널별 파형 뷰 — 저장된 N채널 WAV를 디코딩해 채널마다 렌더링 (드로어 위 전체 화면) */}
      {channelView && (
        <ChannelViewerOverlay item={item} onClose={() => setChannelView(false)} />
      )}
    </div>
  );
}
