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

  getSegments(): readonly AnnotationSegment[] {
    return this.segments;
  }

  getDraft(): AnnotationPoint | null {
    return this.draft;
  }

  setDraft(point: AnnotationPoint | null) {
    if (this.draft === point) return;
    this.draft = point;
    this.bump();
  }

  addSegment(seg: AnnotationSegment) {
    this.segments.push(seg);
    this.bump();
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
