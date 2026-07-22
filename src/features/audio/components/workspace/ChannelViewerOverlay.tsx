"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, AudioLines, X } from "lucide-react";
import { getWorkspacePayload, type WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";
import { decodeAudioChannels, type DecodedChannels } from "@/features/audio/lib/codec/wav-decoder";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import { ChannelWaveformCanvas } from "@/features/audio/components/channel/ChannelWaveformCanvas";
import { channelStats } from "@/features/audio/lib/render/waveform";
import ChannelRowHeader from "@/features/audio/components/channel/ChannelRowHeader";
import { formatTime } from "@/shared/lib/utils";
import { useOverlayTransition } from "@/shared/hooks/useOverlayTransition";
import FullscreenOverlay from "@/shared/components/overlay/FullscreenOverlay";

interface Props {
  item: WorkspaceItemMeta;
  onClose: () => void;
}

export default function ChannelViewerOverlay({ item, onClose }: Props) {
  const [decoded, setDecoded] = useState<DecodedChannels | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const { show, close } = useOverlayTransition(onClose);

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
