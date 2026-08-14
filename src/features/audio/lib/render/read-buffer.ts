/**
 * 차트 스토어들이 "지금 보이는 구간"을 담아 내보낼 때 쓰는 출력 버퍼.
 *
 * **호출자가 소유하고 재사용한다.** 스토어가 내부 버퍼의 뷰를 그대로 내보내지 않는 이유는,
 * push/addBlock/compact가 데이터 도착 태스크에서 내부 버퍼를 제자리 변경하기 때문이다 —
 * 밖으로 나간 뷰는 다음 프레임이 도착하는 순간 오염된다(예전 readAligned()들이 매번
 * 복사본을 만들어 돌려주던 것과 같은 이유). 버퍼 소유권을 호출자에게 넘기면 "이 버퍼를
 * 읽는 건 나뿐"을 소유자가 보장할 수 있고, 프레임마다 새 배열을 만들 필요도 없어진다.
 */
export interface SeriesReadBuffer {
  xs: Float64Array;
  ys: Float64Array;
}

/**
 * 한 번 읽기로 낼 수 있는 최대 점 수. 픽셀 열 하나가 2점이므로 4,096열 —
 * 4K(3840 CSS px) 전폭을 100% 배율로 띄워도 남는다. 버퍼 한 쌍의 비용은
 * 8192 × 8 B × 2 = 128 KB로, 차트마다 하나씩 들고 있어도 부담이 없다.
 */
export const MAX_READ_POINTS = 8192;

/** 인스턴스가 아직 없어 view 없이 시드로 읽힐 때 소스들이 공통으로 쓰는 기본 픽셀 폭. */
export const SEED_PX_WIDTH = 1024;

export function createReadBuffer(points: number = MAX_READ_POINTS): SeriesReadBuffer {
  return { xs: new Float64Array(points), ys: new Float64Array(points) };
}
