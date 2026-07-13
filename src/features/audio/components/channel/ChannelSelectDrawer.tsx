"use client";

// 표시 항목 선택 드로어 — ChartDetailOverlay(차트 상세 뷰) 안에서 여는 우측 슬라이딩 드로어.
// WorkspaceDrawer/RecordsDrawer와 동일한 컴포넌트 구조(배경 오버레이 + translate-x 패널)를
// 그대로 쓰되, 데이터만 "저장된 항목 목록" 대신 "현재 화면에 쌓을 수 있는 항목(메인 차트 +
// 캡처된 오디오의 채널 번호)"으로 바꿔 재사용한다. 메인 차트(Temperature/Excursion)도 채널과
// 동일하게 여기서 체크 해제해 스택에서 제거하거나 다시 추가할 수 있다.
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
}

interface Props {
  open: boolean;
  onClose: () => void;
  entries: DrawerEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  loading?: boolean;
  error?: string | null;
}

function EntryRow({
  entry,
  isSelected,
  onToggle,
}: {
  entry: DrawerEntry;
  isSelected: boolean;
  onToggle: (id: string) => void;
}) {
  const { id, name, role, color, icon: Icon } = entry;
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      aria-pressed={isSelected}
      className={cn(
        "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition",
        isSelected ? "bg-iron-100" : "hover:bg-iron-50",
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

export default function ChannelSelectDrawer({ open, onClose, entries, selected, onToggle, loading, error }: Props) {
  const metricEntries = entries.filter((e) => e.section === "metric");
  const channelEntries = entries.filter((e) => e.section === "channel");

  return (
    <SideDrawer
      open={open}
      onClose={onClose}
      ariaLabel="표시 항목 선택"
      title="표시 항목"
      count={selected.size}
      layer="overlay"
      safeAreaTop
    >
          {/* 메인 차트 — 채널과 동일한 체크 방식으로 스택에서 제거/추가 */}
          {metricEntries.length > 0 && (
            <div className="flex flex-col gap-1 mb-3 pb-3 border-b border-iron-100">
              <div className="px-1 pb-1">
                <span className="text-sm font-medium text-iron-400">차트</span>
              </div>
              {metricEntries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} isSelected={selected.has(entry.id)} onToggle={onToggle} />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-sm font-medium text-iron-400">채널 목록</span>
              {channelEntries.length > 0 && (
                <CountBadge count={channelEntries.length} suffix="ch" />
              )}
            </div>

            {loading && <p className="text-xs text-iron-400 text-center py-8 animate-pulse">채널 정보 불러오는 중…</p>}
            {!loading && error && <p className="text-xs text-red-500 text-center py-8">{error}</p>}
            {!loading && !error && channelEntries.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 text-center px-6 py-8">
                <AudioLines className="w-6 h-6 text-iron-200" />
                <p className="text-xs text-iron-400 leading-relaxed">
                  아직 캡처된 채널 데이터가 없습니다.
                  <br />
                  재생/녹음을 시작하면 여기에 채널이 나열됩니다.
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
