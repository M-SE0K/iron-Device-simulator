"use client";

import { memo } from "react";
import { useEscapeKey } from "@/shared/hooks/useGlobalKey";
import ChannelSelectDrawer, { type DrawerEntry } from "@/features/audio/components/channel/ChannelSelectDrawer";
import { useDrawerState } from "../ActiveDrawerContext";

interface Props {
  entries: DrawerEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

function ViewDrawer({ entries, selected, onToggle }: Props) {
  const { open, setOpen } = useDrawerState("view");

  useEscapeKey(() => setOpen(false), open);

  return (
    <ChannelSelectDrawer
      open={open}
      onClose={() => setOpen(false)}
      entries={entries}
      selected={selected}
      onToggle={onToggle}
      title="View"
      layer="content"
      safeAreaTop={false}
    />
  );
}

export default memo(ViewDrawer);
