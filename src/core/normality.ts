/**
 * 正态性检验 — Anderson-Darling（均值/方差未知情形，D'Agostino & Stephens 修正与 P 值）。
 */
import { mean, stdev, phi, invNorm } from './basicMath';

export interface AdResult {
  a2: number; // A² 统计量
  a2star: number; // 小样本修正 A*²
  p: number; // P 值
  normal: boolean; // p ≥ 0.05
  n: number;
}

export interface AdEvaluation {
  result: AdResult | null;
  /** result 为 null 时给用户的可操作说明。 */
  unavailableReason: string | null;
}

/**
 * 位置/尺度病态阈值(附录 F.2-4:AD 平移不变性)。
 *
 * 历史公式 z=(x−m)/s 中 m 只能取最接近的 double,舍入误差 ≤ |m|·2⁻⁵³,
 * 等于给全部 z 加上至多 (|m|/s)·1.11e-16 的共同偏移。|m|/s ≤ 1e8 时该偏移
 * ≤ 1.1e-8,远低于 P 值显示精度,常规量级(含 25.4000±0.0001 mm 这类精密量具,
 * |m|/s≈2.5e5)继续走历史路径、结果逐位不变;超过阈值(如同一组离差整体加 1e12/1e16)
 * 时偏移会达到 1e-4~1e-1 量级并翻转正态判定,此时改走中心化路径。
 */
const AD_ILL_CONDITIONED_LOCATION_RATIO = 1e8;

/**
 * 以最小观测为原点,在离差坐标内中心化后再除以 s。病态区间内全部观测与 m 的相对差
 * ≤ (n−1)/√n · s/|m| < (n−1)/√n · 1e-8,n 不超过 10¹⁵ 时彼此相差不到 2 倍,
 * x−origin 由 Sterbenz 引理精确成立;因此
 * 同一组离差加任何可精确表示的常数后,偏移量、中心与 z 逐位相同。
 */
function centeredStandardScores(sorted: readonly number[], s: number): number[] {
  const origin = sorted[0];
  const offsets = sorted.map((x) => x - origin);
  const center = mean(offsets);
  return offsets.map((offset) => (offset - center) / s);
}

export function andersonDarling(xs: number[], presorted = false): AdResult {
  const n = xs.length;
  if (n < 8) throw new Error('Anderson-Darling 检验至少需要 8 个观测');
  if (xs.some((value) => !Number.isFinite(value))) throw new Error('Anderson-Darling 检验只接受有限数值');
  const m = mean(xs);
  const s = stdev(xs, true);
  if (!(s > 0) || !Number.isFinite(s)) throw new Error('Anderson-Darling 检验要求数据具有正的有限标准差');
  // presorted:调用方(computeDescriptive)已排序时跳过重复排序
  const sorted = presorted ? xs : [...xs].sort((a, b) => a - b);
  // 常规量级沿用历史公式 (x−m)/s(逐位不变);只有位置/尺度比病态时才在离差坐标内标准化。
  const z = Math.abs(m) > AD_ILL_CONDITIONED_LOCATION_RATIO * s
    ? centeredStandardScores(sorted, s)
    : sorted.map((x) => (x - m) / s);
  const EPS = 1e-12;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const Fi = Math.min(1 - EPS, Math.max(EPS, phi(z[i])));
    const Fni = Math.min(1 - EPS, Math.max(EPS, phi(z[n - 1 - i])));
    sum += (2 * i + 1) * (Math.log(Fi) + Math.log(1 - Fni));
  }
  const a2 = -n - sum / n;
  const a2star = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p: number;
  if (a2star >= 0.6) {
    // Stephens 的尾部近似是开口向上的二次式；超出其有效区间后若继续外推，
    // 指数会在顶点后反向增大，甚至把极端非正态样本算成 p=1。顶点之后只保留
    // 最小尾概率，使 P 值随更大的 A*² 保持非增。
    const tailTurningPoint = 5.709 / (2 * 0.0186);
    const tailStatistic = Math.min(a2star, tailTurningPoint);
    p = Math.exp(1.2937 - 5.709 * tailStatistic + 0.0186 * tailStatistic * tailStatistic);
  }
  else if (a2star > 0.34) p = Math.exp(0.9177 - 4.279 * a2star - 1.38 * a2star * a2star);
  else if (a2star > 0.2) p = 1 - Math.exp(-8.318 + 42.796 * a2star - 59.938 * a2star * a2star);
  else p = 1 - Math.exp(-13.436 + 101.14 * a2star - 223.73 * a2star * a2star);
  p = Math.min(1, Math.max(0, p));
  return { a2, a2star, p, normal: p >= 0.05, n };
}

/**
 * 报告/UI 安全入口：AD 是可选诊断，不应因样本太少、常量数据或非有限值
 * 让整份报告导出失败。严格引擎入口 andersonDarling 仍保持抛错契约。
 */
export function evaluateAndersonDarling(xs: number[]): AdEvaluation {
  const n = xs.length;
  if (n < 8) {
    return { result: null, unavailableReason: `样本量不足 8 个（当前 ${n} 个），未执行 Anderson-Darling 正态性检验` };
  }
  if (xs.some((value) => !Number.isFinite(value))) {
    return { result: null, unavailableReason: '数据包含非有限值，正态性不可判定' };
  }
  const sd = stdev(xs, true);
  if (!(sd > 0) || !Number.isFinite(sd)) {
    return { result: null, unavailableReason: '数据无可估计变异，正态性不可判定' };
  }
  return { result: andersonDarling(xs), unavailableReason: null };
}

/** 正态概率图坐标：返回按值排序的 (x=观测值, z=期望正态分位数) */
export function probPlotPoints(xs: number[]): Array<{ x: number; z: number }> {
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  // 中位秩(Benard 近似 (i−0.3)/(n+0.4),与 Minitab 概率图默认一致)。
  // 第三轮 P3:此前公式实为 Blom (i−3/8)/(n+1/4),与注释/图注「中位秩」不符
  return sorted.map((x, i) => {
    const pp = (i + 1 - 0.3) / (n + 0.4);
    return { x, z: invNorm(pp) };
  });
}
