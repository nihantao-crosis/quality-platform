/**
 * AQL 抽样检验（GB/T 2828.1 / ISO 2859-1 单次抽样）
 * 从原型 aqlPlan / rqlFor 逐字迁移（交接文档 §8.6）。
 */
import { binomCdf } from './basicMath';

export type InspectionLevel = 'I' | 'II' | 'III';

export interface SamplingPlan {
  code: string; // 样本字码
  n: number; // 样本量
  ac: number; // 接收数
  re: number; // 拒收数 = Ac + 1
}

/** 批量范围 → 字码（一般检验水平 II 基准） */
export const LETTERS: Array<[string, number, number]> = [
  ['A', 2, 8],
  ['B', 9, 15],
  ['C', 16, 25],
  ['D', 26, 50],
  ['E', 51, 90],
  ['F', 91, 150],
  ['G', 151, 280],
  ['H', 281, 500],
  ['J', 501, 1200],
  ['K', 1201, 3200],
  ['L', 3201, 10000],
  ['M', 10001, 35000],
  ['N', 35001, 150000],
];

export const N_BY_CODE: Record<string, number> = {
  A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50, J: 80, K: 125, L: 200, M: 315, N: 500,
};

/** 满足 binomCdf(c,n,AQL/100) ≥ 0.95 的最小 c */
export function acceptNumber(n: number, aqlPct: number): number {
  const p = aqlPct / 100;
  let ac = 0;
  for (let c = 0; c <= n; c++) {
    if (binomCdf(c, n, p) >= 0.95) {
      ac = c;
      break;
    }
    ac = c;
  }
  return ac;
}

export function aqlPlan(lot: number, level: InspectionLevel, aql: number): SamplingPlan {
  let bi = LETTERS.findIndex((r) => lot >= r[1] && lot <= r[2]);
  if (bi < 0) bi = lot < 2 ? 0 : LETTERS.length - 1;
  const shift = { I: -2, II: 0, III: 2 }[level] || 0;
  const idx = Math.max(0, Math.min(LETTERS.length - 1, bi + shift));
  const code = LETTERS[idx][0];
  const n = N_BY_CODE[code];
  const ac = acceptNumber(n, aql);
  return { code, n, ac, re: ac + 1 };
}

/** RQL/LTPD：使 Pa ≤ 0.10 的批不良率 p */
export function rqlFor(plan: SamplingPlan): number {
  for (let i = 1; i <= 800; i++) {
    const p = i / 2000;
    if (binomCdf(plan.ac, plan.n, p) <= 0.1) return p;
  }
  return 0.4;
}

/** OC 曲线：Pa(p) = binomCdf(Ac, n, p) */
export function ocPa(plan: SamplingPlan, p: number): number {
  return binomCdf(plan.ac, plan.n, p);
}

/** 生产方风险 α = 1 − Pa(AQL)，百分数 */
export function producerRiskPct(plan: SamplingPlan, aqlPct: number): number {
  return (1 - binomCdf(plan.ac, plan.n, aqlPct / 100)) * 100;
}
