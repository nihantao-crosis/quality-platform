import { niceTicks, tickFormatter } from '../tokens';

/**
 * Leave ordinary coordinates completely untouched.  Near Number's boundary,
 * switch every value on an axis to one shared power-of-two coordinate system.
 * Division by that factor is an exact exponent shift, so it does not introduce
 * the decimal rounding drift that an arbitrary normalisation factor would.
 */
const EXTREME_AXIS_THRESHOLD = Number.MAX_VALUE / 64;

export interface PowerOfTwoAxis {
  /** 1 for ordinary inputs; otherwise an exactly representable power of two. */
  readonly scale: number;
  readonly scaled: boolean;
  /** Convert a source-unit value to the shared, overflow-safe coordinate. */
  coordinate(value: number): number;
  /** Restore a derived coordinate for labels without ever returning infinity. */
  restore(coordinate: number): number;
}

export interface AxisTick {
  /** Position in the shared coordinate domain. */
  coordinate: number;
  /** Finite value restored to the source unit. */
  value: number;
  /** Axis-wide, source-unit label. */
  label: string;
}

/** Pick one common power-of-two scale for every finite value used by an axis. */
export function createPowerOfTwoAxis(values: readonly number[]): PowerOfTwoAxis {
  let maximum = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const magnitude = Math.abs(value);
    if (magnitude > maximum) maximum = magnitude;
  }
  const scale = maximum > EXTREME_AXIS_THRESHOLD
    ? 2 ** Math.min(1023, Math.floor(Math.log2(maximum)))
    : 1;

  const restore = (coordinate: number): number => {
    if (!Number.isFinite(coordinate)) {
      if (Number.isNaN(coordinate) || coordinate === 0) return 0;
      return coordinate < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
    }
    if (coordinate === 0) return coordinate;
    const value = coordinate * scale;
    if (Number.isFinite(value)) return value;
    return coordinate < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
  };

  return {
    scale,
    scaled: scale !== 1,
    coordinate: (value) => value / scale,
    restore,
  };
}

export interface CoordinateDomainOptions {
  /** Fraction of a non-constant span added on each side. */
  padding: number;
  /** Source-unit half-width used for an ordinary constant series. */
  constantHalf?: number;
  /** Relative half-width used for a constant series (for example 10%). */
  constantRelative?: number;
  /** Relative fallback used only when a source-unit constantHalf is below one ulp. */
  extremeConstantRelative?: number;
}

/**
 * Compute range and padding exclusively in the shared coordinate domain.
 * `scale=1` deliberately follows the old arithmetic/order for ordinary data.
 */
export function coordinateDomain(
  axis: PowerOfTwoAxis,
  coordinates: readonly number[],
  options: CoordinateDomainOptions,
): readonly [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const coordinate of coordinates) {
    if (!Number.isFinite(coordinate)) continue;
    if (coordinate < lo) lo = coordinate;
    if (coordinate > hi) hi = coordinate;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];

  // 与 tokens.niceTicks 的亚分辨率守卫同口径:跨度只有数个 ulp(如 0.1 与 0.10000000000000002)
  // 时按常数序列处理并展开到可读宽度，不再输出只有 1 ulp 宽、刻度只剩两端点的坐标轴。
  const subUlpSpan = hi - lo <= Number.EPSILON * Math.max(Math.abs(lo), Math.abs(hi)) * 8;
  if (hi > lo && !subUlpSpan) {
    const padding = (hi - lo) * options.padding;
    const domainLo = lo - padding;
    const domainHi = hi + padding;
    if (Number.isFinite(domainLo) && Number.isFinite(domainHi) && domainHi > domainLo) {
      return [domainLo, domainHi];
    }
  }

  const sourceHalf = Math.abs(options.constantHalf ?? 1) / axis.scale;
  const relative = Math.abs(lo) * Math.max(0, options.constantRelative ?? 0);
  const extremeRelative = axis.scaled
    ? Math.abs(lo) * Math.max(0, options.extremeConstantRelative ?? options.padding)
    : 0;
  // Four ulps also covers a zero/underflowing sourceHalf at an extreme centre.
  const ulpHalf = Number.EPSILON * Math.max(1, Math.abs(lo)) * 4;
  const half = Math.max(sourceHalf, relative, extremeRelative, ulpHalf);
  const domainLo = lo - half;
  const domainHi = hi + half;
  return Number.isFinite(domainLo) && Number.isFinite(domainHi) && domainHi > domainLo
    ? [domainLo, domainHi]
    : [-1, 1];
}

/** Overflow-safe coordinate-to-pixel projection. */
export function projectCoordinate(
  coordinate: number,
  domain: readonly [number, number],
  start: number,
  length: number,
  reverse = false,
): number {
  const span = domain[1] - domain[0];
  if (!Number.isFinite(coordinate) || !(span > 0) || !Number.isFinite(span)) return start + length / 2;
  const fraction = (coordinate - domain[0]) / span;
  if (!Number.isFinite(fraction)) return start + length / 2;
  const projected = start + (reverse ? 1 - fraction : fraction) * length;
  return Number.isFinite(projected) ? projected : start + length / 2;
}

/** Restore and format a prepared coordinate tick list as one coherent axis. */
export function coordinateTicks(axis: PowerOfTwoAxis, coordinates: readonly number[]): AxisTick[] {
  const prepared: Array<{ coordinate: number; value: number }> = [];
  const seen = new Set<number>();
  for (const coordinate of coordinates) {
    if (!Number.isFinite(coordinate)) continue;
    const value = axis.restore(coordinate);
    if (!Number.isFinite(value) || seen.has(value)) continue;
    seen.add(value);
    prepared.push({ coordinate, value });
  }
  const formatter = tickFormatter(prepared.map((tick) => tick.value));
  return prepared.map((tick) => ({ ...tick, label: formatter(tick.value) }));
}

/** Minitab-style 1-2-5 ticks, calculated in the safe coordinate domain. */
export function niceCoordinateTicks(
  axis: PowerOfTwoAxis,
  domain: readonly [number, number],
  target = 5,
): AxisTick[] {
  const coordinates = niceTicks(domain[0], domain[1], target)
    .filter((value) => Number.isFinite(value) && value >= domain[0] && value <= domain[1]);
  return coordinateTicks(axis, coordinates);
}

/** Evenly-spaced ticks (descending by default), calculated before restoration. */
export function linearCoordinateTicks(
  axis: PowerOfTwoAxis,
  domain: readonly [number, number],
  count = 5,
  descending = true,
): AxisTick[] {
  const n = Math.max(1, Math.trunc(count));
  const span = domain[1] - domain[0];
  const coordinates = Array.from({ length: n }, (_, index) => {
    if (n === 1) return domain[0] + span / 2;
    const fraction = index / (n - 1);
    return descending
      ? domain[1] - span * fraction
      : domain[0] + span * fraction;
  });
  return coordinateTicks(axis, coordinates);
}
