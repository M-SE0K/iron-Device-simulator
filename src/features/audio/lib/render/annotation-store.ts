/**
 * 차트 위 사용자 주석(점 잇기 직선)의 소유자 — 데이터 좌표(x=초, y=시리즈 값)로 확정된
 * 선분들과 "첫 점만 찍힌" 진행 중 드래프트를 들고 있는다. ChartStore/ChannelWaveStore와
 * 같은 subscribe 패턴이라 React 상태를 거치지 않는다 — uPlot 플러그인(annotatePlugin)이
 * 직접 구독해 변경 즉시 redraw하고, 헤더 버튼(지우개 표시 여부)만 얇은 readout으로 읽는다.
 *
 * 좌표를 픽셀이 아니라 데이터 값으로 저장하므로 줌/리사이즈 후에도 선이 데이터 포인트에
 * 그대로 붙어 있다. 세션이 리셋되면(새 재생) 데이터 자체가 바뀌므로 대시보드가 clear()한다.
 */

import { SubscribableStore } from "./store-base";

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationSegment {
  a: AnnotationPoint;
  b: AnnotationPoint;
}

export class AnnotationStore extends SubscribableStore {
  private segments: AnnotationSegment[] = [];
  private draft: AnnotationPoint | null = null;

  getVersion(): number {
    return this.ver;
  }

  getSegments(): readonly AnnotationSegment[] {
    return this.segments;
  }

  getDraft(): AnnotationPoint | null {
    return this.draft;
  }

  setDraft(point: AnnotationPoint | null) {
    if (this.draft === point) return; // null → null 등 무의미한 알림을 거른다
    this.draft = point;
    this.bump();
  }

  addSegment(seg: AnnotationSegment) {
    this.segments.push(seg);
    this.bump();
  }

  removeLast() {
    if (this.segments.length === 0) return;
    this.segments.pop();
    this.bump();
  }

  get count(): number {
    return this.segments.length;
  }

  get isEmpty(): boolean {
    return this.segments.length === 0 && this.draft === null;
  }

  clear() {
    if (this.isEmpty) return;
    this.segments = [];
    this.draft = null;
    this.bump();
  }
}
