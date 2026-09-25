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
/** SPC 专项报告在格式化前物化的「点×准则」明细硬上限。 */
export const MAX_SPC_REPORT_DETAIL_ROWS = 20000;
export const MAX_XLSX_VIOLATION_ROWS = MAX_SPC_REPORT_DETAIL_ROWS;
/** ECMA-376 / Excel 工作表的硬行数上限（包含标题行）。 */
export const MAX_XLSX_SHEET_ROWS = 1_048_576;
/** 专项报告明细表(HTML/Word)的共用行上限:观测级大表在 Word 会抛 RangeError、
 * 在 HTML 会产出数十 MB 文件并冻结浏览器。若上游已有界收集，各格式都必须如实标注。 */
export const MAX_REPORT_TABLE_ROWS = 2000;

export function tableTruncationNote(total: number, shown: number, format: string, excelHasCompleteRows = true): string {
  const nextStep = excelHasCompleteRows
    ? '完整明细请导出 Excel'
    : '为保证导出安全，未导出的明细请缩小数据范围或减少启用的判异准则';
  return `表格共 ${total} 行，${format}仅列前 ${shown} 行；${nextStep}`;
}
export const MAX_HTML_VIOLATION_ROWS = 2000;

export function violationTruncationNote(total: number, shown: number): string {
  return `已截断：共 ${total} 条判异事件，此处仅列前 ${shown} 条（计数汇总见「过程稳定性」；如需完整明细请缩小数据范围或减少启用的判异准则）`;
}

/** 软件版本标签(第三轮 P3:同一表达式曾在 4 文件重复 8 处)。 */
export function appVersionText(): string {
  return typeof __APP_VERSION__ === 'undefined' ? '开发版' : __APP_VERSION__;
}

/** 报告生成时间戳(统一 24 小时制;曾有 3 处各写一遍且 hour12 口径不一)。 */
export function timestampText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/** Windows 保留设备名:即使带扩展名也无法创建(盲审 P3)。 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
/** 导出文件名字节上限(多数文件系统按 255 字节;中文按 UTF-8 每字 3 字节保守折算)。 */
const MAX_FILE_NAME_CHARS = 80;

/**
 * 导出文件名清洗(曾有 3 处各写一遍同一正则)。
 * 盲审 P3:此前只挡 9 个 Windows 非法字符,控制字符/NUL/超长/保留设备名全放行——
 * 数据集名直接来自用户或拖入的文件名,这些都是可达输入。
 */
export function sanitizeFileName(raw: string): string {
  let out = raw
    // 非法字符 + 全部 C0/C1 控制字符(含 NUL)
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex -- 目标正是剥掉控制字符
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '_')
    // Windows 不允许文件名以点或空格结尾
    .replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED_NAMES.test(out)) out = `_${out}`;
  if (out.length > MAX_FILE_NAME_CHARS) out = out.slice(0, MAX_FILE_NAME_CHARS);
  return out || '未命名';
}

/** HTML 转义唯一实现(曾在 htmlReport 与 projectSummary 各有一份,覆盖字符还不一致)。 */
export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 带标签的规格明细文本(LSL=… / Target=… / USL=…;单侧写「无下限/无上限」)。 */
export function reportSpecDetailText(spec: SpecLimits, digits = 6): string {
  const part = (label: string, value: number | null) => (value == null ? `无${label === 'LSL' ? '下限' : '上限'}` : `${label}=${nf(value, digits)}`);
  return `${part('LSL', spec.lsl)} / Target=${nf(spec.tgt, digits)} / ${part('USL', spec.usl)}`;
}

/** 导出文件名的本地日期戳(闭环审核 P3:UTC 与正文本地时间在时区边界跨日不一致;
 * 报表/项目文件/项目汇总三处此前各写各的)。 */
export function localDateStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 指定时刻的时间戳文本(与 timestampText 同口径:24 小时制,复审 P3:
 * projectSummary 曾另写一份 toLocaleString,同一文档内页眉与逐行时间格式不一致)。 */
export function timestampTextOf(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}
