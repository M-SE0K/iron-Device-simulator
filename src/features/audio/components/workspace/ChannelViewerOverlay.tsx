"use client";

// 저장 세션의 채널별 파형 뷰 — 좌측 드로어(WorkspaceItemRow)의 "채널" 액션으로 진입하는
// 전체 화면 오버레이(ChartDetailOverlay와 동일한 전환 패턴). 워크스페이스에 보존된
// N채널 WAV(마이크 전 채널 캡처: ch0=V, ch1=I, ch2..=확장 / 파일 모드: 2ch V·I)를
// 디코딩해 채널마다 min/max 엔벨로프 파형 + peak/RMS 통계를 렌더링한다.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, AudioLines, X } from "lucide-react";
import { getWorkspacePayload, type WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";
import { decodeAudioChannels, type DecodedChannels } from "@/features/audio/lib/wav-decoder";
import { formatTime } from "@/shared/lib/utils";

// 채널 의미(확정): ch0=V(전압 센스), ch1=I(전류 센스), ch2 이후는 Calibration에서 확장한 예비 채널.
function channelLabel(ch: number): { name: string; role: string } {
  if (ch === 0) return { name: "CH0", role: "V (전압)" };
  if (ch === 1) return { name: "CH1", role: "I (전류)" };
  return { name: `CH${ch}`, role: "확장" };
}
const CHANNEL_COLORS = ["#0057B8", "#7C3AED", "#10B981", "#F97316", "#0EA5E9", "#EC4899", "#84CC16", "#F43F5E"];

/** 한 채널의 min/max 엔벨로프를 캔버스에 그린다 (컨테이너 리사이즈 추적, DPR 스케일) */
function ChannelWaveform({ data, color }: { data: Float32Array; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      // 중앙 0선
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      // 픽셀 컬럼마다 버킷 min/max 수직선 — 표시용 엔벨로프 (데이터는 원본 그대로 보존)
      const n = data.length;
      if (n === 0) return;
      const half = h / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const start = Math.floor((x / w) * n);
        const end   = Math.max(start + 1, Math.floor(((x + 1) / w) * n));
        let min = Infinity, max = -Infinity;
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const yMax = half - max * half * 0.95;
        const yMin = half - min * half * 0.95;
        ctx.moveTo(x + 0.5, yMax);
        ctx.lineTo(x + 0.5, Math.max(yMin, yMax + 1)); // 무음 구간도 1px은 보이게
      }
      ctx.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, [data, color]);

  return <canvas ref={canvasRef} className="block" />;
}

function channelStats(data: Float32Array): { peak: number; rms: number } {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sumSq += data[i] * data[i];
  }
  return { peak, rms: data.length ? Math.sqrt(sumSq / data.length) : 0 };
}

interface Props {
  item: WorkspaceItemMeta;
  onClose: () => void;
}

export default function ChannelViewerOverlay({ item, onClose }: Props) {
  const [decoded, setDecoded] = useState<DecodedChannels | null>(null);
  const [error, setError]     = useState<string | null>(null);

  // 진입/이탈 애니메이션 — ChartDetailOverlay와 동일 패턴
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const close = () => {
    setShow(false);
    window.setTimeout(onClose, 250);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 페이로드(IndexedDB) 로드 → 디코딩. 언마운트 후 setState 방지 가드.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await getWorkspacePayload(item.id);
        if (!payload?.audioBlob) {
          if (!cancelled) setError("이 세션에는 저장된 오디오가 없습니다.");
          return;
        }
        const result = await decodeAudioChannels(payload.audioBlob);
        if (!cancelled) setDecoded(result);
      } catch {
        if (!cancelled) setError("오디오를 디코딩하지 못했습니다.");
      }
    })();
    return () => { cancelled = true; };
  }, [item.id]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${item.name} 채널별 파형`}
      className={`fixed inset-0 z-[60] flex flex-col bg-iron-50 transition-all duration-300 ease-out ${
        show ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* 상단 바 */}
      <header className="shrink-0 h-14 px-3 sm:px-5 flex items-center gap-3 border-b border-iron-100 bg-white">
        <button
          type="button"
          onClick={close}
          aria-label="돌아가기"
          className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-sm text-iron-600 hover:bg-iron-100 hover:text-iron-900 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">뒤로</span>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <AudioLines size={16} className="shrink-0 text-brand-blue" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-iron-900 truncate">{item.name}</span>
            <span className="text-[11px] text-iron-400 truncate">
              채널별 파형
              {decoded &&
                ` · ${decoded.channels.length}ch · ${decoded.sampleRate.toLocaleString()}Hz · ${formatTime(decoded.durationSec)}`}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="닫기"
          className="ml-auto flex items-center justify-center w-9 h-9 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* 본문 — 채널별 스택 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5">
        {error && <p className="text-sm text-red-500 text-center py-10">{error}</p>}
        {!error && !decoded && (
          <p className="text-sm text-iron-400 text-center py-10 animate-pulse">오디오 디코딩 중…</p>
        )}
        {decoded && (
          <div className="flex flex-col gap-3 max-w-5xl mx-auto">
            {decoded.channels.map((data, ch) => {
              const { name, role } = channelLabel(ch);
              const color = CHANNEL_COLORS[ch % CHANNEL_COLORS.length];
              const { peak, rms } = channelStats(data);
              return (
                <div key={ch} className="rounded-xl border border-iron-100 bg-white overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-iron-50">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-xs font-semibold text-iron-800 font-mono">{name}</span>
                    <span className="text-[11px] text-iron-400">{role}</span>
                    <span className="ml-auto text-[10px] font-mono text-iron-400">
                      peak {peak.toFixed(4)} · rms {rms.toFixed(4)}
                    </span>
                  </div>
                  <div className="h-28 sm:h-32">
                    <ChannelWaveform data={data} color={color} />
                  </div>
                </div>
              );
            })}
            {/* 시간축 라벨 (공통) */}
            <div className="flex justify-between px-1 text-[10px] font-mono text-iron-400">
              <span>0:00</span>
              <span>{formatTime(decoded.durationSec)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
