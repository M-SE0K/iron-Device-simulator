"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 앱 시작 시 한 번 덮이는 로딩 화면.
 *
 * 캔버스 파티클 / 글자 채움 / 물결은 모두 rAF 루프 안에서 DOM 을 직접 만지고,
 * React state 로는 퍼센트와 완료 여부만 들고 있다(원본 디자인의 구조 그대로).
 * 진행률은 실제 초기화가 아니라 `durationMs` 타이머 기반이다 — 스플래시가 떠 있는
 * 동안 대시보드는 뒤에서 이미 마운트되어 있다.
 */

const MAIN_TEXT = "Iron Device";
const SUB_TEXT = "Corporation";

const LIGHT = {
  bg: "#F7F9FC",
  gray: "#C7CBD6",
  fill: "#252B9E",
  edge: "#1D8FD5",
  pct: "#8A93A8",
  hint: "#A6AEC2",
  track: "#E3E7F0",
  btn: "#252B9E",
} as const;

const PARTICLE_COLORS = ["#252B9E", "#1D8FD5", "#3FB6F2", "#7C4DFF", "#00C9A7"];
const MAX_PARTICLES = 400;

type Particle = {
  x: number; y: number; vx: number; vy: number;
  r: number; rot: number; vr: number;
  life: number; max: number; c: string;
};
type Wave = { t0: number; x: number };

export type LoadingSplashProps = {
  /** ENTER 로 화면을 닫고 앱으로 들어갈 때 호출된다. */
  onFinish: () => void;
  /** 0 → 100% 까지 걸리는 시간(ms). */
  durationMs?: number;
  /** 마우스 이동/클릭 시 파티클을 뿌릴지. */
  sparkles?: boolean;
};

