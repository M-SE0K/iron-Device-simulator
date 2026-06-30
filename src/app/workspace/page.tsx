// /workspace — 공간 모델 트리 탐색 페이지 (설계: docs/02-workspace-model.md)
// 접근 보호는 middleware (matcher 에 /workspace 포함) 에서 처리.
export const dynamic = "force-dynamic";

import SideNav from "@/shared/components/SideNav";
import WorkspaceTree from "@/features/workspace/components/WorkspaceTree";

export default function WorkspacePage() {
  return (
    <div className="h-screen flex flex-col bg-iron-50">
      <header className="bg-white border-b border-iron-100 px-4 sm:px-6 h-14 shrink-0 flex items-center gap-3">
        <SideNav />
        <span className="text-sm font-bold text-iron-900 tracking-tight">IRON DEVICE</span>
      </header>
      <main className="flex-1 min-h-0 p-4">
        <WorkspaceTree />
      </main>
    </div>
  );
}
