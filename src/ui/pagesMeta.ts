import type { Page } from '../store/appStore';
import type { IconName } from './icons';

export interface PageMeta {
  key: Page;
  label: string;
  group: '仪表盘' | '数据' | '分析模块';
  icon: IconName;
  title: string;
  sub: string;
}

export const PAGES: PageMeta[] = [
  { key: 'dashboard', label: '质量总览', group: '仪表盘', icon: 'grid', title: '质量总览', sub: '关键指标 · 趋势 · 告警' },
  { key: 'worksheet', label: '数据工作表', group: '数据', icon: 'table', title: '数据工作表 · 质检数据.mtw', sub: '25 子组 × 5 测量值 · 直径 (mm)' },
  { key: 'spc', label: '控制图 (SPC)', group: '分析模块', icon: 'chart', title: 'SPC 控制图 · X̄-R', sub: '均值-极差控制图 · 子组大小 n = 5' },
  { key: 'capability', label: '过程能力分析', group: '分析模块', icon: 'bell', title: '过程能力分析 · Cpk / Ppk', sub: '正态能力 · 规格 24.90–25.10 mm' },
  { key: 'gagerr', label: '测量系统分析', group: '分析模块', icon: 'gauge', title: '测量系统分析 · Gage R&R', sub: '交叉设计 · ANOVA 法 · 3 操作员 × 10 部件 × 2 次' },
  { key: 'anova', label: '假设检验 / ANOVA', group: '分析模块', icon: 'box', title: '单因子方差分析', sub: '比较三台设备的直径均值差异' },
  { key: 'pareto', label: '帕累托图', group: '分析模块', icon: 'bars', title: '帕累托图 · 缺陷分析', sub: '按缺陷类别的数量与累计占比' },
  { key: 'doe', label: '实验设计 (DOE)', group: '分析模块', icon: 'flask', title: '实验设计 · 2³ 全因子', sub: '温度 / 压力 / 时间 对抗拉强度的影响' },
  { key: 'aql', label: '抽样检验 (AQL)', group: '分析模块', icon: 'check', title: '抽样检验 · AQL 方案', sub: 'GB/T 2828.1 · 一般检验水平 II · AQL 1.0' },
];
