"use client";

// echarts-for-react는 내부에서 window/DOM에 직접 접근하므로 SSR 단계에서 로드하면 터진다.
// 차트를 쓰는 곳마다 같은 dynamic import를 반복하지 않도록 여기 한 곳에서만 감싼다.
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export default ReactECharts;
