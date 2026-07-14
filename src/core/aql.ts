/**
 * AQL 抽样检验（GB/T 2828.1 / ISO 2859-1 单次抽样）
 * 从原型 aqlPlan / rqlFor 逐字迁移（交接文档 §8.6）。
 */
import { binomCdf } from './basicMath';

export type InspectionLevel = 'I' | 'II' | 'III';
export type AqlMethod = 'shift' | 'gb';   // 字码判定:位移近似 / 国标查表
export type AqlAcMethod = 'binom' | 'gb'; // 接收数判定:二项近似 / 国标主表(表 2-A,箭头已解析)
export type InspectionState = 'normal' | 'tightened' | 'reduced';
export type AqlMasterTable = '2-A' | '2-B' | '2-C';

/** 主表覆盖的常用 AQL 列(%)。 */
export const AQL_COLS = [0.65, 1.0, 1.5, 2.5, 4.0, 6.5];

/**
 * GB/T 2828.1-2012（等同 ISO 2859-1:1999）一次抽样主表。
 *
 * 每格格式为“箭头解析后的最终字码 / n / Ac”，列顺序同 AQL_COLS；Re=Ac+1。
 * 2-A、2-B、2-C 已按 ISO 2859-1:1999 原表第 20–22 页逐格核对。尤其注意：
 * 2-C 的字码到样本量映射与 2-A/2-B 不同（例如 K=50），不能复用 N_BY_CODE。
 */
const MASTER_2A_RAW: Record<string, string> = {
  A: 'F 20 0|E 13 0|D 8 0|C 5 0|B 3 0|A 2 0',
  B: 'F 20 0|E 13 0|D 8 0|C 5 0|B 3 0|A 2 0',
  C: 'F 20 0|E 13 0|D 8 0|C 5 0|B 3 0|D 8 1',
  D: 'F 20 0|E 13 0|D 8 0|C 5 0|E 13 1|D 8 1',
  E: 'F 20 0|E 13 0|D 8 0|F 20 1|E 13 1|E 13 2',
  F: 'F 20 0|E 13 0|G 32 1|F 20 1|F 20 2|F 20 3',
  G: 'F 20 0|H 50 1|G 32 1|G 32 2|G 32 3|G 32 5',
  H: 'J 80 1|H 50 1|H 50 2|H 50 3|H 50 5|H 50 7',
  J: 'J 80 1|J 80 2|J 80 3|J 80 5|J 80 7|J 80 10',
  K: 'K 125 2|K 125 3|K 125 5|K 125 7|K 125 10|K 125 14',
  L: 'L 200 3|L 200 5|L 200 7|L 200 10|L 200 14|L 200 21',
  M: 'M 315 5|M 315 7|M 315 10|M 315 14|M 315 21|L 200 21',
  N: 'N 500 7|N 500 10|N 500 14|N 500 21|M 315 21|L 200 21',
  P: 'P 800 10|P 800 14|P 800 21|N 500 21|M 315 21|L 200 21',
  Q: 'Q 1250 14|Q 1250 21|P 800 21|N 500 21|M 315 21|L 200 21',
  R: 'R 2000 21|Q 1250 21|P 800 21|N 500 21|M 315 21|L 200 21',
};

const MASTER_2B_RAW: Record<string, string> = {
  A: 'G 32 0|F 20 0|E 13 0|D 8 0|C 5 0|B 3 0',
  B: 'G 32 0|F 20 0|E 13 0|D 8 0|C 5 0|B 3 0',
  C: 'G 32 0|F 20 0|E 13 0|D 8 0|C 5 0|E 13 1',
  D: 'G 32 0|F 20 0|E 13 0|D 8 0|F 20 1|E 13 1',
  E: 'G 32 0|F 20 0|E 13 0|G 32 1|F 20 1|E 13 1',
  F: 'G 32 0|F 20 0|H 50 1|G 32 1|F 20 1|F 20 2',
  G: 'G 32 0|J 80 1|H 50 1|G 32 1|G 32 2|G 32 3',
  H: 'K 125 1|J 80 1|H 50 1|H 50 2|H 50 3|H 50 5',
  J: 'K 125 1|J 80 1|J 80 2|J 80 3|J 80 5|J 80 8',
  K: 'K 125 1|K 125 2|K 125 3|K 125 5|K 125 8|K 125 12',
  L: 'L 200 2|L 200 3|L 200 5|L 200 8|L 200 12|L 200 18',
  M: 'M 315 3|M 315 5|M 315 8|M 315 12|M 315 18|L 200 18',
  N: 'N 500 5|N 500 8|N 500 12|N 500 18|M 315 18|L 200 18',
  P: 'P 800 8|P 800 12|P 800 18|N 500 18|M 315 18|L 200 18',
  Q: 'Q 1250 12|Q 1250 18|P 800 18|N 500 18|M 315 18|L 200 18',
  R: 'R 2000 18|Q 1250 18|P 800 18|N 500 18|M 315 18|L 200 18',
};

