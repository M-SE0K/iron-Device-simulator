"use client";

// 파일 선택 자체는 Workspace 드로어의 "폴더" 섹션이 담당한다(폴더 업로드 → 파일 선택).
// 파일이 선택된 뒤의 미리보기/저장 버튼은 플로팅 플레이어 독(WaveformPlayer)으로 이전했다 —
// 이 컴포넌트는 "파일 없음" 안내(=Workspace 여는 진입점)만 남는다.
import { FolderOpen } from "lucide-react";
import CalibrationSummary from "@/features/audio/components/calibration/CalibrationSummary";
import { useWorkspace } from "@/features/audio/components/workspace/WorkspaceContext";

export default function SelectedFilePanel() {
  const { setOpen } = useWorkspace();

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="card w-full p-6 flex items-center justify-center gap-4 cursor-pointer transition-all select-none border-2 border-dashed border-iron-200 hover:border-brand-blue/50 hover:bg-iron-50"
    >
      <div className="w-11 h-11 rounded-xl bg-iron-100 flex items-center justify-center shrink-0">
        <FolderOpen size={20} className="text-iron-400" />
      </div>
      <div className="text-left">
        <p className="text-sm font-medium text-iron-700">작업 영역에서 오디오 파일을 선택하세요</p>
        <p className="text-xs text-iron-400 mt-1">사이드바의 Workspace에서 폴더를 업로드한 뒤 파일을 고르세요</p>
        <CalibrationSummary className="mt-2" />
      </div>
    </button>
  );
}
