/**
 * 图表主题 tokens — 三套主题（经典/现代/高对比），从原型 tokens() 迁移（交接文档 §7）。
 */
import type { ChartStyle } from '../store/appStore';

export interface ChartTokens {
  name: ChartStyle;
  bg: string;
  grid: string;
  axis: string;
  text: string;
  center: string;
  limit: string;
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
    return { name: style, bg: '#fbfcfe', grid: showGrid ? '#eef1f5' : 'transparent', axis: '#9aa3b0', text: '#5b6572', center: '#0f9d6b', limit: '#f0883e', point: '#2563eb', line: '#9cc0ee', spec: '#8b5cf6', bar: '#3b82f6', bar2: '#93c5fd', bar3: '#c7dbfb', curve: '#0f9d6b', curve2: '#f0883e', sw: 2.4, r: 4.2, dash: '6 4' };
  if (style === '高对比')
    return { name: style, bg: '#101823', grid: showGrid ? '#26313f' : 'transparent', axis: '#5b6676', text: '#c7cfda', center: '#34d399', limit: '#f87171', point: '#60a5fa', line: '#3b6ea8', spec: '#c084fc', bar: '#60a5fa', bar2: '#34d399', bar3: '#fbbf24', curve: '#34d399', curve2: '#fbbf24', sw: 2.2, r: 3.8, dash: '5 4' };
  return { name: style, bg: '#ffffff', grid: showGrid ? '#e6e9ee' : 'transparent', axis: '#98a1ac', text: '#5b6472', center: '#1a8a3a', limit: '#d21f26', point: '#1f5fb2', line: '#6f9dcf', spec: '#c026a6', bar: '#1f6fb2', bar2: '#5b9bd5', bar3: '#a9c9ec', curve: '#d21f26', curve2: '#c026a6', sw: 1.6, r: 3.4, dash: '5 4' };
}

/** 帕累托柱色序（经典主题下与原型 defects 颜色一致） */
export function paretoColors(T: ChartTokens): string[] {
  return [T.bar, T.bar2, T.bar3, '#8fb4dd', '#b7cbe4', '#cdd8e6'];
}
