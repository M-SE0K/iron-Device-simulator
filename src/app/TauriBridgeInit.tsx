"use client";

// TauriBridgeInit — Tauri shim(src/shared/lib/tauri-bridge)을 모듈 평가 시점(동기)에
// 설치하기 위한 부트스트랩. 아무것도 렌더링하지 않는다 — 이 컴포넌트의 유일한 역할은
// "import되어 모듈이 평가되는 것" 자체다.
//
// installTauriBridge() 내부에서 typeof window / '__TAURI_INTERNALS__' 가드를 하므로,
// Next 정적 export가 이 레이아웃을 서버(Node)에서 렌더링할 때도 안전하다 — 이 컴포넌트는
// 렌더 시점에 window를 참조하지 않는다(모듈 스코프의 installTauriBridge() 호출만 window를
// 만진다). layout.tsx의 정적 import로 이 모듈이 RootLayout 렌더 전에 평가되며, 모듈
// 스코프에서 installTauriBridge()를 동기 호출한다.
import { installTauriBridge } from "@/shared/lib/tauri-bridge";

installTauriBridge();

export default function TauriBridgeInit() {
  return null;
}
