/**
 * 图表主题 tokens — 三套主题（经典/现代/高对比），从原型 tokens() 迁移（交接文档 §7）。
 */
import type { ChartStyle } from '../store/appStore';
import { nf } from '../core';

export interface ChartTokens {
  name: ChartStyle;
  /** Minitab 经典渲染模式:白底 1px 边框、无网格、UCL/LCL 红实线、CL 黑实线、黑字标签含等号、圆整刻度 */
  classic: boolean;
  bg: string;
  grid: string;
  /** 绘图区边框色(经典主题 1px 灰边框;其余主题透明) */
  frame: string;
  axis: string;
  text: string;
  center: string;
  limit: string;
  /** UCL/LCL 虚线样式;undefined = 实线(经典主题按 Minitab 用红实线) */
  limitDash: string | undefined;
  point: string;
  line: string;
  spec: string;
  bar: string;
  bar2: string;
  bar3: string;
  curve: string;
  curve2: string;
  sw: number;
  r: number;
  dash: string;
}

export function chartTokens(style: ChartStyle, showGrid: boolean): ChartTokens {
  if (style === '现代')
    return { name: style, classic: false, bg: '#fbfcfe', grid: showGrid ? '#eef1f5' : 'transparent', frame: 'transparent', axis: '#9aa3b0', text: '#5b6572', center: '#0f9d6b', limit: '#f0883e', limitDash: '6 4', point: '#2563eb', line: '#9cc0ee', spec: '#8b5cf6', bar: '#3b82f6', bar2: '#93c5fd', bar3: '#c7dbfb', curve: '#0f9d6b', curve2: '#f0883e', sw: 2.4, r: 4.2, dash: '6 4' };
  if (style === '高对比')
    return { name: style, classic: false, bg: '#101823', grid: showGrid ? '#26313f' : 'transparent', frame: 'transparent', axis: '#5b6676', text: '#c7cfda', center: '#34d399', limit: '#f87171', limitDash: '5 4', point: '#60a5fa', line: '#3b6ea8', spec: '#c084fc', bar: '#60a5fa', bar2: '#34d399', bar3: '#fbbf24', curve: '#34d399', curve2: '#fbbf24', sw: 2.2, r: 3.8, dash: '5 4' };
  // 经典主题 = Minitab 化(人工反馈716 批次P):纯白绘图区+1px 灰边框、不画网格线(网格开关仅作用于现代/高对比)、
  // 系列深藏青蓝 #2A4B8D、中心线黑、UCL/LCL 红实线、轴刻度黑字。
  return { name: style, classic: true, bg: '#ffffff', grid: 'transparent', frame: '#c4c9d0', axis: '#262626', text: '#1a1a1a', center: '#000000', limit: '#d21f26', limitDash: undefined, point: '#2A4B8D', line: '#2A4B8D', spec: '#c026a6', bar: '#7FA0C4', bar2: '#5b9bd5', bar3: '#a9c9ec', curve: '#d21f26', curve2: '#c026a6', sw: 1.6, r: 3.4, dash: '5 4' };
}

/**
 * 主题 tokens 按值比较。App 每次渲染都会 chartTokens() 出新对象;大页面(总览/SPC)用
 * React.memo(…, 本函数) 挡住与主题无关的父级重渲染(toast/菜单开合),
 * 否则 20 万行下每条提示都会让整页重跑(GAP-10-22/23)。
 */
export function sameChartTokens(a: ChartTokens, b: ChartTokens): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof ChartTokens>;
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/** 帕累托柱色序;经典主题按 Minitab 统一钢蓝(排序信息由柱高与累积线表达) */
export function paretoColors(T: ChartTokens): string[] {
  if (T.classic) return [T.bar];
  return [T.bar, T.bar2, T.bar3, '#8fb4dd', '#b7cbe4', '#cdd8e6'];
}

/** 单轴刻度数硬上限:正常 1-2-5 阶梯约 target..2·target 个,远超此值必是退化输入。 */
const NICE_TICKS_MAX = 1000;

/** Minitab 式圆整刻度:1-2-5 阶梯,覆盖 [lo,hi],约 target 个
 *
 * UI-03/CORE-08:亚 ulp 跨度(如 3 个 0.1 的均值=0.1+1ulp)下 step 小于 v 的半个 ulp,
 * `v += step` 不前进,旧实现一直 push 到 RangeError(卡死数秒,整页进 ErrorBoundary)。
 * 入口识别退化跨度直接返回端点,循环另设硬上限兜底其他未知退化输入。 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  // 跨度只有数个 ulp:圆整刻度无意义(且会加不动),只给两端点
  if (hi - lo <= Number.EPSILON * Math.max(Math.abs(lo), Math.abs(hi)) * 8) return [lo, hi];
  const step0 = (hi - lo) / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step - 1e-9) * step;
  // 非有限量程:与旧实现一致不产出刻度(旧循环条件对 NaN 恒假)
  if (!Number.isFinite(step) || !Number.isFinite(start)) return [];
  if (start + step <= start) return [lo, hi];
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9 && out.length < NICE_TICKS_MAX; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/** 刻度标签的小数位:由步长决定(整数步长给 0 位)。
 * 钳到 toFixed 的真实上限 100:次正规/常量列会算出 324/Infinity 位,直接抛 RangeError
 * (整图渲染失败被 ErrorBoundary 吞)。**此钳位只为避免抛错**——极小步长下定点记数
 * 本就不可读,可读性由 tickLabel 的指数记数负责,不要靠调这个上限来解决显示问题。 */
