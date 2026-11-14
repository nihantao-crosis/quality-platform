/**
 * 简单线性回归 — 最小二乘 y = a + bx,含相关系数与斜率显著性检验。
 */
import { mean } from './basicMath';
import { tTwoSidedP } from './ttest';

export interface RegressionResult {
  slope: number; // b
  intercept: number; // a
  r: number; // Pearson 相关系数
  r2: number;
  seSlope: number; // 斜率标准误
  t: number; // 斜率 t 统计量
  df: number; // n − 2
  p: number; // 斜率显著性(双侧)
  significant: boolean;
  n: number;
}

/**
 * Compute value × numerator / denominator without committing to an order that can
 * overflow or underflow before the final (representable) result is formed.
 */
function scaledRatio(value: number, numerator: number, denominator: number): number {
  if (value === 0 || numerator === 0) return 0;
  const candidates = [
    (value * numerator) / denominator,
    (value / denominator) * numerator,
    (numerator / denominator) * value,
  ];
  const finiteNonzero = candidates.find((candidate) => Number.isFinite(candidate) && candidate !== 0);
  if (finiteNonzero !== undefined) return finiteNonzero;
  const finite = candidates.find(Number.isFinite);
  return finite ?? candidates[0];
}

/** Stable a - multiplier*b when multiplier*b overflows before cancellation. */
function scaledProductDifference(a: number, multiplier: number, b: number): number {
  const direct = a - multiplier * b;
  if (Number.isFinite(direct)) return direct;
  const coordinateScale = Math.max(Math.abs(a), Math.abs(b));
  if (!(coordinateScale > 0) || !Number.isFinite(coordinateScale)) return direct;
  const normalized = a / coordinateScale - multiplier * (b / coordinateScale);
  const restored = normalized * coordinateScale;
  return Number.isFinite(restored) ? restored : direct;
}

interface CenteredNormalization {
  unit: number[];
  /** 实际离差尺度 = coordinateScale × localScale。 */
  coordinateScale: number;
  localScale: number;
}

function centerUnitCoordinates(values: number[], scale: number): number[] {
  if (!(scale > 0)) return values.map(() => 0);
  const origin = values[0];
  const local = values.map((value) => (value - origin) / scale);
  const localMean = mean(local);
  const centered = local.map((value) => value - localMean);
  // mean(local) is rounded, so one subtraction does not mathematically guarantee
  // Σcentered=0. Removing the tiny remaining drift makes the no-intercept moment
  // formula below equivalent to fitting an intercept, while identical pairwise
  // differences (for example after an exactly representable translation) now
  // produce bit-identical centered coordinates.
  const drift = mean(centered);
  return drift === 0 ? centered : centered.map((value) => value - drift);
}

function normalizeCentered(values: number[]): CenteredNormalization {
  // Center relative to a represented sample value rather than the rounded absolute
  // mean. At large offsets, value-mean can acquire a common non-zero drift and the
  // later Σxy/Σxx formula then silently behaves like a regression without an
  // intercept. Pairwise offsets remain invariant under every exactly representable
  // translation.
  const origin = values[0];
  const offsets = values.map((value) => value - origin);
  const directScale = offsets.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (Number.isFinite(directScale)) {
    return {
      unit: centerUnitCoordinates(values, directScale),
      coordinateScale: directScale,
      localScale: 1,
    };
  }

  // 有限端点的差也可能超过 MAX_VALUE。先缩放坐标再中心化，
  // 可使 [-MAX, MAX, MAX] 这类合法缩放数据仍能进行推断。
  const coordinateScale = values.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    0,
  );
  const scaled = values.map((value) => value / coordinateScale);
  const scaledOrigin = scaled[0];
  const localOffsets = scaled.map((value) => value - scaledOrigin);
  const localScale = localOffsets.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    0,
  );
  return {
    unit: centerUnitCoordinates(scaled, localScale),
    coordinateScale,
    localScale,
  };
}

