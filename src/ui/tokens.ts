/**
 * 图表主题 tokens — 三套主题（经典/现代/高对比），从原型 tokens() 迁移（交接文档 §7）。
 */
import type { ChartStyle } from '../store/appStore';

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

/** 帕累托柱色序;经典主题按 Minitab 统一钢蓝(排序信息由柱高与累积线表达) */
export function paretoColors(T: ChartTokens): string[] {
  if (T.classic) return [T.bar];
  return [T.bar, T.bar2, T.bar3, '#8fb4dd', '#b7cbe4', '#cdd8e6'];
}

/** Minitab 式圆整刻度:1-2-5 阶梯,覆盖 [lo,hi],约 target 个 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** 刻度标签的小数位:由步长决定(整数步长给 0 位) */
export function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 0;
  const step = ticks[1] - ticks[0];
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}
