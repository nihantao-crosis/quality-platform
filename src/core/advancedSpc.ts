/**
 * 进阶控制图 — EWMA（指数加权移动平均）与 CUSUM（累积和，表格法）。
 * 对小幅过程漂移比 Shewhart 图更敏感。
 */

export interface EwmaResult {
  z: number[]; // EWMA 序列
  ucl: number[]; // 时变上限
  lcl: number[]; // 时变下限
  cl: number; // 中心线 μ0
  lambda: number;
  L: number;
  viol: Set<number>;
}

/**
 * EWMA：z_i = λx_i + (1−λ)z_{i−1}，z_0 = μ0。
 * 控制限 μ0 ± L·σ·√(λ/(2−λ)·(1−(1−λ)^{2i}))。
 * @param sigma 单点标准差（子组均值序列传 σ/√n）
 */
export function ewmaSeries(data: number[], mu0: number, sigma: number, lambda = 0.2, L = 2.7): EwmaResult {
  const z: number[] = [];
  const ucl: number[] = [];
  const lcl: number[] = [];
  const viol = new Set<number>();
  let prev = mu0;
  for (let i = 0; i < data.length; i++) {
    const zi = lambda * data[i] + (1 - lambda) * prev;
    z.push(zi);
    prev = zi;
    const w = sigma * Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * (i + 1))));
    ucl.push(mu0 + L * w);
    lcl.push(mu0 - L * w);
    if (zi > ucl[i] || zi < lcl[i]) viol.add(i);
  }
  return { z, ucl, lcl, cl: mu0, lambda, L, viol };
}

export interface CusumResult {
  cp: number[]; // 上侧累积和 C⁺
  cn: number[]; // 下侧累积和 C⁻（正值表示向下漂移量）
  H: number; // 判定限 h·σ
  K: number; // 允差 k·σ
  viol: Set<number>;
}

/**
 * CUSUM 表格法：C⁺_i = max(0, x_i − (μ0+K) + C⁺_{i−1})；C⁻ 对称。
 * 常用 k=0.5（检测 1σ 漂移）、h=4（子组）或 5（单值）。
 */
export function cusumSeries(data: number[], mu0: number, sigma: number, k = 0.5, h = 4): CusumResult {
  const K = k * sigma;
  const H = h * sigma;
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
    if (p > H || m > H) viol.add(i);
  }
  return { cp, cn, H, K, viol };
}
