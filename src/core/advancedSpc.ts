/**
 * 进阶控制图 — EWMA（指数加权移动平均）与 CUSUM（累积和，表格法）。
 * 对小幅过程漂移比 Shewhart 图更敏感。
 */
import { EWMA_LAMBDA, EWMA_L } from './advancedSpcParams';

/**
 * σ̂ 相对中心线的数值分辨率下限(单位:中心线的 ulp 量级,EPSILON·|μ|)。
 * σ̂ 不大于此值时 μ ± k·σ̂ 与 μ 只差几个 ulp,控制限实际塌缩在中心线上,
 * 均值/递推的 1 ulp 舍入就会被判超限,结论随读数的二进制表示翻转。
 * 真实量具数据的 σ̂/|μ| 远大于 1e-14,不受影响。
 */
export const SPC_SIGMA_RESOLUTION_ULPS = 64;

/**
 * CORE-08(通用 σ̂ 守卫):SPC 全部图型(X̄-R/X̄-S/I-MR/EWMA/CUSUM)共用。
 * σ̂ 非有限、非正,或小于中心线的数值分辨率时,控制限塌缩到中心线,必须显式返回「不可判定」,
 * 页面、看板、工作表高亮、保存记录、专项报告与通用导出统一显示本原因,不得输出失控点或「受控」。
 * @param center 中心线(μ₀ / X̿ / X̄);非有限时只做 σ̂ 自身检查
 * @param chartName 结论主语,如「I-MR」「EWMA/CUSUM」
 */
export function spcSigmaIssue(sigma: number, center: number, chartName: string): string | null {
  if (!Number.isFinite(sigma)) return `σ̂ 不是有限数值，${chartName} 不可判定`;
  if (!(sigma > 0)) return `σ̂=0：数据无变异（组内极差/移动极差全为 0，量具分辨率不足？），${chartName} 不可判定`;
  if (Number.isFinite(center) && sigma <= Math.abs(center) * Number.EPSILON * SPC_SIGMA_RESOLUTION_ULPS) {
    return `σ̂ 小于数值分辨率（σ̂ 相对中心线仅为浮点舍入量级，读数实为常数或只有浮点尾差），${chartName} 不可判定`;
  }
  return null;
}

/**
 * CORE-08：σ̂ 非正、非有限或小于 μ₀ 的数值分辨率时 EWMA/CUSUM 控制限塌缩到中心线，
 * 任何 1 ulp 递推舍入都会被判超限，结论随读数的二进制表示翻转（0.1 判失控、0.3 不判）。
 * 此时必须显式返回「不可判定」，页面、保存记录与专项报告统一显示本原因，不得输出失控点或「受控」结论。
 * @param mu0 中心线;省略时只检查 σ̂ 非有限/非正(旧口径)
 */
export function advancedSpcSigmaIssue(sigma: number, mu0: number = Number.NaN): string | null {
  return spcSigmaIssue(sigma, mu0, 'EWMA/CUSUM');
}

export interface EwmaResult {
  z: number[]; // EWMA 序列
  ucl: number[]; // 时变上限
  lcl: number[]; // 时变下限
  cl: number; // 中心线 μ0
  lambda: number;
  L: number;
  viol: Set<number>;
  /** 非 null 时本图不可判定（σ̂=0、非有限或小于数值分辨率）：viol 恒为空，控制限仅作占位。 */
  unavailableReason: string | null;
}

/**
 * EWMA：z_i = λx_i + (1−λ)z_{i−1}，z_0 = μ0。
 * 控制限 μ0 ± L·σ·√(λ/(2−λ)·(1−(1−λ)^{2i}))。
 * @param sigma 单点标准差（子组均值序列传 σ/√n）
 */
export function ewmaSeries(data: number[], mu0: number, sigma: number, lambda = EWMA_LAMBDA, L = EWMA_L): EwmaResult {
  const unavailableReason = advancedSpcSigmaIssue(sigma, mu0);
  const z: number[] = [];
  const ucl: number[] = [];
  const lcl: number[] = [];
  const viol = new Set<number>();
  let prev = mu0;
  for (let i = 0; i < data.length; i++) {
    const zi = lambda * data[i] + (1 - lambda) * prev;
    z.push(zi);
    prev = zi;
    if (unavailableReason) {
      ucl.push(mu0);
      lcl.push(mu0);
      continue;
    }
    const w = sigma * Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * (i + 1))));
    ucl.push(mu0 + L * w);
    lcl.push(mu0 - L * w);
    if (zi > ucl[i] || zi < lcl[i]) viol.add(i);
  }
  return { z, ucl, lcl, cl: mu0, lambda, L, viol, unavailableReason };
}

export interface CusumResult {
  cp: number[]; // 上侧累积和 C⁺
  cn: number[]; // 下侧累积和 C⁻（正值表示向下漂移量）
  H: number; // 判定限 h·σ
  K: number; // 允差 k·σ
  viol: Set<number>;
  /** 非 null 时本图不可判定（σ̂=0、非有限或小于数值分辨率）：viol 恒为空，H/K 记 0 仅作占位。 */
  unavailableReason: string | null;
}

/**
 * CUSUM 表格法：C⁺_i = max(0, x_i − (μ0+K) + C⁺_{i−1})；C⁻ 对称。
 * 常用 k=0.5（检测 1σ 漂移）、h=4（子组）或 5（单值）。
 */
export function cusumSeries(data: number[], mu0: number, sigma: number, k = 0.5, h = 4): CusumResult {
  const unavailableReason = advancedSpcSigmaIssue(sigma, mu0);
  const K = unavailableReason ? 0 : k * sigma;
  const H = unavailableReason ? 0 : h * sigma;
  const cp: number[] = [];
  const cn: number[] = [];
  const viol = new Set<number>();
  let p = 0;
  let m = 0;
  for (let i = 0; i < data.length; i++) {
    p = Math.max(0, data[i] - (mu0 + K) + p);
    m = Math.max(0, mu0 - K - data[i] + m);
    cp.push(p);
    cn.push(m);
    if (!unavailableReason && (p > H || m > H)) viol.add(i);
  }
  return { cp, cn, H, K, viol, unavailableReason };
}
