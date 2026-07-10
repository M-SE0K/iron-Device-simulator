"use client";

// 저장 세션의 채널별 파형 뷰 — 측정 기록 드로어(RecordsDrawer)의 "채널" 액션으로 진입하는
// 전체 화면 오버레이(ChartDetailOverlay와 동일한 전환 패턴). 워크스페이스에 보존된
// N채널 WAV(마이크 전 채널 캡처: ch0=V, ch1=I, ch2..=확장 / 파일 모드: 2ch V·I)를
// 디코딩해 채널마다 파형(LTTB 단일 선) + peak/RMS 통계를 렌더링한다.
import { useEffect, useState } from "react";
import { ArrowLeft, AudioLines, X } from "lucide-react";
import { getWorkspacePayload, type WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";
import { decodeAudioChannels, type DecodedChannels } from "@/features/audio/lib/codec/wav-decoder";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import { ChannelWaveformCanvas, channelStats } from "@/features/audio/components/chart/ChannelWaveformCanvas";
import ChannelRowHeader from "@/features/audio/components/chart/ChannelRowHeader";
import { formatTime } from "@/shared/lib/utils";
import { useOverlayTransition } from "@/shared/hooks/useOverlayTransition";
import FullscreenOverlay from "@/shared/components/FullscreenOverlay";

interface Props {
  item: WorkspaceItemMeta;
  onClose: () => void;
}

export default function ChannelViewerOverlay({ item, onClose }: Props) {
  const [decoded, setDecoded] = useState<DecodedChannels | null>(null);
  const [error, setError]     = useState<string | null>(null);

  // 진입/이탈 애니메이션 — ChartDetailOverlay와 동일 패턴(useOverlayTransition 공용)
  const { show, close } = useOverlayTransition(onClose);

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
    <FullscreenOverlay show={show} ariaLabel={`${item.name} 채널별 파형`}>
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
              const color = channelColor(ch);
              const { peak, rms } = channelStats(data);
              return (
                <div key={ch} className="rounded-xl border border-iron-100 bg-white overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-iron-50">
                    <ChannelRowHeader color={color} name={name} role={role} stats={{ peak, rms }} />
                  </div>
                  <div className="h-40 sm:h-44">
                    <ChannelWaveformCanvas
                      color={color}
                      sampleRate={decoded.sampleRate}
                      totalDurationSec={decoded.durationSec}
                      liveWindow={{ data, startSec: 0 }}
                      fetchRange={async (s, e) =>
                        data.subarray(
                          Math.max(0, Math.round(s * decoded.sampleRate)),
                          Math.min(data.length, Math.round(e * decoded.sampleRate)),
                        )
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FullscreenOverlay>
  );
}
