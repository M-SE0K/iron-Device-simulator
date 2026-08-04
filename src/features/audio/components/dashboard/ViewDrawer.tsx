"use client";

// 좌측 Sidebar의 View 탭 드로어 — 대시보드에 표시할 차트(Protection/Excursion/Temperature)와
// 캡처 채널의 체크 목록. 목록 UI는 상세 뷰의 "표시 항목" 드로어(ChannelSelectDrawer)를
// 그대로 재사용하되, Workspace/Records와 같은 content 레이어로 연다.
import { memo } from "react";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import ChannelSelectDrawer, { type DrawerEntry } from "@/features/audio/components/channel/ChannelSelectDrawer";
import { useActiveDrawer } from "./ActiveDrawerContext";

interface Props {
  entries: DrawerEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

function ViewDrawer({ entries, selected, onToggle }: Props) {
  const { active, closeDrawer } = useActiveDrawer();
  const open = active === "view";

  useEscapeKey(closeDrawer, open);

  return (
    <ChannelSelectDrawer
      open={open}
      onClose={closeDrawer}
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
