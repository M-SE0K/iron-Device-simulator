export interface SeriesReadBuffer {
  xs: Float64Array;
  ys: Float64Array;
}

const MAX_READ_POINTS = 8192;

/* 한 번의 readRange 가 낼 수 있는 최대 컬럼 수(포인트 2개/컬럼). 컬럼 격자를 재현해야
 * 하는 쪽(ChannelWaveStore.pointAt)이 버퍼 없이도 같은 상한을 쓰도록 노출한다. */
export const MAX_READ_COLUMNS = MAX_READ_POINTS >> 1;

export const SEED_PX_WIDTH = 1024;

export function createReadBuffer(points: number = MAX_READ_POINTS): SeriesReadBuffer {
  return { xs: new Float64Array(points), ys: new Float64Array(points) };
}
