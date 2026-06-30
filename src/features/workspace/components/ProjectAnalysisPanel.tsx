"use client";

// 워크스페이스 우측 패널에 임베드되는 분석 대시보드.
// 선택된 프로젝트의 음원 바이트(/api/projects/:id/audio)를 File 로 받아
// DashboardClient(embedded) 에 주입한다 — 실시간 추적/배치 분석/측정 전체 기능 사용.
import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import DashboardPage from "@/features/audio/components/DashboardClient";
import type { ProjectDetail } from "@/features/workspace/types";

export default function ProjectAnalysisPanel({ project }: { project: ProjectDetail }) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filename = project.audio?.filename;
  const mimeType = project.audio?.mimeType;

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/projects/${project.id}/audio`);
        if (!res.ok) throw new Error("음원을 불러오지 못했습니다.");
        const blob = await res.blob();
        if (cancelled) return;
        const name = filename ?? `${project.name}.audio`;
        const type = mimeType || blob.type || "audio/mpeg";
        setFile(new File([blob], name, { type }));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "음원을 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, project.name, filename, mimeType]);

  if (loading) {
    return (
      <div className="mt-5 flex items-center justify-center gap-2 py-16 text-sm text-iron-400">
        <Loader2 className="w-4 h-4 animate-spin" /> 음원을 불러오는 중…
      </div>
    );
  }

  if (error || !file) {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
        <AlertCircle className="w-4 h-4 shrink-0" /> {error ?? "음원을 불러오지 못했습니다."}
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-iron-100 overflow-hidden">
      <DashboardPage useQueue embedded externalFile={file} />
    </div>
  );
}
