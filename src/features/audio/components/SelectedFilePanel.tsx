"use client";

// AudioUploader 를 대체하는 선택 파일 패널.
// 파일 선택 자체는 좌측 Workspace 드로어의 "폴더" 섹션이 담당한다(폴더 업로드 → 파일 선택).
// 여기서는 (1) 선택된 파일이 있으면 그 미리보기(이름/크기/캘리브레이션 요약 + 초기화),
// (2) 없으면 Workspace 를 여는 안내 버튼만 보여준다.
import { FileAudio, FolderOpen, X } from "lucide-react";
import { AppStatus } from "@/features/audio/types";
import CalibrationSummary from "@/features/audio/components/calibration/CalibrationSummary";
import { useWorkspace } from "@/features/audio/components/workspace/Workspace-context";

interface Props {
  status: AppStatus;
  selectedFile: File | null;
  onReset: () => void;
}

export default function SelectedFilePanel({ status, selectedFile, onReset }: Props) {
  const { setOpen } = useWorkspace();
  const isLocked = status === "uploading" || status === "analyzing";

  if (selectedFile) {
    return (
      <div id="audio-uploader" className="audio-file-preview card h-full p-4 flex items-center gap-3">
        <div className="file-icon-wrapper w-9 h-9 rounded-lg bg-brand-blue/10 flex items-center justify-center shrink-0">
          <FileAudio size={18} className="text-brand-blue" />
        </div>
        <div className="file-info flex-1 min-w-0">
          <p id="selected-file-name" className="text-sm font-medium text-iron-800 truncate">{selectedFile.name}</p>
          <p className="selected-file-size text-xs text-iron-400 mt-0.5">
            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
          </p>
          <CalibrationSummary />
        </div>
        {!isLocked && (
          <button
            id="reset-file-btn"
            onClick={onReset}
            className="p-1.5 rounded-md hover:bg-iron-100 text-iron-400 hover:text-iron-600 transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="card h-full w-full p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all select-none border-2 border-dashed border-iron-200 hover:border-brand-blue/50 hover:bg-iron-50"
    >
      <div className="w-12 h-12 rounded-xl bg-iron-100 flex items-center justify-center">
        <FolderOpen size={22} className="text-iron-400" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-iron-700">작업 영역에서 오디오 파일을 선택하세요</p>
        <p className="text-xs text-iron-400 mt-1">좌측 Workspace에서 폴더를 업로드한 뒤 파일을 고르세요</p>
        <CalibrationSummary className="mt-2 justify-center" />
      </div>
    </button>
  );
}