export function linearRegression(xs: number[], ys: number[]): RegressionResult {
  if (xs.length !== ys.length) throw new Error('回归的 X 与 Y 观测数必须相同');
  const n = xs.length;
  if (n < 3) throw new Error('回归至少需要 3 组观测');
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) {
    throw new Error('回归只接受有限数值');
  }
  const x = xs.slice(0, n);
  const y = ys.slice(0, n);
  const mx = mean(x);
  const my = mean(y);
  // 蜂群 P2-07:中心化偏差先按各自量级归一化再累计矩——直接平方在 1e-170 量级会
  // 下溢成 0 被误报「X 无变异」,在 1e154 量级会上溢成 Infinity 让统计量变 NaN,
  // 却仍被存成绿色 OK。归一化后矩是无量纲的,斜率/截距再乘回量级即可。
  const normalizedX = normalizeCentered(x);
  const normalizedY = normalizeCentered(y);
  if (!(normalizedX.coordinateScale > 0) || !(normalizedX.localScale > 0)) {
    throw new Error('X 无变异,无法回归');
  }
  const ux = normalizedX.unit;
  const uy = normalizedY.unit;
  let uxx = 0;
  let uyy = 0;
  let uxy = 0;
  for (let i = 0; i < n; i++) {
    uxx += ux[i] * ux[i];
    uyy += uy[i] * uy[i];
    uxy += ux[i] * uy[i];
  }
  if (!(uxx > 0)) throw new Error('X 无变异,无法回归');
  const normalizedSlope = uxy / uxx;
  // 斜率在归一化空间算完再乘回量级,避免中间量上/下溢。
  const normalizedScaleRatio = normalizedSlope * (normalizedY.localScale / normalizedX.localScale);
  const slope = scaledRatio(
    normalizedScaleRatio,
    normalizedY.coordinateScale,
    normalizedX.coordinateScale,
  );
  // 归一化空间已证明斜率非零，还原到当前 X/Y 单位却成了 0，只能是
  // IEEE-754 下溢。继续返回 slope=0 会把真实关系篡改为「无效应」；必须要求
  // 用户调整单位。例如 X≈1e100、Y≈1e-300 时，真实斜率≈1e-400 不可表示。
  if (normalizedSlope !== 0 && slope === 0) {
    throw new Error('回归斜率在当前 X/Y 单位下溢为 0，请先缩放数据单位后重试');
  }
  // Do not form slope*mx first: both inputs and the true intercept can be
  // finite while that intermediate product exceeds Number.MAX_VALUE (for
  // example y = 2x - 1e308 around x = 1e308).
  const intercept = scaledProductDifference(my, slope, mx);
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    throw new Error('回归结果超出可表示范围,请先缩放数据单位');
  }
  // 相关系数同样在归一化空间算,不经过可能溢出的 sxx·syy
  const rawR = uyy === 0 ? 0 : uxy / Math.sqrt(uxx * uyy);
  const r = Math.max(-1, Math.min(1, rawR));
  const r2 = r * r;
  const df = n - 2;
  // SSE、MSE 与标准误全程留在 Y 已归一化的空间。如果先还原
  // sxx/syy/sxy，1e-300 的单位会下溢为 0，1e154 的单位会上溢为 Infinity，
  // 随后 0/0 或 Infinity/Infinity 会把 t/p 污染成 NaN。直接对归一化
  // 残差求平方和还避免了 uyy − uxy²/uxx 的大数相消。
  let normalizedSse = 0;
  for (let i = 0; i < n; i++) {
    const residual = uy[i] - normalizedSlope * ux[i];
    normalizedSse += residual * residual;
  }
  // 保持既有的“完全拟合”语义：只吸收机器舍入量级的残差，
  // 阈值也是无量纲的，因此不会随 Y 单位改变。
  const roundoff = Number.EPSILON * Math.max(uyy, Math.abs(normalizedSlope * uxy)) * n * 16;
  if (normalizedSse <= roundoff) normalizedSse = 0;
  const normalizedSe = Math.sqrt((normalizedSse / df) / uxx);
  const normalizedSeScaleRatio = normalizedSe * (normalizedY.localScale / normalizedX.localScale);
  const seSlope = scaledRatio(
    normalizedSeScaleRatio,
    normalizedY.coordinateScale,
    normalizedX.coordinateScale,
  );
  if (normalizedSe > 0 && seSlope === 0) {
    throw new Error('回归斜率标准误在当前 X/Y 单位下溢为 0，请先缩放数据单位后重试');
  }
  if (!Number.isFinite(seSlope)) {
    throw new Error('回归斜率标准误超出可表示范围，请先缩放数据单位后重试');
  }
  // 零残差需要区分两种情形：常数 Y 的斜率就是 0（P=1）；完美的非水平
  // 直线则斜率标准误为 0 且斜率非零（|t|=∞, P=0）。
  // “响应恒定”是数据结构事实，不能拿斜率与 Y 的位置（均值）比较；给 Y 加常数
  // 不应改变斜率检验。完全拟合且响应并非常数时，非零斜率的 P=0。
  const constantResponse = y.every((value) => value === y[0]);
  // t 必须由归一化斜率/标准误直接相除，不能再用已还原的
  // slope/seSlope；后两者在极端但合法的单位下可能同时下溢为 0。
  const t = normalizedSe === 0
    ? (constantResponse ? 0 : Math.sign(normalizedSlope) * Infinity)
    : normalizedSlope / normalizedSe;
  const p = normalizedSe === 0 ? (constantResponse ? 1 : 0) : tTwoSidedP(t, df);
  return { slope, intercept, r, r2, seSlope, t, df, p, significant: p < 0.05, n };
}
