import { nf, type SpecLimits, type VarModel } from '../core';

/** 通用报告的数据结构说明：单值 I-MR 不得被误写成“n=1 的子组”。 */
export function reportShapeText(M: VarModel): string {
  return M.hasSubgroups
    ? `${M.k} 子组 × ${M.n} 测量 = ${M.all.length} 观测`
    : `${M.indiv.length} 个单值观测`;
}

/** Dashboard/Worksheet 可能让 SPC 与能力使用不同角色；报告必须把两套口径说清楚。 */
export function reportContextText(spcModel: VarModel, capabilityModel: VarModel): string {
  const spc = reportShapeText(spcModel);
  if (spcModel === capabilityModel) return spc;
  return `SPC：${spc}；能力：${reportShapeText(capabilityModel)}`;
}

/** 组内标准差估计方法随数据结构变化。 */
export function withinSigmaLabel(M: VarModel): string {
  return M.hasSubgroups ? 'σ 组内 (R̄/d₂)' : 'σ 组内 (MR̄/d₂(2))';
}

export function formatSpecLimit(value: number | null, missingLabel: string, digits?: number): string {
  if (value == null) return missingLabel;
  return digits == null ? String(value) : nf(value, digits);
}

/** 关闭的一侧明确显示为“—”，不能把 store 中暂存的数值冒充启用规格。 */
export function reportSpecText(spec: SpecLimits, digits?: number): string {
  return `${formatSpecLimit(spec.lsl, '无下限', digits)} / ${formatSpecLimit(spec.tgt, '—', digits)} / ${formatSpecLimit(spec.usl, '无上限', digits)}`;
}

/** 判异明细行硬上限(v1.42.4 审计 P2):Excel/HTML 是"完整明细"格式,但对抗性数据
 * (全准则 + 13 万行)可产出 50 万+事件,无上限会长时间冻结 UI 甚至内存耗尽。
 * 上限远超真实量测数据可能出现的事件数;截断时必须写明总数,与 Word/PPT 的截断同一形制。 */
export const MAX_XLSX_VIOLATION_ROWS = 20000;
export const MAX_HTML_VIOLATION_ROWS = 2000;

export function violationTruncationNote(total: number, shown: number): string {
  return `已截断：共 ${total} 条判异事件，此处仅列前 ${shown} 条（计数汇总见「过程稳定性」；如需完整明细请缩小数据范围或减少启用的判异准则）`;
}
