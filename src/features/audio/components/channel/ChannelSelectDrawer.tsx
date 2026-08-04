"use client";

import type { LucideIcon } from "lucide-react";
import { AudioLines } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import SideDrawer from "@/shared/components/overlay/SideDrawer";
import CountBadge from "@/shared/components/ui/CountBadge";

export interface DrawerEntry {
  id: string;
  section: "metric" | "channel";
  name: string;
  role: string;
  color: string;
  icon?: LucideIcon;
  /** 상위 entry의 id — 지정하면 그 entry 바로 아래 들여쓴 하위 토글로 그려진다(같은 section 내). */
  parentId?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  entries: DrawerEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  loading?: boolean;
  error?: string | null;
  /** 드로어 제목 — 기본은 상세 뷰의 "Display Items". 대시보드 View 탭은 "View"로 오버라이드. */
  title?: string;
  /**
   * SideDrawer 레이어 — 기본은 전체화면 오버레이 위(overlay). 대시보드 View 탭처럼
   * Workspace/Records와 같은 기준으로 열릴 때는 "content"를 넘긴다.
   */
  layer?: "content" | "overlay";
  safeAreaTop?: boolean;
}

function EntryRow({
  entry,
  isSelected,
  onToggle,
  disabled = false,
}: {
  entry: DrawerEntry;
  isSelected: boolean;
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  const { id, name, role, color, icon: Icon } = entry;
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      disabled={disabled}
      aria-pressed={isSelected}
      className={cn(
        "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition",
        isSelected ? "bg-iron-100" : "hover:bg-iron-50",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center w-4 h-4 rounded shrink-0 border transition",
          isSelected ? "border-transparent" : "border-iron-300 bg-white",
        )}
        style={isSelected ? { backgroundColor: color } : undefined}
      >
        {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </span>
      {Icon ? (
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
      ) : (
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      )}
      <span className="flex-1 min-w-0 truncate text-sm font-semibold text-iron-900 font-mono">{name}</span>
      <span className="shrink-0 text-[11px] text-iron-400">{role}</span>
    </button>
  );
}

export default function ChannelSelectDrawer({
  open,
  onClose,
  entries,
  selected,
  onToggle,
  loading,
  error,
  title = "Display Items",
  layer = "overlay",
  safeAreaTop = true,
}: Props) {
  const metricEntries = entries.filter((e) => e.section === "metric" && !e.parentId);
  const metricChildren = entries.filter((e) => e.section === "metric" && e.parentId);
  const channelEntries = entries.filter((e) => e.section === "channel");
  // 하위 토글(예: Protected의 Input/Protected L/R)은 "선택된 차트 개수" 배지에서 제외한다 —
  // 이 배지는 원래 "대시보드에 몇 개 카드가 떠 있나"를 뜻하고, 하위 토글은 카드 개수가 아니라
  // 카드 안의 표시 항목이다.
  const topLevelSelectedCount =
    entries.filter((e) => !e.parentId && selected.has(e.id)).length;

  return (
    <SideDrawer
      open={open}
      onClose={onClose}
      ariaLabel="Select display items"
      title={title}
      count={topLevelSelectedCount}
      layer={layer}
      safeAreaTop={safeAreaTop}
    >
          {metricEntries.length > 0 && (
            <div className="flex flex-col gap-1 mb-3 pb-3 border-b border-iron-100">
              <div className="px-1 pb-1">
                <span className="text-sm font-medium text-iron-400">Charts</span>
              </div>
              {metricEntries.map((entry) => {
                const parentSelected = selected.has(entry.id);
                const children = metricChildren.filter((c) => c.parentId === entry.id);
                return (
                  <div key={entry.id} className="flex flex-col gap-1">
                    <EntryRow entry={entry} isSelected={parentSelected} onToggle={onToggle} />
                    {children.length > 0 && (
                      <div className="flex flex-col gap-1 pl-6">
                        {children.map((child) => (
                          <EntryRow
                            key={child.id}
                            entry={child}
                            isSelected={selected.has(child.id)}
                            onToggle={onToggle}
                            disabled={!parentSelected}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-sm font-medium text-iron-400">Channels</span>
              {channelEntries.length > 0 && (
                <CountBadge count={channelEntries.length} suffix="ch" />
              )}
            </div>

            {loading && <p className="text-xs text-iron-400 text-center py-8 animate-pulse">Loading channel info…</p>}
            {!loading && error && (
              <p className="text-xs text-red-500 text-center py-8">Unable to load channel data.</p>
            )}
            {!loading && !error && channelEntries.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 text-center px-6 py-8">
                <AudioLines className="w-6 h-6 text-iron-200" />
                <p className="text-xs text-iron-400 leading-relaxed">
                  No captured channel data yet.
                  <br />
                  Channels will appear here once playback or recording starts.
                </p>
              </div>
            )}
            {!loading &&
              !error &&
              channelEntries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} isSelected={selected.has(entry.id)} onToggle={onToggle} />
              ))}
          </div>
    </SideDrawer>
  );
}