export default function LoadingSplash({
  onFinish,
  durationMs = 4500,
  sparkles = true,
}: LoadingSplashProps) {
  const [percent, setPercent] = useState(0);
  const [done, setDone] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const diamondRef = useRef<HTMLDivElement>(null);
  const diamondFillRef = useRef<HTMLDivElement>(null);
  const deco1Ref = useRef<HTMLDivElement>(null);
  const deco2Ref = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const wipeRef = useRef<HTMLDivElement>(null);

  const spansRef = useRef<(HTMLSpanElement | null)[]>([]);
  const doneRef = useRef(false);
  const leavingRef = useRef(false);

  const setSpan = useCallback(
    (i: number) => (el: HTMLSpanElement | null) => {
      spansRef.current[i] = el;
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const spans = spansRef.current.filter((s): s is HTMLSpanElement => !!s);
    const n = spans.length;
    const lastF = new Array<number>(n).fill(-1);
    const pops = new Array<number>(n).fill(-1e9);
    let centers: { x: number; y: number }[] = [];
    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    let parts: Particle[] = [];
    let waves: Wave[] = [];
    let dpr = window.devicePixelRatio || 1;

    const start = performance.now();
    let lastT = start;
    let raf = 0;

    spans.forEach((s) => {
      s.style.webkitBackgroundClip = "text";
      s.style.backgroundClip = "text";
      s.style.color = "transparent";
    });

    const measure = () => {
      centers = spans.map((s) => {
        const r = s.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };

    const spawn = (x: number, y: number, count: number, power: number) => {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = (30 + Math.random() * 220) * power;
        parts.push({
          x, y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 40 * power,
          r: 2 + Math.random() * 4,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 6,
          life: 0,
          max: 0.6 + Math.random() * 0.8,
          c: PARTICLE_COLORS[(Math.random() * PARTICLE_COLORS.length) | 0],
        });
      }
      if (parts.length > MAX_PARTICLES) parts.splice(0, parts.length - MAX_PARTICLES);
    };

    const paintFill = (span: HTMLSpanElement, f: number) => {
      if (f <= 0) {
        span.style.backgroundImage = `linear-gradient(0deg, ${LIGHT.gray}, ${LIGHT.gray})`;
        return;
      }
      if (f >= 1) {
        span.style.backgroundImage = `linear-gradient(0deg, ${LIGHT.fill}, ${LIGHT.fill})`;
        span.style.filter = "";
        return;
      }
      const y = (f * 100).toFixed(1);
      const y1 = Math.min(f * 100 + 9, 100).toFixed(1);
      const y2 = Math.min(f * 100 + 18, 100).toFixed(1);
      span.style.backgroundImage =
        `linear-gradient(0deg, ${LIGHT.fill} 0%, ${LIGHT.fill} ${y}%, ${LIGHT.edge} ${y1}%, ${LIGHT.gray} ${y2}%)`;
    };

    const drawParts = (dt: number) => {
      if (!canvas.width) measure();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      parts = parts.filter((p) => (p.life += dt) < p.max);
      for (const p of parts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 260 * dt;
        p.rot += p.vr * dt;
        const o = 1 - p.life / p.max;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = o * 0.9;
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      const raw = Math.min(1, (now - start) / durationMs);
      const pe = raw * raw * (3 - 2 * raw); // smoothstep
      const pc = Math.round(pe * 100);
      setPercent((prev) => (prev === pc ? prev : pc));
      if (pe >= 1 && !doneRef.current) {
        doneRef.current = true;
        setDone(true);
      }

      const t = now / 1000;
      const fd = Math.min(1, pe / 0.12);
      if (diamondFillRef.current) {
        diamondFillRef.current.style.clipPath = `inset(${((1 - fd) * 100).toFixed(1)}% 0 0 0)`;
      }
      if (barRef.current) barRef.current.style.width = `${(pe * 100).toFixed(2)}%`;
      if (diamondRef.current) {
        diamondRef.current.style.transform =
          `rotate(${(-18 + Math.sin(t * 1.1) * 3).toFixed(2)}deg) translateY(${(Math.sin(t * 0.8) * 5).toFixed(2)}px)`;
      }

      const nx = mx / window.innerWidth - 0.5;
      const ny = my / window.innerHeight - 0.5;
      if (deco1Ref.current) {
        deco1Ref.current.style.transform =
          `rotate(${(20 + t * 3).toFixed(1)}deg) translate(${(nx * -18).toFixed(1)}px, ${(ny * -18).toFixed(1)}px)`;
      }
      if (deco2Ref.current) {
        deco2Ref.current.style.transform =
          `rotate(${(-12 - t * 2).toFixed(1)}deg) translate(${(nx * 26).toFixed(1)}px, ${(ny * 26).toFixed(1)}px)`;
      }

      // 글자별 채움 + 마우스 근접 반응 + 클릭 물결
      const w = 0.16;
      const a0 = 0.10;
      const b0 = 0.96 - w;
      for (let k = 0; k < n; k++) {
        const st = n > 1 ? a0 + (b0 - a0) * (k / (n - 1)) : a0;
        const f = Math.max(0, Math.min(1, (pe - st) / w));
        const span = spans[k];
        if (f !== lastF[k] || (f > 0 && f < 1)) {
          if (f >= 1 && lastF[k] >= 0 && lastF[k] < 1) pops[k] = now;
          paintFill(span, f);
          lastF[k] = f;
        }
        const c = centers[k];
        if (!c) continue;
        const dx = mx - c.x;
        const dyv = my - c.y;
        const prox = Math.exp(-(dx * dx + dyv * dyv) / (2 * 130 * 130));
        let dy = -16 * prox;
        let sc = 1 + 0.05 * prox;
        for (const wv of waves) {
          const wdt = (now - wv.t0) / 1000;
          if (wdt < 1.4) {
            const ph = wdt * 7 - Math.abs(c.x - wv.x) / 70;
            if (ph > 0 && ph < Math.PI) dy -= 16 * Math.sin(ph) * (1 - wdt / 1.4);
          }
        }
        const pd = (now - pops[k]) / 1000;
        if (pd >= 0 && pd < 0.45) sc += 0.14 * Math.sin((Math.PI * pd) / 0.45);
        span.style.transform = `translateY(${dy.toFixed(2)}px) scale(${sc.toFixed(3)})`;
        span.style.filter =
          doneRef.current && prox > 0.03
            ? `hue-rotate(${(prox * 18).toFixed(0)}deg) brightness(${(1 + prox * 0.28).toFixed(2)}) saturate(${(1 + prox * 0.25).toFixed(2)})`
            : "";
      }

      waves = waves.filter((wv) => now - wv.t0 < 1400);
      drawParts(dt);
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
      if (sparkles && Math.random() < 0.35) spawn(e.clientX, e.clientY, 1, 0.7);
    };
    const onClick = (e: MouseEvent) => {
      spawn(e.clientX, e.clientY, 26, 1);
      waves.push({ t0: performance.now(), x: e.clientX });
    };

    root.addEventListener("mousemove", onMove);
    root.addEventListener("click", onClick);
    window.addEventListener("resize", measure);

    measure();
    if (document.fonts?.ready) void document.fonts.ready.then(measure);
    const m1 = window.setTimeout(measure, 150);
    const m2 = window.setTimeout(measure, 800);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(m1);
      window.clearTimeout(m2);
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("click", onClick);
      window.removeEventListener("resize", measure);
    };
  }, [durationMs, sparkles]);

  // 원형 와이프로 화면을 덮은 뒤 스플래시 전체를 페이드아웃시키고 앱을 드러낸다.
  const enter = useCallback(() => {
    if (!doneRef.current || leavingRef.current) return;
    leavingRef.current = true;
    const wipe = wipeRef.current;
    if (wipe) {
      wipe.style.transition = "clip-path 0.9s cubic-bezier(.7,0,.3,1)";
      wipe.style.clipPath = "circle(142% at 50% 50%)";
    }
    window.setTimeout(() => setLeaving(true), 900);
    window.setTimeout(onFinish, 1400);
  }, [onFinish]);

  // "Press Any Button" — 100% 이후 아무 키나 누르면 앱으로 넘어간다.
  // 조합키 자체(Shift/Ctrl/Alt/Meta)는 단독으로 눌린 것이므로 무시한다.
  useEffect(() => {
    if (!done) return;
    const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIERS.has(e.key)) return;
      e.preventDefault();
      enter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done, enter]);

  const letters = [
    ...MAIN_TEXT.split("").map((ch, i) => ({ ch, i, main: true })),
    ...SUB_TEXT.split("").map((ch, i) => ({ ch, i: i + MAIN_TEXT.length, main: false })),
  ];

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Iron Device Corporation 로딩 화면"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        overflow: "hidden",
        background: LIGHT.bg,
        fontFamily: "'Exo 2', system-ui, sans-serif",
        cursor: "crosshair",
        opacity: leaving ? 0 : 1,
        transition: "opacity 0.5s ease",
      }}
    >
      <div
        ref={deco1Ref}
        style={{
          position: "absolute", left: "7%", top: "10%",
          width: "34vmin", height: "34vmin",
          border: `1.5px solid ${LIGHT.fill}`, opacity: 0.06,
        }}
      />
      <div
        ref={deco2Ref}
        style={{
          position: "absolute", right: "9%", bottom: "13%",
          width: "22vmin", height: "22vmin",
          border: `1.5px solid ${LIGHT.edge}`, opacity: 0.09,
        }}
      />
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />

      <div
        style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "3vw" }}>
          <div
            ref={diamondRef}
            style={{
              width: "clamp(44px,7.5vw,92px)", height: "clamp(44px,7.5vw,92px)",
              position: "relative", flex: "none", marginTop: "0.2em",
              transform: "rotate(-18deg)",
            }}
          >
            <div style={{ position: "absolute", inset: 0, background: LIGHT.gray }} />
            <div
              ref={diamondFillRef}
              style={{ position: "absolute", inset: 0, background: LIGHT.edge, clipPath: "inset(100% 0 0 0)" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: "clamp(40px,8vw,100px)", fontWeight: 800, lineHeight: 1.05,
                color: LIGHT.gray, userSelect: "none",
              }}
            >
              {letters.filter((l) => l.main).map((l) => (
                <span
                  key={l.i}
                  ref={setSpan(l.i)}
                  style={{
                    display: "inline-block",
                    minWidth: l.ch === " " ? "0.38em" : "0em",
                    willChange: "transform",
                  }}
                >
                  {l.ch === " " ? " " : l.ch}
                </span>
              ))}
            </div>
            <div
              style={{
                display: "flex", justifyContent: "space-between", marginTop: "0.2em",
                fontSize: "clamp(15px,2.7vw,34px)", fontWeight: 600, lineHeight: 1,
                color: LIGHT.gray, userSelect: "none",
              }}
            >
              {letters.filter((l) => !l.main).map((l) => (
                <span key={l.i} ref={setSpan(l.i)} style={{ display: "inline-block", willChange: "transform" }}>
                  {l.ch}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute", left: "50%", bottom: 38, transform: "translateX(-50%)",
          fontSize: 15, fontWeight: 600, letterSpacing: "0.35em", textIndent: "0.35em",
          color: LIGHT.pct, fontVariantNumeric: "tabular-nums",
        }}
      >
        {percent}%
      </div>
      <div
        style={{
          position: "absolute", right: 22, bottom: 20,
          fontSize: 11, fontWeight: 500, letterSpacing: "0.16em", color: LIGHT.hint,
        }}
      >
        Press Any Button
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: LIGHT.track }}>
        <div
          ref={barRef}
          style={{ height: "100%", width: "0%", background: `linear-gradient(90deg, ${LIGHT.fill}, ${LIGHT.edge})` }}
        />
      </div>

      <div
        ref={wipeRef}
        style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(135deg, ${LIGHT.fill}, ${LIGHT.edge})`,
          clipPath: "circle(0% at 50% 50%)",
          pointerEvents: "none",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{ width: 60, height: 60, background: "#FFFFFF", transform: "rotate(-18deg)", opacity: 0.92 }} />
      </div>
    </div>
  );
}
