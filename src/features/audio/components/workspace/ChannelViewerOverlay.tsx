"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, AudioLines, X } from "lucide-react";
import { getWorkspacePayload, type WorkspaceItemMeta } from "@/features/audio/lib/cache/workspace";
import { decodeAudioChannels, type DecodedChannels } from "@/features/audio/lib/codec/wav-decoder";
import { channelLabel, channelColor, type ChannelRoleLabels } from "@/features/audio/lib/render/channel-meta";
import { ChannelWaveformCanvas } from "@/features/audio/components/channel/ChannelWaveformCanvas";
import { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { channelStats } from "@/features/audio/lib/render/waveform";
import ChannelRowHeader from "@/features/audio/components/channel/ChannelRowHeader";
import { formatTime } from "@/shared/lib/utils";
import { useOverlayTransition } from "@/shared/hooks/useOverlayTransition";
import FullscreenOverlay from "@/shared/components/overlay/FullscreenOverlay";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";

interface Props {
  item: WorkspaceItemMeta;
  onClose: () => void;
}

const CHANNEL_ROLE_LABELS: ChannelRoleLabels = {
  voltage: "V (Voltage)",
  current: "I (Current)",
  extended: "Extended",
};

/**
 * 저장된(정지된) 채널 하나의 파형 — 라이브 채널 뷰와 같은 표현을 쓰기 위해 디코딩된 전체
 * 샘플을 스토어에 한 번에 넣는다. Temperature/ExcursionChart와 동일하게 세션(파일) 전체
 * 엔벨로프만 보여준다 — 확대해도 원본 재조회는 하지 않는다.
 */
function StaticChannelWave({ color, data, sampleRate }: { color: string; data: Float32Array; sampleRate: number }) {
  const store = useMemo(() => {
    const next = new ChannelWaveStore();
    next.addBlock(data, 0, sampleRate);
    next.flush();
    return next;
  }, [data, sampleRate]);

  return <ChannelWaveformCanvas color={color} sampleRate={sampleRate} store={store} />;
}

export default function ChannelViewerOverlay({ item, onClose }: Props) {
  const { showError } = useErrorPopup();
  const [decoded, setDecoded] = useState<DecodedChannels | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const { show, close } = useOverlayTransition(onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await getWorkspacePayload(item.id);
        if (!payload?.audioBlob) {
          if (!cancelled) {
            setError("No audio saved for this session.");
            showError("No audio saved for this session.");
          }
          return;
        }
        const result = await decodeAudioChannels(payload.audioBlob);
        if (!cancelled) setDecoded(result);
      } catch {
        if (!cancelled) {
          setError("Failed to decode audio.");
          showError("Failed to decode audio.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [item.id, showError]);

  return (
    <FullscreenOverlay show={show} ariaLabel={`${item.name} channel waveforms`}>
      <header className="shrink-0 h-14 px-3 sm:px-5 flex items-center gap-3 border-b border-iron-100 bg-white">
        <button
          type="button"
          onClick={close}
          aria-label="Back"
          className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-sm text-iron-600 hover:bg-iron-100 hover:text-iron-900 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Back</span>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <AudioLines size={16} className="shrink-0 text-brand-blue" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-iron-900 truncate">{item.name}</span>
            <span className="text-[11px] text-iron-400 truncate">
              Channel Waveforms
              {decoded &&
                ` · ${decoded.channels.length}ch · ${decoded.sampleRate.toLocaleString()}Hz · ${formatTime(decoded.durationSec)}`}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="ml-auto flex items-center justify-center w-9 h-9 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5">
        {error && <p className="text-sm text-iron-400 text-center py-10">Unable to load channel waveforms.</p>}
        {!error && !decoded && (
          <p className="text-sm text-iron-400 text-center py-10 animate-pulse">Decoding audio…</p>
        )}
        {decoded && (
          <div className="flex flex-col gap-3 max-w-5xl mx-auto">
            {decoded.channels.map((data, ch) => {
              const { name, role } = channelLabel(ch, CHANNEL_ROLE_LABELS);
              const color = channelColor(ch);
              const { peak, rms } = channelStats(data);
              return (
                <div key={ch} className="rounded-xl border border-iron-100 bg-white overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-iron-50">
                    <ChannelRowHeader color={color} name={name} role={role} stats={{ peak, rms }} />
                  </div>
                  <div className="h-40 sm:h-44">
                    <StaticChannelWave color={color} data={data} sampleRate={decoded.sampleRate} />
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
