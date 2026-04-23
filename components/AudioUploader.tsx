"use client";

import { useRef, useState } from "react";
import { Upload, FileAudio, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppStatus } from "@/lib/types";

interface Props {
  status: AppStatus;
  onFileSelected: (file: File) => void;
  onReset: () => void;
  selectedFile: File | null;
}

export default function AudioUploader({ status, onFileSelected, onReset, selectedFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("audio/")) onFileSelected(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelected(file);
  };

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
    <div
      id="audio-dropzone"
      onClick={() => !isLocked && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={cn(
        "card h-full p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all select-none",
        "border-2 border-dashed",
        isDragging
          ? "border-brand-blue bg-brand-blue/5"
          : "border-iron-200 hover:border-brand-blue/50 hover:bg-iron-50",
        isLocked && "pointer-events-none opacity-50"
      )}
    >
      <div className="dropzone-icon w-12 h-12 rounded-xl bg-iron-100 flex items-center justify-center">
        <Upload size={22} className="text-iron-400" />
      </div>
      <div className="dropzone-instructions text-center">
        <p className="dropzone-label text-sm font-medium text-iron-700">
          오디오 파일을 드래그하거나 클릭하여 업로드
        </p>
        <p className="dropzone-formats text-xs text-iron-400 mt-1">WAV, MP3, FLAC, AAC 지원</p>
      </div>
      <input
        id="audio-file-input"
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
