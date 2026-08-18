"use client";

import { memo } from "react";
import { useWorkspace } from "./WorkspaceContext";
import WorkspaceFolderSection from "./WorkspaceFolderSection";
import { useEscapeKey } from "@/shared/hooks/useGlobalKey";
import SideDrawer from "@/shared/components/overlay/SideDrawer";

function WorkspaceDrawer() {
  const { open, setOpen, localFolderFiles } = useWorkspace();
  const fileCount = localFolderFiles.length;

  useEscapeKey(() => setOpen(false), open);

  return (
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="Workspace"
      title="Workspace"
      count={fileCount}
    >
      <WorkspaceFolderSection />
    </SideDrawer>
  );
}

export default memo(WorkspaceDrawer);
