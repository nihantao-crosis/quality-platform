import { nf, type CapabilityInputOptions, type SpcChartContext, type SpecLimits, type VarModel } from '../core';

/**
 * 通用报告控制图的限值绘制：分阶段(assessSpcCharts 第 5 参 active)时按段内步进限值画线，
 * 与红点所依据的段内判异同一口径；未分阶段返回空对象(全局限值)。
 */
export function stagedChartProps(chart: SpcChartContext): {
  clSeries?: number[]; uclSeries?: number[]; lclSeries?: number[]; stepSeries?: boolean; stageBoundaries?: number[];
} {
  return chart.clSeries && chart.uclSeries && chart.lclSeries
    ? { clSeries: chart.clSeries, uclSeries: chart.uclSeries, lclSeries: chart.lclSeries, stepSeries: true, stageBoundaries: chart.stageBoundaries }
    : {};
}

/**
 * 通用报告能力段选项：能力输入选项 + 稳定性口径披露(CORE-09/UI-12)。
 * stabilityCaliberText 取 capabilityStabilityCaliber(...).text——能力稳定性有意按全局控制限/子组图
 * 评估,与 SPC 段(分阶段或 I-MR 视图)口径不同时,四种格式的能力段都必须写明,否则两段计数无从对账。
 */
export interface ReportCapabilityOptions extends CapabilityInputOptions {
  stabilityCaliberText?: string | null;
}

/** 能力段口径披露行;口径与 SPC 段一致(无披露文本)时返回 null。 */
export function capabilityCaliberLine(options: ReportCapabilityOptions, capabilitySpcViolations: number): string | null {
  const text = options.stabilityCaliberText;
  return text ? `能力稳定性口径：${text}（能力口径控制图累计 ${capabilitySpcViolations} 个失控点）` : null;
}

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

/**
 * 规格限数值的唯一显示口径(PLATFORM-07):按用户输入原值展示,绝不定点四舍五入。
 * 此前 HTML/Word/PPT/文本报告用 toFixed(2),把 9.995/10.005 印成 9.99/10.01、
 * 平面度 USL=0.002 印成 0.00,与同一次导出的 Excel 和实际参与 Cp/Cpk 计算的规格不一致。
 * - 仅当输入确属浮点残差(与 12 位有效数字的差不超过 4 ulp,如 0.1+0.2)时才按 12 位去残差,
 *   否则保留 String(value) 的最短表示——13 位以上有效数字的录入(99.9999999999999)不被改写;
 * - 不足 2 位小数时补到 2 位(沿用报告既有形制「25.00 / 25.20」),多于 2 位时原样保留;
 * - 极小/极大值按 JS 最短表示走科学计数,不截断。
 * 五种出口(HTML/Word/PPT/文本/Excel)、能力专项报告(reportSpecDetailText)与能力页/页头
 * 副标题共用本函数,同一份规格只有一组数字(报告数值与页面同源)。 */
export function specLimitText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(12));
  const cleaned = Math.abs(value - rounded) <= 4 * Math.abs(value) * Number.EPSILON ? rounded : value;
  const text = String(cleaned);
  if (/e/i.test(text)) return text;
  const dot = text.indexOf('.');
  const decimals = dot < 0 ? 0 : text.length - dot - 1;
  return decimals >= 2 ? text : cleaned.toFixed(2);
}

export function formatSpecLimit(value: number | null, missingLabel: string): string {
  return value == null ? missingLabel : specLimitText(value);
}

/** 关闭的一侧明确显示为“—”，不能把 store 中暂存的数值冒充启用规格。
 * 不接受位数参数:规格是用户录入的图纸值,任何出口都不得另按定点位数改写(PLATFORM-07)。 */
export function reportSpecText(spec: SpecLimits): string {
  return `${formatSpecLimit(spec.lsl, '无下限')} / ${formatSpecLimit(spec.tgt, '—')} / ${formatSpecLimit(spec.usl, '无上限')}`;
}

/** 定点文本里的有效数字位数(去掉符号、小数点与前导零;尾随 0 计入)。 */
function fixedSignificantDigits(text: string): number {
  return text.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
}

/**
 * 报告层统计量的显示口径(PLATFORM-14):常规量级沿用固定 digits 位小数(与页面 nf 同形制);
 * 当 toFixed(digits) 只剩不到 3 位有效数字时,改按有效数字输出(位数 = clamp(digits, 3, 6))——
 * 此前 SI 单位记录的小量级数据(电容 4.7e-9 F、形位误差 1e-5 m)的均值/σ/控制限被印成 0.0000,
 * 与同表 Cpk=28.66 自相矛盾;fix2609k 复审:旧阈值只保证 2 位有效数字,4.7e-7 数据的描述统计仍被
 * 截成 "0.00000047",与同一份报告的 4.70262e-7 对不上,故阈值提到 3 位。
 * - digits ≤ 2 的调用(α、百分比、df)只在定点结果为 0 时才切换:fmt(0.05,2) 仍是 "0.05";
 * - scale(可选,数据尺度如响应列 max|y|):|v| ≤ scale×1e-12 视为浮点噪声按 0 输出——常规量级数据的
 *   DOE 效应/系数不能把 3.331e-16 当有效值印成科学计数(页面同一格显示 0.000);
 * - 0、非有限值与有效数字足够的常规量级输出与 nf 逐字相同(既有报告形制不变)。
 * 原始观测不走本函数的定点口径,见 reportRawFormatter(全精度)。
 */
