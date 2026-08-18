"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationStore } from "@/features/audio/lib/render/annotation-store";

export interface DrawControl {
  active: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export function useDrawMode(annotations: AnnotationStore | undefined, canAnnotate: boolean) {
  const [drawMode, setDrawMode] = useState(false);
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;

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

  return { isEnabled, draw };
}