export function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 0;
  // 自审 P1:必须取**绝对值**——「量程 5 等分」的刻度序列是降序(step<0),
  // 旧写法走 step<=0 分支返回 0,把 72.30/67.90/63.50 标成「72|68|64」,
  // 步差看起来 4/4/5/4,标签与网格线真值最多差半个步长。
  const step = Math.abs(ticks[1] - ticks[0]);
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.max(0, Math.min(100, -Math.floor(Math.log10(step) + 1e-9)));
}

/**
 * 刻度标签格式化器:**记数法按整条刻度序列一次性决定**,同一坐标轴不混用定点与指数。
 *
 * 自审 P2 的两处教训:
 * ① 逐个刻度判阈值 → 同轴首个刻度切指数、其余定点(常见工厂量程就会踩到);
 * ② 指数分支固定 3 位有效数字、丢弃 dp → 把 tickDecimals 钳位刚保住的刻度重新压塌
 *    (同一批两个修复互相抵消,两边测试还各自绿)。
 * 现在:整轴统一记数法,且指数分支的尾数位数由「相邻刻度的相对间距」推出,保证标签两两可分。
 */
/** 舍入产生的负零一律归零:小负数(如 −0.4)在粗步长下会被 toFixed 印成「-0」/「-0.000」。
 * 注意 Object.is(v,-0) 挡不住这种情形——那只覆盖真正的负零字面量(自审:曾误删本函数)。 */
function zeroSafe(text: string): string {
  return /^-0(\.0*)?(e-?\d+)?$/.test(text) ? text.slice(1) : text;
}

export function tickFormatter(ticks: number[], minDp?: number): (v: number) => string {
  const finite = ticks.filter((t) => Number.isFinite(t));
  // minDp = 调用方指定的小数位偏好(如 ControlChart 的 cfg.dec);定点模式下取二者较大值,
  // 既尊重用户口径,又不让 ppm 量级被四舍五入成重复标签。
  const dp = Math.max(tickDecimals(ticks), minDp ?? 0);
  const maxMag = finite.reduce((m, t) => Math.max(m, Math.abs(t)), 0);
  const useExp = maxMag > 0 && (maxMag < 1e-4 || maxMag >= 1e15);
  if (!useExp) {
    // 定点模式:先按步长定位数,若仍产生重复标签(ppm 量级 + 粗步长)再逐位升,最多到 12 位。
    // 闭环 P1:此前靠调用方传 minDp 兜底,结果 cfg.dec 反过来污染了常规量程的轴位数。
    // 自审 P3:升位不得绕开 tickDecimals 的 100 位钳制(toFixed 上限),否则会抛 RangeError
    let fixedDp = Math.min(dp, 100);
    // 保真度(自审 P1):标签解析回来必须落在真值的 |step|×2% 内,否则等距刻度会被
    // 舍成不等距(「72|68|64|59|55」)。圆整刻度的误差本就是 0,不会因此虚增位数。
    const step = finite.length > 1 ? Math.abs(finite[1] - finite[0]) : 0;
    const tol = step > 0 ? step * 0.02 : 0;
    const maxErr = (d: number) => finite.reduce(
      (worst, t) => Math.max(worst, Math.abs(Number(nf(t, d)) - t)), 0,
    );
    for (let tries = 0; tries < 12 && finite.length > 1 && fixedDp < 100; tries++) {
      const labels = finite.map((t) => zeroSafe(nf(t, fixedDp)));
      const distinct = new Set(labels).size === labels.length;
      const faithful = tol === 0 || maxErr(fixedDp) <= tol;
      if (distinct && faithful) break;
      fixedDp = Math.min(100, fixedDp + 1);
    }
    return (v) => zeroSafe(nf(v, fixedDp));
  }
  // 指数尾数位数:相邻刻度的相对差 r 决定需要多少位才能区分,-log10(r) 向上取整再留 1 位余量。
  // 自审 P2:同样要尊重 minDp(调用方口径),否则「限值由 cfg.dec 单独兜底」这句注释不成立。
  const step = finite.length > 1 ? Math.abs(finite[1] - finite[0]) : 0;
  const rel = step > 0 && maxMag > 0 ? step / maxMag : 0;
  const need = rel > 0 ? Math.ceil(-Math.log10(rel)) + 1 : 2;
  const minExpDigits = minDp != null && minDp > 0 && maxMag > 0
    ? Math.ceil(minDp + Math.log10(maxMag)) : 0;
  // 自审 P3:double 只有约 17 位有效数字,再多是纯浮点噪声;toExponential 的合法上限是 100
  const digits = Math.max(2, Math.min(17, Math.max(need, minExpDigits)));
  return (v) => {
    if (v === 0) return '0';
    return zeroSafe(v.toExponential(digits).replace('e+', 'e').replace(/\.?0+e/, 'e'));
  };
}

/** 单值版本(保留给只有一个数要标的调用点);整条轴请用 tickFormatter。 */
export function tickLabel(v: number, dp: number): string {
  return tickFormatter([v, v + (dp > 0 ? 10 ** -dp : 1)])(v);
}

/** 语义状态色(第三轮 P3:通过/预警/异常/中性 曾以字面量散布 47 处;新代码一律引用此表,
 * 存量按文件逐步迁移——本批已迁 Dashboard)。 */
export const STATUS_COLORS = { ok: '#2c8a45', warn: '#e0902a', bad: '#c22f2f', muted: '#8a929d' } as const;