export function reportNum(value: number, digits: number, scale?: number): string {
  if (!Number.isFinite(value) || value === 0) return nf(value, digits);
  if (scale != null && Number.isFinite(scale) && scale > 0 && Math.abs(value) <= scale * 1e-12) return nf(0, digits);
  const fixed = nf(value, digits);
  const minSignificant = digits <= 2 ? 1 : 3;
  if (fixedSignificantDigits(fixed) >= minSignificant) return fixed;
  return value.toPrecision(Math.max(3, Math.min(digits, 6)));
}

/** 原始观测的定点显示至少保留的有效数字位数(远超任何量测分辨率;demo 的随机双精度数据按此仍走定点)。 */
const RAW_FIXED_MIN_SIGNIFICANT = 10;

/**
 * 原始观测表的格式化器(fix2609k PLATFORM-14 残余):原始观测是用户录入/导入的数据,报告不能按
 * 统计量的定点位数截断(4.703e-7 在 toFixed(8) 下成了 "0.00000047",同表控制限却是 4.703e-7)。
 * 按整张表一次性决定形制,同表不混用:
 * - 表内每个有限值的 digits 位定点文本都「无损」(与其 15 位有效数字的值相等)或至少保留
 *   10 位有效数字 → 沿用定点 digits 位(常规量级数据与既有报告逐字相同,Excel 数字格式不变);
 * - 否则整表改为全精度最短表示 String(Number(v.toPrecision(15)))(去浮点残差,不截断),
 *   专项 Excel 经 xlsxTableCell 回读即原始 double。
 * 扫描遇到第一个需要切换的值即停止;非有限值由调用方处理。
 */
export function reportRawFormatter(values: Iterable<number>, digits = 8): (value: number) => string {
  let fixedIsFaithful = true;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const fixed = nf(value, digits);
    if (Number(fixed) === Number(value.toPrecision(15))) continue;
    if (fixedSignificantDigits(fixed) >= RAW_FIXED_MIN_SIGNIFICANT) continue;
    fixedIsFaithful = false;
    break;
  }
  return fixedIsFaithful
    ? (value) => nf(value, digits)
    : (value) => (Number.isFinite(value) ? String(Number(value.toPrecision(15))) : String(value));
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
  // PLATFORM-06:先限长再清洗——此前在完整原串上跑 /[. ]+$/,「长串点/空格 + 普通字符结尾」
  // 触发二次方回溯(8 万字符 ≈2.5s),而项目名/数据集名不限长,可卡死主线程。
  // PLATFORM-18:只在码点边界截断——按 UTF-16 码元硬切会把 emoji/CJK 扩展 B 的代理对切成孤立高代理,
  // 桌面端 Tauri IPC(serde_json)拒收整个请求,保存对话框打不开。
  let out = clipFileNameUnits(raw)
    // 非法字符 + 全部 C0/C1 控制字符(含 NUL)
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex -- 目标正是剥掉控制字符
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '_')
    // 原串自带的孤立代理项(畸形文件名)同样不能进 IPC
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_');
  // Windows 不允许文件名以点或空格结尾(线性扫描,不用回溯正则)
  out = trimTrailingDotsAndSpaces(out);
  if (WINDOWS_RESERVED_NAMES.test(out)) out = trimTrailingDotsAndSpaces(clipFileNameUnits(`_${out}`));
  return out || '未命名';
}

/** 截到 ≤ MAX_FILE_NAME_CHARS 个 UTF-16 码元,只在码点边界处切(不拆代理对);只看前缀,与原串长度无关。
 * 预算仍按码元计:星平面字符 2 码元 = UTF-8 4 字节,80 码元 ≤ 240 字节,不放宽文件系统字节上限。 */
function clipFileNameUnits(text: string): string {
  if (text.length <= MAX_FILE_NAME_CHARS) return text;
  let end = MAX_FILE_NAME_CHARS;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

function trimTrailingDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x2e && code !== 0x20) break;
    end -= 1;
  }
  return text.slice(0, end);
}

/** HTML 转义唯一实现(曾在 htmlReport 与 projectSummary 各有一份,覆盖字符还不一致)。 */
export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 带标签的规格明细文本(LSL=… / Target=… / USL=…;单侧写「无下限/无上限」)。
 * fix2609k:数值与 reportSpecText 同源(specLimitText),不再接受位数参数——此前能力专项报告按
 * toFixed(6) 把 4.5e-9 F 的规格印成「LSL=0.000000」,与通用报告的 4.5e-9 不一致。 */
export function reportSpecDetailText(spec: SpecLimits): string {
  const part = (label: string, value: number | null) => (value == null ? `无${label === 'LSL' ? '下限' : '上限'}` : `${label}=${specLimitText(value)}`);
  return `${part('LSL', spec.lsl)} / Target=${specLimitText(spec.tgt)} / ${part('USL', spec.usl)}`;
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
