"use client";

import { useEffect, useRef } from "react";

export interface UseWebOutputRoutingParams {
  mediaElement: HTMLMediaElement | null;
  outputDeviceId: string;
  outputChannel: string;
}

/**
 * 웹 파일 재생의 출력 라우팅. Chromium 계열(AudioContext.setSinkId 지원)에서는
 * mediaElement를 createMediaElementSource로 태핑해 ChannelMergerNode로 지정한
 * 출력 채널(outputChannel/outputChannel+1, Electron의 L/L+1 관례와 동일)에 꽂고
 * setSinkId로 실제 장치까지 라우팅한다. 미지원 브라우저는 기존
 * HTMLMediaElement.setSinkId(장치 단위, 채널 타겟팅 없음)로 폴백한다.
 * createMediaElementSource는 엘리먼트당 1회만 호출 가능하므로 같은 엘리먼트에
 * 대해서는 소스 노드를 재사용하고, 엘리먼트 자체가 바뀌면(파일 교체) 그래프를
 * 통째로 새로 만든다.
 */
export function useWebOutputRouting({ mediaElement, outputDeviceId, outputChannel }: UseWebOutputRoutingParams) {
  const ctxRef      = useRef<AudioContext | null>(null);
  const sourceRef   = useRef<MediaElementAudioSourceNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const mergerRef   = useRef<ChannelMergerNode | null>(null);
  const boundElRef  = useRef<HTMLMediaElement | null>(null);

  useEffect(() => {
    if (!mediaElement) return;

    if (boundElRef.current !== mediaElement) {
      sourceRef.current?.disconnect();
      splitterRef.current?.disconnect();
      mergerRef.current?.disconnect();
      void ctxRef.current?.close();
      ctxRef.current = null;
      sourceRef.current = null;
      splitterRef.current = null;
      mergerRef.current = null;
      boundElRef.current = mediaElement;
    }

    const supportsSinkRouting = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

    if (!supportsSinkRouting) {
      const el = mediaElement as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === "function") {
        el.setSinkId(outputDeviceId || "").catch(() => {});
      }
      return;
    }

    let cancelled = false;
    (async () => {
      let ctx = ctxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        ctxRef.current = ctx;
      }
      if (ctx.state === "suspended") await ctx.resume();
      if (cancelled) return;

      if (ctx.setSinkId) {
        try {
          await ctx.setSinkId(outputDeviceId || "");
        } catch {
          // 지원은 하지만 요청한 id로 라우팅 실패 — 기존 sink로 계속 진행.
        }
      }
      if (cancelled) return;

      const channelIndex  = Math.max(0, Number(outputChannel) || 0);
      const mergerInputs  = Math.max(2, channelIndex + 2);
      const maxChannels   = ctx.destination.maxChannelCount || 2;
      const destChannels  = Math.min(mergerInputs, Math.max(2, maxChannels));

      if (!sourceRef.current) {
        sourceRef.current = ctx.createMediaElementSource(mediaElement);
      }
      sourceRef.current.disconnect();
      splitterRef.current?.disconnect();
      mergerRef.current?.disconnect();

      const splitter = ctx.createChannelSplitter(2);
      const merger   = ctx.createChannelMerger(mergerInputs);
      splitterRef.current = splitter;
      mergerRef.current   = merger;

      ctx.destination.channelCount          = destChannels;
      ctx.destination.channelCountMode      = "explicit";
      ctx.destination.channelInterpretation = "discrete";

      sourceRef.current.connect(splitter);
      splitter.connect(merger, 0, Math.min(channelIndex, mergerInputs - 1));
      splitter.connect(merger, 1, Math.min(channelIndex + 1, mergerInputs - 1));
      merger.connect(ctx.destination);
    })();

    return () => { cancelled = true; };
  }, [mediaElement, outputDeviceId, outputChannel]);

  useEffect(() => () => {
    sourceRef.current?.disconnect();
    splitterRef.current?.disconnect();
    mergerRef.current?.disconnect();
    void ctxRef.current?.close();
  }, []);
}
