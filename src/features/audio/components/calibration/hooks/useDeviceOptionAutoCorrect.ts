"use client";

// 장치 능력(query)이 도착했을 때, 현재 draft의 SR/Buffer/Channels가 그 장치의 지원 범위 밖이면
// 가장 가까운 지원값으로 자동 보정한다 — 무효값이 그대로 "적용"→capture로 넘어가는
// 것을 막는다.
import { useEffect, useState } from "react";
import { SAMPLE_RATE_OPTIONS, BUFFER_SIZE_OPTIONS, CHANNEL_OPTIONS } from "../CalibrationContext";
import type { CalibrationValues } from "@/features/audio/types";
import type { DeviceInfo } from "./useNativeAudioDevice";

/** 문자열 옵션들 중 목표값과 수치상 가장 가까운 것을 고른다. 빈 목록이면 null. */
function nearestOption(options: string[], value: string): string | null {
  if (!options.length) return null;
  const target = Number(value);
  if (!Number.isFinite(target)) return options[0];
  return options.reduce((best, o) =>
    Math.abs(Number(o) - target) < Math.abs(Number(best) - target) ? o : best,
  );
}

export interface DeviceOptionAutoCorrectDeps {
  deviceInfo: DeviceInfo | null;
  deviceInfoLoading: boolean;
  hasAudioDeviceBridge: boolean;
  draft: CalibrationValues;
  set: (patch: Partial<CalibrationValues>) => void;
}

export function useDeviceOptionAutoCorrect(deps: DeviceOptionAutoCorrectDeps) {
  const { deviceInfo, deviceInfoLoading, hasAudioDeviceBridge, draft, set } = deps;

  // 장치 미지원 SR/Buffer 값을 지원값으로 자동 보정했을 때의 안내 문구(무엇→무엇). null이면 숨김.
  const [adjustedNote, setAdjustedNote] = useState<string | null>(null);

  // DEVICE 섹션 선택지 — Electron(Swift/CoreAudio) query()로 받은 장치 능력이 있으면 그 값으로,
  // 없으면(브라우저) 데모 목록으로 SampleRate/Buffer 옵션을 구성한다.
  const sampleRateOptions = deviceInfo?.supportedSampleRates?.length
    ? deviceInfo.supportedSampleRates.map(String)
    : SAMPLE_RATE_OPTIONS;
  const bufferSizeOptions = (() => {
    const r = deviceInfo?.bufferRange;
    if (!r) return BUFFER_SIZE_OPTIONS;
    const inRange = BUFFER_SIZE_OPTIONS.filter((b) => Number(b) >= r.min && Number(b) <= r.max);
    return inRange.length ? inRange : BUFFER_SIZE_OPTIONS;
  })();
  // CoreAudio는 SR/Buffer와 달리 "지원 채널 목록"을 따로 주지 않는다 — 장치의 총 입력 채널 수
  // (inputChannels) 이하로만 캡처할 수 있다는 게 유일한 제약이라, 그 값 이하로 정적 목록을 자른다.
  const channelOptions = (() => {
    const max = deviceInfo?.inputChannels;
    if (!max) return CHANNEL_OPTIONS;
    const inRange = CHANNEL_OPTIONS.filter((c) => Number(c) <= max);
    return inRange.length ? inRange : CHANNEL_OPTIONS;
  })();
  // play-capture 출력 채널 인덱스 후보 — 장치의 출력 채널 "개수"(outputChannels)만큼 0..N-1을
  // 만든다. 장치 능력을 아직 모르거나(로딩 전) 출력이 없는 장치면 "0" 하나만 둬서(재생 자체가
  // 불가하므로 선택은 무의미하지만 필드가 항상 값 있는 옵션 목록을 갖게) 안전한 fallback을 유지한다.
  const outputChannelOptions = (() => {
    const count = deviceInfo?.outputChannels;
    if (!count) return ["0"];
    return Array.from({ length: count }, (_, i) => String(i));
  })();
  // 장치 능력(query) 조회 중에는 아직 이전(또는 미필터) 옵션이 남아있으므로 DEVICE 섹션의
  // SampleRate/Buffer 선택을 잠근다 — 응답이 오면 그 장치가 지원하는 값만 렌더링된다.
  // 조회 API가 없는 브라우저/모바일에서는 deviceInfoLoading이 항상 false라 잠기지 않는다.
  const deviceOptionsLoading = hasAudioDeviceBridge && deviceInfoLoading;

  // 장치 능력이 도착했을 때(로딩 완료), 현재 draft의 SR/Buffer가 그 장치의 지원 목록 밖이면
  // 가장 가까운 지원값으로 자동 보정한다. deviceInfo가 바뀔 때(= 장치 전환/새로고침으로 새
  // 능력이 온 시점)에만 실행한다. 보정 결과는 그 자체로 지원 목록 안의 값이 되므로 재실행돼도
  // 더는 바뀌지 않아 루프가 나지 않는다.
  useEffect(() => {
    if (!deviceInfo || deviceInfoLoading) return;
    const patch: Partial<CalibrationValues> = {};
    const notes: string[] = [];
    if (!sampleRateOptions.includes(draft.sampleRate)) {
      const nearest = nearestOption(sampleRateOptions, draft.sampleRate);
      if (nearest && nearest !== draft.sampleRate) {
        patch.sampleRate = nearest;
        notes.push(`Sample Rate ${draft.sampleRate}→${nearest}Hz`);
      }
    }
    if (!bufferSizeOptions.includes(draft.bufferSize)) {
      const nearest = nearestOption(bufferSizeOptions, draft.bufferSize);
      if (nearest && nearest !== draft.bufferSize) {
        patch.bufferSize = nearest;
        notes.push(`Buffer ${draft.bufferSize}→${nearest}`);
      }
    }
    if (!channelOptions.includes(draft.channels)) {
      const nearest = nearestOption(channelOptions, draft.channels);
      if (nearest && nearest !== draft.channels) {
        patch.channels = nearest;
        notes.push(`Channels ${draft.channels}→${nearest}`);
      }
    }
    if (!outputChannelOptions.includes(draft.outputChannel)) {
      const nearest = nearestOption(outputChannelOptions, draft.outputChannel);
      if (nearest && nearest !== draft.outputChannel) {
        patch.outputChannel = nearest;
        notes.push(`Output Channel ${draft.outputChannel}→${nearest}`);
      }
    }
    if (notes.length) {
      set(patch);
      setAdjustedNote(`이 장치가 지원하지 않아 자동 조정됨: ${notes.join(", ")}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceInfo, deviceInfoLoading]);

  return {
    sampleRateOptions, bufferSizeOptions, channelOptions, outputChannelOptions, deviceOptionsLoading,
    adjustedNote, clearAdjustedNote: () => setAdjustedNote(null),
  };
}
