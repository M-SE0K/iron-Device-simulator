export interface SeriesReadBuffer {
  xs: Float64Array;
  ys: Float64Array;
}

const MAX_READ_POINTS = 8192;

export const SEED_PX_WIDTH = 1024;

export function createReadBuffer(points: number = MAX_READ_POINTS): SeriesReadBuffer {
  return { xs: new Float64Array(points), ys: new Float64Array(points) };
}
