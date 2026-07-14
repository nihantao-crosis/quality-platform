/**
 * AQL 抽样检验（GB/T 2828.1 / ISO 2859-1 单次抽样）
 * 从原型 aqlPlan / rqlFor 逐字迁移（交接文档 §8.6）。
 */
import { binomCdf } from './basicMath';

export type InspectionLevel = 'I' | 'II' | 'III';
export type AqlMethod = 'shift' | 'gb';   // 字码判定:位移近似 / 国标查表
export type AqlAcMethod = 'binom' | 'gb'; // 接收数判定:二项近似 / 国标优先数列(近似主表)

/** GB/T 2828.1 主表接收数取值来自"优先数列"(不是任意整数):0,1,2,3,5,7,10,14,21,30,44… */
export const PREFERRED_AC = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 44, 63, 91, 127, 182];

export interface SamplingPlan {
  code: string; // 样本字码
  n: number; // 样本量
  ac: number; // 接收数
  re: number; // 拒收数 = Ac + 1
}

/** 批量范围 → 字码（一般检验水平 II 基准，供位移近似法） */
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

/** GB/T 2828.1 / ISO 2859-1 样本量字码表(一般检验水平 I / II / III,非均匀位移)。 */
export const CODE_LETTER_TABLE: Array<{ lo: number; hi: number; I: string; II: string; III: string }> = [
  { lo: 2, hi: 8, I: 'A', II: 'A', III: 'B' },
  { lo: 9, hi: 15, I: 'A', II: 'B', III: 'C' },
  { lo: 16, hi: 25, I: 'B', II: 'C', III: 'D' },
  { lo: 26, hi: 50, I: 'C', II: 'D', III: 'E' },
  { lo: 51, hi: 90, I: 'C', II: 'E', III: 'F' },
  { lo: 91, hi: 150, I: 'D', II: 'F', III: 'G' },
  { lo: 151, hi: 280, I: 'E', II: 'G', III: 'H' },
  { lo: 281, hi: 500, I: 'F', II: 'H', III: 'J' },
  { lo: 501, hi: 1200, I: 'G', II: 'J', III: 'K' },
  { lo: 1201, hi: 3200, I: 'H', II: 'K', III: 'L' },
  { lo: 3201, hi: 10000, I: 'J', II: 'L', III: 'M' },
  { lo: 10001, hi: 35000, I: 'K', II: 'M', III: 'N' },
  { lo: 35001, hi: 150000, I: 'L', II: 'N', III: 'P' },
  { lo: 150001, hi: 500000, I: 'M', II: 'P', III: 'Q' },
  { lo: 500001, hi: Infinity, I: 'N', II: 'Q', III: 'R' },
];

export const N_BY_CODE: Record<string, number> = {
  A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50, J: 80, K: 125, L: 200, M: 315, N: 500, P: 800, Q: 1250, R: 2000,
};

/** 字码序列(GB/T 2828.1,跳过 I/O):供"降档/升档"位移。 */
export const CODE_SEQUENCE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'];

/** 国标查表:批量 + 检验水平 → 样本字码。 */
export function codeLetterGB(lot: number, level: InspectionLevel): string {
  const row = CODE_LETTER_TABLE.find((r) => lot >= r.lo && lot <= r.hi)
    ?? (lot < 2 ? CODE_LETTER_TABLE[0] : CODE_LETTER_TABLE[CODE_LETTER_TABLE.length - 1]);
  return row[level];
}

/** 满足 binomCdf(c,n,AQL/100) ≥ 0.95 的最小 c(二项近似) */
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

/** 国标优先数列(近似主表):在优先数列中取最小满足 binomCdf≥0.95 者。
 *  与二项近似的差异集中在大样本档——ISO 主表把 Ac 吸附到优先数(如 9→10、13→14、27→30)。
 *  注:小样本+小 AQL 的"箭头改档"未实现,待原表校准。 */
export function acceptNumberGB(n: number, aqlPct: number): number {
  const p = aqlPct / 100;
  for (const c of PREFERRED_AC) {
    if (c <= n && binomCdf(c, n, p) >= 0.95) return c;
  }
  return acceptNumber(n, aqlPct); // 超出优先数列覆盖范围(极端大样本)时回落二项
}

/** 位移近似:以水平 II 批量档为基准,水平 I/III 各偏移 ∓2 位字码。 */
export function codeLetterShift(lot: number, level: InspectionLevel): string {
  let bi = LETTERS.findIndex((r) => lot >= r[1] && lot <= r[2]);
  if (bi < 0) bi = lot < 2 ? 0 : LETTERS.length - 1;
  const shift = { I: -2, II: 0, III: 2 }[level] || 0;
  const idx = Math.max(0, Math.min(LETTERS.length - 1, bi + shift));
  return LETTERS[idx][0];
}

export function aqlPlan(
  lot: number, level: InspectionLevel, aql: number,
  method: AqlMethod = 'gb', acMethod: AqlAcMethod = 'gb',
): SamplingPlan {
  const code = method === 'gb' ? codeLetterGB(lot, level) : codeLetterShift(lot, level);
  const n = N_BY_CODE[code];
  const ac = acMethod === 'gb' ? acceptNumberGB(n, aql) : acceptNumber(n, aql);
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