const MASTER_2C_RAW: Record<string, string> = {
  A: 'F 8 0|E 5 0|D 3 0|C 2 0|B 2 0|A 2 0',
  B: 'F 8 0|E 5 0|D 3 0|C 2 0|B 2 0|A 2 0',
  C: 'F 8 0|E 5 0|D 3 0|C 2 0|B 2 0|D 3 0',
  D: 'F 8 0|E 5 0|D 3 0|C 2 0|E 5 0|D 3 0',
  E: 'F 8 0|E 5 0|D 3 0|F 8 0|E 5 0|E 5 1',
  F: 'F 8 0|E 5 0|G 13 0|F 8 0|F 8 1|F 8 1',
  G: 'F 8 0|H 20 0|G 13 0|G 13 1|G 13 1|G 13 2',
  H: 'J 32 0|H 20 0|H 20 1|H 20 1|H 20 2|H 20 3',
  J: 'J 32 0|J 32 1|J 32 1|J 32 2|J 32 3|J 32 5',
  K: 'K 50 1|K 50 1|K 50 2|K 50 3|K 50 5|K 50 7',
  L: 'L 80 1|L 80 2|L 80 3|L 80 5|L 80 7|L 80 10',
  M: 'M 125 2|M 125 3|M 125 5|M 125 7|M 125 10|L 80 10',
  N: 'N 200 3|N 200 5|N 200 7|N 200 10|M 125 10|L 80 10',
  P: 'P 315 5|P 315 7|P 315 10|N 200 10|M 125 10|L 80 10',
  Q: 'Q 500 7|Q 500 10|P 315 10|N 200 10|M 125 10|L 80 10',
  R: 'R 800 10|Q 500 10|P 315 10|N 200 10|M 125 10|L 80 10',
};

const MASTER_TABLE_RAW: Record<InspectionState, Record<string, string>> = {
  normal: MASTER_2A_RAW,
  tightened: MASTER_2B_RAW,
  reduced: MASTER_2C_RAW,
};

/** 计算正常检验转移得分时，AQL 0.65 的“严一档”是表 2-A 的 0.40 列。 */
const MASTER_2A_040_RAW: Record<string, string> = {
  A: 'G 32 0', B: 'G 32 0', C: 'G 32 0', D: 'G 32 0',
  E: 'G 32 0', F: 'G 32 0', G: 'G 32 0', H: 'G 32 0',
  J: 'K 125 1', K: 'K 125 1', L: 'L 200 2', M: 'M 315 3',
  N: 'N 500 5', P: 'P 800 7', Q: 'Q 1250 10', R: 'R 2000 14',
};

export const TABLE_BY_STATE: Record<InspectionState, AqlMasterTable> = {
  normal: '2-A', tightened: '2-B', reduced: '2-C',
};

function parseMasterCell(row: string | undefined, aqlPct: number): SamplingPlan | null {
  const ci = AQL_COLS.indexOf(aqlPct);
  if (!row || ci < 0) return null;
  const [code, n, ac] = row.split('|')[ci].split(' ');
  return { code, n: Number(n), ac: Number(ac), re: Number(ac) + 1 };
}

/** 初始字码 + AQL + 检验状态 → 对应正式主表箭头解析后的最终方案。 */
export function masterPlanByState(state: InspectionState, initialCode: string, aqlPct: number): SamplingPlan | null {
  return parseMasterCell(MASTER_TABLE_RAW[state][initialCode], aqlPct);
}

/** 国标主表查表:初始字码 + AQL → 表 2-A 箭头解析后的最终方案。不在覆盖范围返回 null。 */
export function masterPlan2A(initialCode: string, aqlPct: number): SamplingPlan | null {
  return masterPlanByState('normal', initialCode, aqlPct);
}

/** GB/T 2828.1-2012 表 2-B（加严检验一次抽样）。 */
export function masterPlan2B(initialCode: string, aqlPct: number): SamplingPlan | null {
  return masterPlanByState('tightened', initialCode, aqlPct);
}

/** GB/T 2828.1-2012 表 2-C（放宽检验一次抽样，1999 版已取消 Ac/Re 间隙）。 */
export function masterPlan2C(initialCode: string, aqlPct: number): SamplingPlan | null {
  return masterPlanByState('reduced', initialCode, aqlPct);
}

export function oneStepTighterAql(aqlPct: number): number | null {
  const ci = AQL_COLS.indexOf(aqlPct);
  if (ci < 0) return null;
  return ci === 0 ? 0.4 : AQL_COLS[ci - 1];
}

