"use client";

// 우측 드로어 — CoreAudio H/W 루프백(왕복) 지연 측정 UI.
// 단일 임펄스를 duplex 헬퍼(window.audioLoopback)로 방출·수신해 버퍼 크기별 왕복 지연을 잰다.
// 실측 DSP는 lib/measure/loop-latency.ts, 헬퍼 경로는 electron/native/audio-device-helper/mac.swift.
// Electron(window.audioLoopback) 전용 — 웹 빌드에서는 안내만 표시한다.
import { useCallback, useRef, useState } from "react";
import { X, Play, Square, Download } from "lucide-react";
import SideDrawer from "@/shared/components/overlay/SideDrawer";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import { downloadBlob } from "@/shared/lib/utils";
import {
  analyzeBuffer,
  buildImpulseRef,
  refToBytes,
  type BufferLatencyResult,
  type LoopbackExport,
} from "@/features/audio/lib/measure/loop-latency";

const DEFAULT_BUFFERS = "16,32,64,128,256,480,512,1024,1500";

function fmt(n: number | null, digits = 3): string {
  return n == null ? "—" : n.toFixed(digits);
}

export default function LoopbackDrawer() {
  const activeDrawer = useActiveDrawer();
  const open = activeDrawer.active === "loopback";
  const setOpen = useCallback(
    (v: boolean) => (v ? activeDrawer.openDrawer("loopback") : activeDrawer.closeDrawer()),
    [activeDrawer],
  );
  useEscapeKey(() => setOpen(false), open);

  const { values: calibration } = useCalibration();

  const [buffersText, setBuffersText] = useState(DEFAULT_BUFFERS);
  const [burstCount, setBurstCount] = useState(12);
  const [impulseLen, setImpulseLen] = useState(1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: number } | null>(null);
  const [results, setResults] = useState<BufferLatencyResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  const hasBridge = typeof window !== "undefined" && typeof window.audioLoopback !== "undefined";
  const deviceUID = calibration.captureDeviceUID || "";
  const sampleRate = Number(calibration.sampleRate) || 48000;
  const channels = Number(calibration.channels) || 2;

  const parseBuffers = useCallback((): number[] => {
    return buffersText
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  }, [buffersText]);

  const runMeasurement = useCallback(async () => {
    if (!hasBridge || !window.audioLoopback) {
      setError("이 빌드에는 CoreAudio 루프백 브리지가 없습니다 (Electron 데스크톱 전용).");
      return;
    }
    const buffers = parseBuffers();
    if (buffers.length === 0) {
      setError("버퍼 크기 목록을 확인하세요 (예: 16,32,64,...).");
      return;
    }
    setError(null);
    setResults([]);
    setRunning(true);
    abortRef.current = false;

    const ref = buildImpulseRef(impulseLen);
    const refPcm = refToBytes(ref);
    const collected: BufferLatencyResult[] = [];

    try {
      for (let i = 0; i < buffers.length; i++) {
        if (abortRef.current) break;
        const bufferSize = buffers[i];
        setProgress({ done: i, total: buffers.length, current: bufferSize });
        const res = await window.audioLoopback.measure({
          sampleRate,
          bufferSize,
          channels,
          deviceUID: deviceUID || undefined,
          burstCount,
          refPcm,
        });
        if (!res.success || !res.header || !res.pcm) {
          collected.push({
            requestedBuffer: bufferSize,
            actualBuffer: null,
            sampleRate,
            bursts: [],
            hits: 0,
            total: 0,
            medianMs: null,
            meanMs: null,
            sdMs: null,
            minMs: null,
            maxMs: null,
            error: res.error ?? "measure-failed",
          });
        } else {
          collected.push(analyzeBuffer(ref, res.header, res.pcm, bufferSize));
        }
        setResults([...collected]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [hasBridge, parseBuffers, impulseLen, sampleRate, channels, deviceUID, burstCount]);

  const stopMeasurement = useCallback(() => {
    abortRef.current = true;
    window.audioLoopback?.stop();
  }, []);

  const handleSave = useCallback(() => {
    if (results.length === 0) return;
    const payload: LoopbackExport = {
      meta: {
        createdAt: new Date().toISOString(),
        deviceUID,
        deviceName: null,
        channels,
        sampleRate,
        impulseLen,
        burstCount,
        note: "CoreAudio duplex single-IOProc H/W loopback round-trip (out0→in0 electrical loopback).",
      },
      results,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      `hw-loopback_${stamp}.json`,
    );
  }, [results, deviceUID, channels, sampleRate, impulseLen, burstCount]);

  return (
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="H/W 루프백 지연 측정"
      bodyClassName="p-4 space-y-4"
      header={
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <span className="text-sm font-semibold text-iron-700">H/W 루프백 지연 측정</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      }
      footer={
        <div className="p-3 border-t border-iron-100 shrink-0 flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={stopMeasurement}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-white bg-red-500 hover:bg-red-500/90"
            >
              <Square className="w-4 h-4" /> 중지
            </button>
          ) : (
            <button
              type="button"
              onClick={runMeasurement}
              disabled={!hasBridge}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm text-white bg-brand-blue hover:bg-brand-blue/90 disabled:opacity-40"
            >
              <Play className="w-4 h-4" /> 측정 시작
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={results.length === 0 || running}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-iron-600 border border-iron-200 hover:bg-iron-100 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> 저장
          </button>
        </div>
      }
    >
      {/* 배선 안내 */}
      <div className="px-3 py-2 rounded-lg bg-brand-blue/5 text-[11px] leading-relaxed text-brand-blue">
        출력 <b>ch0</b> → 입력 <b>ch0</b> 전기적 루프백 배선이 필요합니다. 단일 IOProc(단일 클럭)으로
        방출·수신해 <b>왕복 = 수신 검출 프레임 − 방출 프레임</b>을 계산합니다.
      </div>

      {!hasBridge && (
        <div className="px-3 py-2 rounded-lg bg-amber-50 text-[11px] text-amber-700">
          이 빌드에는 CoreAudio 루프백 브리지(window.audioLoopback)가 없습니다. Electron 데스크톱
          빌드에서만 측정할 수 있습니다.
        </div>
      )}

      {/* 대상 장치 / 파라미터 */}
      <section className="space-y-2 text-xs text-iron-600">
        <div className="flex justify-between">
          <span className="text-iron-400">Capture Device</span>
          <span className="font-medium truncate max-w-[190px]" title={deviceUID || "OS 기본"}>
            {deviceUID || "OS 기본"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-iron-400">Sample Rate / Channels</span>
          <span className="font-medium">{sampleRate} Hz · {channels}ch</span>
        </div>
      </section>

      <section className="space-y-3">
        <label className="block">
          <span className="text-[11px] text-iron-400">버퍼 크기 목록 (콤마 구분, samples)</span>
          <input
            type="text"
            value={buffersText}
            onChange={(e) => setBuffersText(e.target.value)}
            disabled={running}
            className="mt-1 w-full px-2.5 py-2 rounded-lg border border-iron-200 text-sm text-iron-700 focus:outline-none focus:border-brand-blue disabled:bg-iron-50"
          />
        </label>
        <div className="flex gap-3">
          <label className="flex-1">
            <span className="text-[11px] text-iron-400">버스트 수</span>
            <input
              type="number"
              min={1}
              value={burstCount}
              onChange={(e) => setBurstCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
              disabled={running}
              className="mt-1 w-full px-2.5 py-2 rounded-lg border border-iron-200 text-sm text-iron-700 focus:outline-none focus:border-brand-blue disabled:bg-iron-50"
            />
          </label>
          <label className="flex-1">
            <span className="text-[11px] text-iron-400">임펄스 길이</span>
            <input
              type="number"
              min={1}
              value={impulseLen}
              onChange={(e) => setImpulseLen(Math.max(1, parseInt(e.target.value, 10) || 1))}
              disabled={running}
              className="mt-1 w-full px-2.5 py-2 rounded-lg border border-iron-200 text-sm text-iron-700 focus:outline-none focus:border-brand-blue disabled:bg-iron-50"
            />
          </label>
        </div>
      </section>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-50 text-[11px] text-red-600">{error}</div>
      )}

      {progress && (
        <div className="text-[11px] text-iron-500">
          측정 중… {progress.done}/{progress.total} (buffer={progress.current})
        </div>
      )}

      {/* 결과 표 */}
      {results.length > 0 && (
        <section className="space-y-1.5">
          <div className="text-[11px] text-iron-400">버퍼별 왕복 지연 (median / mean±sd, ms)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-iron-600">
              <thead>
                <tr className="text-iron-400 text-left border-b border-iron-100">
                  <th className="py-1.5 pr-2 font-medium">buf</th>
                  <th className="py-1.5 pr-2 font-medium">actual</th>
                  <th className="py-1.5 pr-2 font-medium">median</th>
                  <th className="py-1.5 pr-2 font-medium">mean±sd</th>
                  <th className="py-1.5 font-medium">hits</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.requestedBuffer} className="border-b border-iron-50">
                    <td className="py-1.5 pr-2 tabular-nums">{r.requestedBuffer}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{r.actualBuffer ?? "—"}</td>
                    <td className="py-1.5 pr-2 tabular-nums font-medium text-iron-800">
                      {r.error ? <span className="text-red-500">err</span> : fmt(r.medianMs)}
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums">
                      {r.error ? "—" : `${fmt(r.meanMs)}±${fmt(r.sdMs, 2)}`}
                    </td>
                    <td className="py-1.5 tabular-nums">
                      {r.error ? "—" : `${r.hits}/${r.total}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-iron-300 leading-relaxed">
            hits = 문턱을 넘긴 유효 버스트 수 / 전체 버스트 수.
          </p>
        </section>
      )}
    </SideDrawer>
  );
}
