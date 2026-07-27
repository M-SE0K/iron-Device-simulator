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
      ariaLabel="Select display items"
      title="Display Items"
      count={selected.size}
      layer="overlay"
      safeAreaTop
    >
          {metricEntries.length > 0 && (
            <div className="flex flex-col gap-1 mb-3 pb-3 border-b border-iron-100">
              <div className="px-1 pb-1">
                <span className="text-sm font-medium text-iron-400">Charts</span>
              </div>
              {metricEntries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} isSelected={selected.has(entry.id)} onToggle={onToggle} />
              ))}
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