/** 转移得分专用：返回正常检验下比当前 AQL 严一档的正式方案。 */
export function normalPlanOneStepTighter(initialCode: string, aqlPct: number): SamplingPlan | null {
  const tighter = oneStepTighterAql(aqlPct);
  if (tighter == null) return null;
  if (tighter === 0.4) {
    const cell = MASTER_2A_040_RAW[initialCode];
    if (!cell) return null;
    const [code, n, ac] = cell.split(' ');
    return { code, n: Number(n), ac: Number(ac), re: Number(ac) + 1 };
  }
  return masterPlan2A(initialCode, tighter);
}

export interface SamplingPlan {
  code: string; // 样本字码
  n: number; // 样本量
  ac: number; // 接收数
  re: number; // 拒收数 = Ac + 1
  fullInspect?: boolean; // 样本量 ≥ 批量 → 按 GB/T 2828.1 转 100% 全检(n 已夹到批量)
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

/** 批量输入的安全整数上限；国标字码表的最后一档持续覆盖到此上限。 */
export const MAX_LOT_SIZE = Number.MAX_SAFE_INTEGER;

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
  const initialCode = method === 'gb' ? codeLetterGB(lot, level) : codeLetterShift(lot, level);
  const binomOf = (code: string): SamplingPlan => {
    const n = N_BY_CODE[code];
    const ac = acceptNumber(n, aql);
    return { code, n, ac, re: ac + 1 };
  };
  // 国标主表:整格取(箭头会同时改字码/n/Ac)。表未覆盖该 AQL 时回落二项。
  const plan = acMethod === 'gb' ? masterPlan2A(initialCode, aql) ?? binomOf(initialCode) : binomOf(initialCode);
  // GB/T 2828.1:样本量 ≥ 批量时执行 100% 全检(小批量+箭头改档常触发,如批量 8 查表得 n=20)。
  if (plan.n >= lot) return { ...plan, n: lot, fullInspect: true };
  return plan;
}

/**
 * 正式 GB/T 2828.1 一次抽样方案。与 aqlPlan 的兼容/近似参数不同，本函数只查
 * 表 1 + 对应的 2-A/2-B/2-C；不支持的 AQL 会明确报错，绝不静默回落近似。
 */
export function aqlPlanByState(
  lot: number, level: InspectionLevel, aql: number, state: InspectionState,
): SamplingPlan {
  const initialCode = codeLetterGB(lot, level);
  const plan = masterPlanByState(state, initialCode, aql);
  if (!plan) throw new RangeError(`GB/T 2828.1 ${TABLE_BY_STATE[state]} 不支持字码 ${initialCode} / AQL ${aql}`);
  if (plan.n >= lot) return { ...plan, n: lot, fullInspect: true };
  return plan;
}

export type RqlResult =
  | { status: 'found'; p: number; pa: number; targetPa: number; searchMax: number }
  | { status: 'not-reached'; p: null; paAtMax: number; targetPa: number; searchMax: number }
  | { status: 'not-applicable'; p: null; reason: 'full-inspection'; targetPa: number; searchMax: number };

/**
 * RQL/LTPD：在指定搜索范围内求使 Pa ≤ targetPa 的最小批不良率 p。
 * 全检不再是抽样方案，因此不计算抽样 RQL；搜索上限处仍未达到目标时显式返回 not-reached。
 */
export function rqlForResult(plan: SamplingPlan, targetPa = 0.1, searchMax = 1): RqlResult {
  const target = Number.isFinite(targetPa) ? Math.max(0, Math.min(1, targetPa)) : 0.1;
  const maxP = Number.isFinite(searchMax) ? Math.max(0, Math.min(1, searchMax)) : 1;
  if (plan.fullInspect) return { status: 'not-applicable', p: null, reason: 'full-inspection', targetPa: target, searchMax: maxP };

  const paAtMax = binomCdf(plan.ac, plan.n, maxP);
  if (paAtMax > target) return { status: 'not-reached', p: null, paAtMax, targetPa: target, searchMax: maxP };

  // Pa(p) 单调下降，返回二分上界以保证 Pa ≤ targetPa。
  let lo = 0;
  let hi = maxP;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(plan.ac, plan.n, mid) <= target) hi = mid;
    else lo = mid;
  }
  return { status: 'found', p: hi, pa: binomCdf(plan.ac, plan.n, hi), targetPa: target, searchMax: maxP };
}

/** 数值型兼容接口；未达标或全检时返回 NaN，需区分原因时使用 rqlForResult。 */
export function rqlFor(plan: SamplingPlan): number {
  const result = rqlForResult(plan);
  return result.status === 'found' ? result.p : Number.NaN;
}

/** OC 曲线：Pa(p) = binomCdf(Ac, n, p) */
export function ocPa(plan: SamplingPlan, p: number): number {
  return binomCdf(plan.ac, plan.n, p);
}

/** 生产方风险 α = 1 − Pa(AQL)，百分数 */
export function producerRiskPct(plan: SamplingPlan, aqlPct: number): number {
  return (1 - binomCdf(plan.ac, plan.n, aqlPct / 100)) * 100;
}
