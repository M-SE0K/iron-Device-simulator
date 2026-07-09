"use client";

// 우측 슬라이딩 드로어(사이드바 "측정 기록" 내비) — 저장된 워크스페이스 아이템을 원본 파일별로
// 그룹핑해 트리로 보여준다. 신규 데이터 스토어가 아니라 WorkspaceContext.items의 그룹 뷰다.
// peakTemp/peakExcursion/status는 저장 시점(DashboardClient.handleSaveToWorkspace/
// handleSaveMicRecording)에 계산되어 lib/cache/workspace.ts에 함께 저장된다 — 이 필드가 없는
// 과거 레코드(status===null)도 깨지지 않게 렌더한다.
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, History, Music, X } from "lucide-react";
import { useWorkspace } from "./WorkspaceContext";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import type { WorkspaceItemMeta, MeasurementStatus } from "@/features/audio/lib/cache/workspace";

const STATUS_LABEL: Record<MeasurementStatus, string> = {
  normal: "정상",
  warning: "경고",
  danger: "위험",
};
const STATUS_CLASS: Record<MeasurementStatus, string> = {
  normal: "bg-emerald-500/10 text-emerald-600",
  warning: "bg-amber-500/10 text-amber-600",
  danger: "bg-red-500/10 text-red-600",
};

function formatMm(raw: number | null): string {
  if (raw === null || !Number.isFinite(raw)) return "—";
  return (raw / 1000).toFixed(3);
}

interface FileGroup {
  key: string;
  fileName: string;
  items: WorkspaceItemMeta[];
}

export default function MeasurementRecordsDrawer() {
  const { items } = useWorkspace();
  const { active, openDrawer, closeDrawer } = useActiveDrawer();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const open = active === "records";
  const setOpen = (v: boolean) => (v ? openDrawer("records") : closeDrawer());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const groups = useMemo<FileGroup[]>(() => {
    const byFile = new Map<string, WorkspaceItemMeta[]>();
    for (const item of items) {
      const key = item.audioFileName ?? item.name;
      const bucket = byFile.get(key);
      if (bucket) bucket.push(item);
      else byFile.set(key, [item]);
    }
    return Array.from(byFile.entries())
      .map(([key, groupItems]) => ({
        key,
        fileName: key,
        items: [...groupItems].sort((a, b) => b.createdAt - a.createdAt),
      }))
      .sort((a, b) => b.items[0].createdAt - a.items[0].createdAt);
  }, [items]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`absolute inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <aside
        className={`absolute top-0 right-0 z-50 h-full w-[420px] max-w-[92vw] bg-white border-l border-iron-100 shadow-[-12px_0_40px_rgba(15,23,42,0.16)] flex flex-col transition-transform duration-[240ms] ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="측정 기록"
        aria-hidden={!open}
      >
        <div className="px-5 pt-5 pb-4 shrink-0 flex items-start justify-between border-b border-iron-100">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-brand-blue shrink-0" />
              <h3 className="m-0 text-[17px] font-bold text-iron-900">측정 기록</h3>
            </div>
            <p className="m-0 mt-1 text-xs text-iron-400 tabular-nums">파일별 측정 이력 · 클릭하여 펼치기</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
              <History className="w-6 h-6 text-iron-200" />
              <p className="text-xs text-iron-400 leading-relaxed">
                작업 영역에 저장된 측정이 없습니다.
                <br />
                대시보드의 저장 버튼을 눌러보세요.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {groups.map((group) => {
                const isOpen = expanded.has(group.key);
                return (
                  <div key={group.key} className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => toggle(group.key)}
                      className="flex items-center gap-2.5 px-2.5 py-3 rounded-[10px] hover:bg-iron-50 transition text-left"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-iron-400 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
                      />
                      <Music className="w-4 h-4 text-brand-blue shrink-0" />
                      <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-iron-900">
                        {group.fileName}
                      </span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-iron-100 text-[11px] text-iron-500 font-semibold tabular-nums">
                        {group.items.length}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="ml-[19px] pl-4 border-l-[1.5px] border-iron-200 flex flex-col animate-expand-down">
                        {group.items.map((item) => {
                          const status = item.status ?? null;
                          const modeLabel = item.analysisMode === "batch" ? "분석" : "실시간";
                          const peakText = item.peakTemp !== null && item.peakTemp !== undefined
                            ? `Peak ${item.peakTemp.toFixed(1)}°C`
                            : "Peak —";
                          const excText = `${formatMm(item.peakExcursion ?? null)}mm`;
                          return (
                            <div
                              key={item.id}
                              className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-[10px] hover:bg-iron-50 transition"
                            >
                              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                <span className="text-[13px] font-semibold text-iron-900 tabular-nums">
                                  {new Date(item.createdAt).toLocaleString()}
                                </span>
                                <span className="text-[11px] text-iron-400 tabular-nums">
                                  {modeLabel} · {peakText} · {excText}
                                </span>
                              </div>
                              <span
                                className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                                  status ? STATUS_CLASS[status] : "bg-iron-100 text-iron-400"
                                }`}
                              >
                                {status ? STATUS_LABEL[status] : "—"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
