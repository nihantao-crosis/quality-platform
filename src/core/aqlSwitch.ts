/**
 * AQL 转移规则 — GB/T 2828.1 / ISO 2859-1 正常/加严/放宽状态机（教学简化模型）。
 *
 * 转移条件（简化）：
 *   正常 → 加严：连续 5 批中 ≥2 批拒收
 *   加严 → 正常：连续 5 批接收
 *   正常 → 放宽：连续 10 批接收
 *   放宽 → 正常：任 1 批拒收
 *
 * 方案简化：加严 = 同 n、Ac−1（下限 0,Ac 已为 0 时不再减、与正常同）；
 * 放宽 = 字码降两档取更小 n、二项估 Ac（字码已到最小档 A/B 时触底,退化为与正常相同样本量）。
 * 生产环境应使用标准正式表格 2-B/2-C（见交接文档 §8.6 备注）。
 */
import { aqlPlan, acceptNumber, CODE_SEQUENCE, N_BY_CODE, type InspectionLevel, type SamplingPlan, type AqlMethod, type AqlAcMethod } from './aql';

export type InspState = 'normal' | 'tightened' | 'reduced';
export type BatchResult = 'A' | 'R'; // 接收 / 拒收

export interface SwitchStatus {
  state: InspState;
  history: BatchResult[]; // 全部历史（新在后）
  sinceSwitch: BatchResult[]; // 当前状态下的历史
  note: string; // 最近一次转移说明
}

export const SWITCH_INIT: SwitchStatus = { state: 'normal', history: [], sinceSwitch: [], note: '初始为正常检验' };

export function recordBatch(s: SwitchStatus, r: BatchResult): SwitchStatus {
  const history = [...s.history, r];
  const since = [...s.sinceSwitch, r];
  let state = s.state;
  let note = s.note;
  let sinceSwitch = since;

  if (s.state === 'normal') {
    const last5 = since.slice(-5);
    if (last5.filter((x) => x === 'R').length >= 2) {
      state = 'tightened';
      note = '连续 5 批中 2 批拒收 → 转加严检验';
      sinceSwitch = [];
    } else if (since.length >= 10 && since.slice(-10).every((x) => x === 'A')) {
      state = 'reduced';
      note = '连续 10 批接收 → 转放宽检验';
      sinceSwitch = [];
    }
  } else if (s.state === 'tightened') {
    if (since.length >= 5 && since.slice(-5).every((x) => x === 'A')) {
      state = 'normal';
      note = '加严下连续 5 批接收 → 恢复正常检验';
      sinceSwitch = [];
    }
  } else {
    // reduced
    if (r === 'R') {
      state = 'normal';
      note = '放宽下出现拒收批 → 恢复正常检验';
      sinceSwitch = [];
    }
  }
  return { state, history, sinceSwitch, note };
}

/** 三种状态下的抽样方案（简化模型） */
export function plansByState(
  lot: number, level: InspectionLevel, aql: number,
  method: AqlMethod = 'gb', acMethod: AqlAcMethod = 'gb',
): Record<InspState, SamplingPlan> {
  const normal = aqlPlan(lot, level, aql, method, acMethod);
  const tightened: SamplingPlan = { ...normal, ac: Math.max(0, normal.ac - 1), re: Math.max(1, normal.ac) };
  // 放宽(简化模型,非正式表 2-C):在正常最终字码基础上降两档取更小样本量,Ac 用二项估。
  // 注:此处用二项而非再查表 2-A——表 2-A 的箭头可能把小字码又弹回大样本,反而使"放宽"样本不减小。
  const idx = CODE_SEQUENCE.indexOf(normal.code);
  const rIdx = Math.max(0, (idx < 0 ? 0 : idx) - 2);
  const rCode = CODE_SEQUENCE[rIdx];
  const rN = N_BY_CODE[rCode];
  const rAc = acceptNumber(rN, aql);
  const reduced: SamplingPlan = { code: rCode, n: rN, ac: rAc, re: rAc + 1 };
  return { normal, tightened, reduced };
}
