"use client";

// uPlot 공용 래퍼 — 차트를 쓰는 곳마다 인스턴스 관리를 반복하지 않도록 여기 한 곳에서만 감싼다.
// uPlot 모듈 자체는 SSR에서 import해도 안전하고(DOM 접근은 인스턴스 생성 시점), 생성은
// layout effect 안에서만 하므로 dynamic import가 필요 없다.
import { useLayoutEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export type UPlotOptions = Omit<uPlot.Options, "width" | "height">;

/**
 * React 렌더를 거치지 않는 데이터 공급원. 스트리밍 차트처럼 초당 수십~수백 번 갱신되는
 * 경우에 쓴다 — 갱신 알림이 오면 rAF로 합쳐 최대 화면 주사율(≈60Hz)로만 uPlot에 커밋하므로,
 * 도착 빈도가 아무리 높아도 그리기 횟수와 리렌더 횟수가 함께 뛰지 않는다.
 */
export interface UPlotDataSource {
  /** 갱신 알림 구독. 이펙트 의존성으로 쓰이므로 반드시 안정된 참조여야 한다. */
  subscribe: (cb: () => void) => () => void;
  /** 커밋할 데이터 스냅샷. 그릴 게 없으면 null. 참조는 매 렌더 새로 만들어도 된다. */
  read: () => { data: uPlot.AlignedData; yRange?: [number, number] } | null;
}

interface Props {
  /**
   * width/height를 제외한 uPlot 옵션. 참조가 바뀌면 인스턴스를 파괴하고 다시 만드므로
   * 호출부는 반드시 useMemo로 안정화해야 한다 — 매 데이터 틱마다 바뀌면 안 된다.
   */
  options: UPlotOptions;
  /** source를 쓰지 않는(React 상태로 데이터를 넘기는) 차트용 데이터. */
  data?: uPlot.AlignedData;
  /**
   * 있으면 data/yRange prop 대신 이쪽에서 데이터를 읽는다 — 갱신이 React 커밋을 거치지 않는다.
   */
  source?: UPlotDataSource;
  /**
   * y축 표시 범위. 스트리밍 중 창이 갱신될 때마다 함께 갱신된다 — 옵션 재생성 없이
   * 스케일만 따라가게 하기 위해 옵션이 아니라 별도 prop으로 받는다.
   * (source를 쓰는 경우엔 source.read()가 돌려주는 yRange가 우선한다.)
   */
  yRange?: [number, number];
  /** x축 전체(줌 아웃) 범위 — 생략하면 데이터 extent. (예: 채널 뷰의 [0, 전체 길이]) */
  xRange?: [number, number];
  /** 데이터 커밋(동기 캔버스 드로우) 소요 시간 보고 — perf 하네스 N12 측정용. */
  onRender?: (ms: number) => void;
  /**
   * 사용자 줌 조작(드래그/휠/더블클릭)으로 x 스케일이 바뀔 때만 호출된다 — 스트리밍
   * setData가 일으키는 내부 auto-rescale은 제외. (예: 채널 뷰의 과거 구간 온디맨드 fetch)
   */
  onUserZoom?: (min: number, max: number, zoomed: boolean) => void;
  /**
   * 데이터 시리즈별 표시 여부(인덱스 0 = 첫 데이터 시리즈). 인스턴스 재생성 없이
   * setSeries로 토글한다 — 채널 L/R/Both 전환처럼 시리즈 구성이 고정된 경우용.
   */
  seriesShow?: boolean[];
  /**
   * 라이브 스트리밍 중 x축 오른쪽 끝을 "마지막 데이터 점의 시간"이 아니라 벽시계로 추정한
   * 재생 시각에 맞춰 매 애니메이션 프레임 균일하게 전진시킨다. 데이터 도착 개수가 화면
   * 주사율의 정수배가 아닐 때(예: ~100 fps 데이터 vs 60 Hz 화면) 매 paint마다 오른쪽 끝이
   * 1칸/2칸씩 들쭉날쭉 밀려 생기던 60 Hz 버벅임(x-step aliasing)을 없앤다. 데이터 점은
   * 여전히 도착 즉시 커밋되므로(버퍼링 없음) 지연은 추가되지 않는다 — 창(뷰포트)만 시계를
   * 따라 흐른다. xRange와는 배타적이며(둘 다 있으면 streamFollow 우선), 재생 중일 때만 켠다.
   */
  streamFollow?: boolean;
  className?: string;
}

/**
 * 현재 x 스케일이 전체 범위에서 벗어나 있으면(=사용자 줌) true.
 *
 * 데이터가 1점뿐일 때는 xs[0]===xs[last]라 "전체 범위"가 폭 0으로 퇴화하는데, uPlot은
 * 이 경우 자체 rangeNum() 패딩으로 스케일에 임의의 여백을 준다(우리 커스텀 range 콜백은
 * autoScaleX가 min/max를 직접 넘길 때 우회된다). 그 패딩을 "사용자 줌"으로 오판하면
 * zoomedRef가 그 순간의 좁은 범위에 영구히 고정돼버려 — 스트리밍 시작 직후(프레임 1개
 * 도착 시점) 매번 재현되던 "자동으로 살짝 줌인된 채 고정" 버그의 원인이었다. 폭이
 * 유의미하게 벌어지기 전(포인트 2개 미만이거나 전체 범위가 사실상 0)에는 줌 판정을
 * 보류한다.
 */
function isZoomed(u: uPlot, xRange: [number, number] | null): boolean {
  const xs = u.data[0];
  if (!xs || xs.length < 2) return false;
  const full = xRange ?? [xs[0], xs[xs.length - 1]];
  if (!(full[1] - full[0] > 0)) return false;
  const min = u.scales.x.min ?? full[0];
  const max = u.scales.x.max ?? full[1];
  const tol = (full[1] - full[0]) * 1e-6 + 1e-12;
  return Math.abs(min - full[0]) > tol || Math.abs(max - full[1]) > tol;
}

/** 시리즈 수에 맞는 빈 데이터 — uPlot은 data 길이가 series 길이와 맞지 않으면 그리지 못한다. */
function emptyData(options: UPlotOptions): uPlot.AlignedData {
  return options.series.map(() => []) as unknown as uPlot.AlignedData;
}

/**
 * streamFollow 전용 줌 판정. isZoomed()의 1e-6 상대오차는 "고정 전체범위 vs 정적 데이터
 * extent" 비교용으론 적절하지만, streamFollow의 "전체 범위"는 매 프레임 시계로 다시 계산한
 * 목표값이라 호출 시점의 수 ms 지터만으로도 그 극히 촘촘한 오차범위를 넘어버려 정상 스트리밍을
 * "줌"으로 오판한다(리사이즈 등 사소한 계기로 한 번 setScale 훅이 이 경로를 타면 창이 그
 * 자리에 얼어붙는 버그의 원인이었다). 실제 사용자 줌(휠 25%/드래그 임의 구간)은 폭이나 왼쪽
 * 경계를 항상 시계 지터보다 훨씬 크게(%) 바꾸므로, 그 둘을 가르기에 충분히 관대한 임계값을 쓴다.
 */
function isZoomedFollow(u: uPlot, anchorT: number, anchorWall: number): boolean {
  const xs = u.data[0];
  if (!xs || xs.length < 2) return false;
  const elapsed = Math.max(0, (performance.now() - anchorWall) / 1000);
  const expectedMax = anchorT + elapsed;
  if (!(expectedMax > 0)) return false;
  const min = u.scales.x.min ?? 0;
  const max = u.scales.x.max ?? expectedMax;
  const tol = Math.max(expectedMax * 0.02, 0.2);
  return Math.abs(min - 0) > tol || Math.abs(max - expectedMax) > tol;
}

export default function UPlotChart({ options, data, source, yRange, xRange, onRender, onUserZoom, seriesShow, streamFollow, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);
  const zoomedRef = useRef(false);
  // true인 동안의 setScale은 우리가 유발한 내부 커밋(생성/setData) — 사용자 줌이 아니다.
  const internalCommitRef = useRef(false);
  // 최신 props를 훅/이펙트가 항상 안정된 참조로 읽을 수 있게 미러링한다.
  const dataRef = useRef<uPlot.AlignedData | null>(data ?? null);
  const yRangeRef = useRef<[number, number] | null>(yRange ?? null);
  const xRangeRef = useRef<[number, number] | null>(xRange ?? null);
  const onRenderRef = useRef(onRender);
  const onUserZoomRef = useRef(onUserZoom);
  const sourceReadRef = useRef(source?.read);
  // 인스턴스에 이미 반영된 데이터 — 재생성 직후 data effect가 같은 데이터를 중복 커밋하지 않게 한다.
  const appliedDataRef = useRef<uPlot.AlignedData | null>(null);

  dataRef.current = data ?? null;
  sourceReadRef.current = source?.read;
  // source 모드에서는 y 범위도 커밋 시점에 source.read()가 채운다 — prop으로 덮어쓰면
  // 커밋 사이에 범위가 null로 되돌아가 y축이 데이터 extent로 튄다.
  if (!source) yRangeRef.current = yRange ?? null;
  xRangeRef.current = xRange ?? null;
  onRenderRef.current = onRender;
  onUserZoomRef.current = onUserZoom;
  const seriesShowRef = useRef(seriesShow);
  seriesShowRef.current = seriesShow;
  const streamFollowRef = useRef(streamFollow);
  streamFollowRef.current = streamFollow;

  // streamFollow 앵커: 마지막으로 커밋된 데이터의 x(오디오 시각)와 그 순간의 벽시계.
  // 매 프레임 xmax = anchorTime + (now - anchorWall) 로 오른쪽 끝을 균일하게 흐르게 한다.
  const streamAnchorTimeRef = useRef<number | null>(null);
  const streamAnchorWallRef = useRef(0);

  // 현재 앵커 기준으로 x 스케일을 [0, 시계 추정 시각]으로 맞춘다. 데이터가 안 들어온
  // 프레임에도 호출돼 창이 계속 흐르게 하므로 60/120 Hz 어디서든 전진량이 일정하다.
  const applyStreamScale = (u: uPlot) => {
    const anchorT = streamAnchorTimeRef.current;
    if (anchorT == null) return;
    const elapsed = Math.max(0, (performance.now() - streamAnchorWallRef.current) / 1000);
    u.setScale("x", { min: 0, max: anchorT + elapsed });
  };

  const applySeriesShow = (u: uPlot) => {
    const show = seriesShowRef.current;
    if (!show) return;
    show.forEach((s, i) => {
      const series = u.series[i + 1];
      if (series && series.show !== s) u.setSeries(i + 1, { show: s });
    });
  };

  // 컨테이너 크기에 맞춤 — uPlot 루트에는 캔버스 밖 legend DOM이 붙을 수 있어 그 높이를 뺀다.
  const sizeToContainer = (u: uPlot, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const legend = u.root.querySelector<HTMLElement>(".u-legend");
    const legendHeight = legend?.offsetHeight ?? 0;
    const width = Math.max(0, Math.floor(rect.width));
    const height = Math.max(0, Math.floor(rect.height - legendHeight));
    if (width > 0 && height > 0) u.setSize({ width, height });
  };

  // 인스턴스 생성/파괴 — options 참조가 바뀔 때만.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const merged: uPlot.Options = {
      width: Math.max(1, Math.floor(el.getBoundingClientRect().width)),
      height: Math.max(1, Math.floor(el.getBoundingClientRect().height)),
      ...options,
      scales: {
        ...options.scales,
        x: {
          time: false,
          ...options.scales?.x,
          // range를 커스텀하지 않는다 — 기본값(snapNumX)은 uPlot이 요청한 dataMin/dataMax를
          // 그대로 통과시키는데, 예전엔 여기서 xRangeRef.current를 무조건 덮어썼다. 그러면
          // 드래그 셀렉트·휠 줌이 계산한 실제 확대 범위(예: 3.7~9.5초)까지 고정 범위로
          // 되돌려버려 xRange가 있는 차트(채널 파형/보호 감쇠 비교)의 줌 자체가 항상
          // 무효화됐다 — "확대해도 안 먹힌다" 버그의 원인. 대신 "줌 안 된 상태에서 xRange로
          // 되돌리기"는 아래 setData 커밋 시점(줌이 아닐 때만)에 명시적으로 한 번 더
          // setScale해서 처리하고, 더블클릭 리셋 보정은 uplot-plugins.ts의 zoomPlugin이
          // getFullXRange로 맡는다.
        },
        y: {
          ...options.scales?.y,
          range: (u, dataMin, dataMax) => yRangeRef.current ?? [dataMin, dataMax],
        },
      },
      hooks: {
        ...options.hooks,
        setScale: [
          ...(options.hooks?.setScale ?? []),
          (u, key) => {
            if (key !== "x") return;
            // 줌 상태는 사용자 조작(드래그/휠/더블클릭)으로 바뀐 스케일에서만 다시 판정한다.
            // 우리가 유발한 내부 커밋(생성/setData/streamFollow)은 스케일을 데이터 extent가
            // 아닌 값([0, 시계])으로 세팅할 수 있어, 이때 isZoomed를 돌리면 정상 스트리밍을
            // "사용자 줌"으로 오판해 창이 그 자리에 얼어붙는다.
            if (internalCommitRef.current) return;
            const anchorT = streamAnchorTimeRef.current;
            zoomedRef.current = streamFollowRef.current && anchorT != null
              ? isZoomedFollow(u, anchorT, streamAnchorWallRef.current)
              : isZoomed(u, xRangeRef.current);
            const min = u.scales.x.min;
            const max = u.scales.x.max;
            if (min != null && max != null) onUserZoomRef.current?.(min, max, zoomedRef.current);
          },
        ],
      },
    };

    // source 모드면 인스턴스를 만들 때도(옵션 변경으로 재생성될 때 포함) 항상 최신 데이터를
    // source에서 다시 읽는다 — 재생성과 스트리밍 커밋 사이에 데이터가 되돌아가지 않게 한다.
    const seed = sourceReadRef.current?.();
    if (seed?.yRange) yRangeRef.current = seed.yRange;
    const initialData = seed?.data ?? dataRef.current ?? emptyData(options);

    const t0 = performance.now();
    internalCommitRef.current = true;
    const u = new uPlot(merged, initialData, el);
    chartRef.current = u;
    appliedDataRef.current = initialData;
    zoomedRef.current = false;
    // 생성 직후 uPlot 자체 auto-range는 "지금 들어온 데이터"의 extent를 기준으로 잡는다
    // (예: 채널 파형은 아직 로드 전이라 비어있거나 극히 짧음) — xRange가 있으면(세션 전체
    // 길이처럼 데이터보다 넓은 고정 도메인) 그 쪽을 우선한다.
    if (xRangeRef.current) u.setScale("x", { min: xRangeRef.current[0], max: xRangeRef.current[1] });
    applySeriesShow(u);
    sizeToContainer(u, el);
    internalCommitRef.current = false;
    onRenderRef.current?.(performance.now() - t0);

    const ro = new ResizeObserver(() => {
      const chart = chartRef.current;
      if (!chart) return;
      // setSize()가 유발하는 내부 재계산(있다면)이 "사용자 줌"으로 오판되지 않게 감싼다 —
      // 감싸지 않으면 사이드바 접기/펼치기나 창 크기 변경만으로 스트리밍 차트(streamFollow)가
      // 줌 상태로 오판돼 멈춰버리는 버그가 있었다.
      internalCommitRef.current = true;
      sizeToContainer(chart, el);
      internalCommitRef.current = false;
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      chartRef.current = null;
      appliedDataRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  // 데이터 커밋 — uPlot은 setData 안에서 동기적으로 다시 그리므로 이 구간이 곧 렌더 시간이다.
  // ref로만 상태를 읽으므로 React 커밋(아래 data effect)과 rAF 루프(source effect)가 같은
  // 경로를 공유한다.
  const commitRef = useRef<(next: uPlot.AlignedData) => void>(() => {});
  commitRef.current = (next: uPlot.AlignedData) => {
    const u = chartRef.current;
    if (!u) return;
    appliedDataRef.current = next;

    const zoomed = zoomedRef.current;
    const yR = yRangeRef.current;
    const xR = xRangeRef.current;
    const follow = streamFollowRef.current;
    const t0 = performance.now();
    // streamFollow: 방금 커밋된 최신 데이터 시각에 벽시계 앵커를 재설정한다 — 이후 rAF가
    // 이 앵커에서 흐른 실제 시간만큼만 오른쪽 끝을 민다.
    if (follow) {
      const xs = next[0];
      if (xs && xs.length) {
        streamAnchorTimeRef.current = xs[xs.length - 1];
        streamAnchorWallRef.current = t0;
      }
    }
    internalCommitRef.current = true;
    u.batch(() => {
      // 줌 중이면 x 스케일을 유지한 채 데이터만 갱신하고(줌이 풀리지 않게), y 창만 따라간다.
      u.setData(next, !zoomed);
      if (zoomed) {
        if (yR) u.setScale("y", { min: yR[0], max: yR[1] });
      } else if (follow) {
        // x는 시계가 소유한다 — setData(data, true)가 잠깐 데이터 extent로 잡아둔 x를
        // 같은 batch 안에서 [0, 시계]로 덮어써(단일 redraw라 깜빡임 없음) 오른쪽 끝이
        // 데이터 도착 개수가 아니라 실제 흐른 시간에 비례해 균일하게 흐르게 한다. y는
        // 위 setData(data, true)의 auto-range(y.range 콜백 → yRange)가 그대로 따라간다.
        applyStreamScale(u);
      } else if (xR) {
        // setData(data, true)의 자체 auto-range는 방금 갱신된 데이터 자체의 extent로
        // 잡히는데(예: 최근 30초만 로드된 라이브 윈도우), xRange가 있는 차트는 로드된
        // 구간이 아니라 고정 도메인(예: 세션 전체 길이)을 계속 보여줘야 한다.
        u.setScale("x", { min: xR[0], max: xR[1] });
      }
    });
    internalCommitRef.current = false;
    onRenderRef.current?.(performance.now() - t0);
  };

  // passive effect가 아니라 layout effect여야 React 커밋과 같은 프레임(브라우저 paint 전)에 반영된다.
  useLayoutEffect(() => {
    if (source || !data) return;
    if (!chartRef.current || appliedDataRef.current === data) return;
    commitRef.current(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // source 모드 — 갱신 알림을 rAF 한 프레임으로 합쳐 커밋한다. 알림이 초당 수백 번 와도
  // 그리기는 화면 주사율을 넘지 않고, 탭이 백그라운드면 rAF가 멈춰 그리기 비용도 0이 된다.
  const subscribe = source?.subscribe;
  useLayoutEffect(() => {
    if (!subscribe) return;
    let frame: number | null = null;

    const commitFromSource = () => {
      frame = null;
      if (!chartRef.current) return;
      const res = sourceReadRef.current?.();
      if (!res) return;
      if (res.yRange) yRangeRef.current = res.yRange;
      commitRef.current(res.data);
    };

    const onUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(commitFromSource);
    };

    const off = subscribe(onUpdate);
    onUpdate(); // 구독 직후 현재 상태를 한 번 맞춘다(늦게 마운트된 차트의 백필)
    return () => {
      off();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [subscribe]);

  // streamFollow: 화면 표시 기회(rAF)마다 오른쪽 끝을 시계 추정 시각으로 밀어 창을 균일하게
  // 스크롤한다. 데이터가 안 들어온 프레임에도 전진하므로 도착 지터가 화면에 나타나지 않는다.
  // 사용자 줌 중(zoomedRef)에는 손대지 않아 확대 상태를 보존한다.
  // (위 source 루프는 "무엇을 그릴지"를, 이 루프는 "어디를 볼지"를 담당한다 — 서로 독립이다.)
  useLayoutEffect(() => {
    if (!streamFollow) return;
    // (재)시작 시 경과 기준을 now로 리베이스한다 — 일시정지 뒤 재개 때 정지 동안 흐른
    // 벽시계가 elapsed에 잡혀 오른쪽 끝이 훌쩍 튀는 것을 막는다.
    streamAnchorWallRef.current = performance.now();
    let raf = 0;
    const tick = () => {
      const u = chartRef.current;
      if (u && !zoomedRef.current && streamAnchorTimeRef.current != null) {
        internalCommitRef.current = true;
        applyStreamScale(u);
        internalCommitRef.current = false;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamFollow]);

  // 시리즈 표시 토글 — 재생성 없이 반영한다.
  useLayoutEffect(() => {
    const u = chartRef.current;
    if (u && seriesShow) applySeriesShow(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesShow?.join(",")]);

  // yRange/xRange만 바뀐 경우(데이터 동일)에도 스케일을 따라가게 한다.
  useLayoutEffect(() => {
    const u = chartRef.current;
    if (!u) return;
    if (!zoomedRef.current && yRange) u.setScale("y", { min: yRange[0], max: yRange[1] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yRange?.[0], yRange?.[1]]);

  return <div ref={containerRef} className={className} style={{ width: "100%", height: "100%", position: "relative" }} />;
}
