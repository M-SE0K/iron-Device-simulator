"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";

/** 점 잇기(주석) 헤더 컨트롤 — 정지 상태에서만 카드 헤더에 노출된다. */
export interface DrawControl {
  active: boolean;
  onToggle: () => void;
  onClear: () => void;
}

/**
 * 점 잇기 그리기 모드의 카드 단위 상태 — Temperature/Excursion 카드와 대시보드 채널 카드가
 * 공유한다. uPlot 옵션(annotatePlugin)에는 상태가 아니라 ref를 읽는 안정된 getter(isEnabled)만
 * 넘겨, 토글이 인스턴스 재생성(=줌 상태 소실)을 일으키지 않게 한다.
 */
export function useDrawMode(annotations: AnnotationStore | undefined, canAnnotate: boolean) {
  const [drawMode, setDrawMode] = useState(false);
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;

  // 재생이 다시 시작되면(canAnnotate 해제) 그리기 모드에서 자동으로 빠져나온다 — 진행 중이던
  // 드래프트(첫 점만 찍힌 상태)도 함께 취소한다.
  useEffect(() => {
    if (canAnnotate) return;
    setDrawMode(false);
    annotations?.setDraft(null);
  }, [canAnnotate, annotations]);

  const isEnabled = useCallback(() => drawModeRef.current, []);

  const draw: DrawControl | undefined = annotations && canAnnotate
    ? {
        active: drawMode,
        onToggle: () => setDrawMode((v) => !v),
        onClear: () => annotations.clear(),
      }
    : undefined;

  // drawMode 자체는 내보내지 않는다 — 소비자가 필요한 건 draw.active(같은 값)뿐이다.
  return { isEnabled, draw };
}
