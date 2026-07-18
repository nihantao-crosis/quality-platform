/**
 * MSA 量具 R&R 图形报告面板（v1.40 工厂验收批次）。
 * 布局与 Minitab 图窗同构：单操作员 4 联（变异分量 / R 图 / 按部件 / Xbar 图），
 * 多操作员 6 联（另加 按操作员箱线 / 部件×操作员交互，R/Xbar 按操作员分组带分隔线）。
 * 变异分量柱图沿用 GroupedBars；本文件提供其余五幅。页面与专项报告共用，
 * 数据一律来自 computeGagePanelData（与引擎同一套平衡校验）。
 */
import { Fragment } from 'react';
import type { GagePanelData } from '../../core';
import type { ChartTokens } from '../tokens';
import { Ln, Svg, Txt } from './primitives';

interface PanelProps {
  T: ChartTokens;
  panel: GagePanelData;
  partLabels: string[];
  operatorLabels: string[];
  w?: number;
  h?: number;
}

const M = { t: 26, r: 64, b: 34, l: 50 };

function niceRange(lo: number, hi: number): [number, number] {
  if (!(hi > lo)) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

/** 循环求 [min,max]:不用 Math.min(...展开)——十万行级观测在 Web V8 会栈溢出(parseMatrix 同教训)。 */
function rangeOf(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return [lo, hi];
}

const fmtTick = (value: number, span: number) =>
  span >= 100 ? value.toFixed(0) : span >= 1 ? value.toFixed(2) : value.toFixed(3);

/** 公共框架:背景、边框、水平网格与 Y 刻度;返回坐标换算。 */
function panelFrame(T: ChartTokens, w: number, h: number, yLo: number, yHi: number) {
  const pw = w - M.l - M.r;
  const ph = h - M.t - M.b;
  const Y = (value: number) => M.t + ((yHi - value) / (yHi - yLo)) * ph;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = yLo + ((yHi - yLo) * index) / 4;
    return { y: Y(value), label: fmtTick(value, yHi - yLo) };
  });
  const frame = (
    <Fragment>
      <rect x={0} y={0} width={w} height={h} fill={T.bg} />
      <rect x={M.l} y={M.t} width={pw} height={ph} fill="none" stroke={T.frame} strokeWidth={1} />
      {grid.map((tick, index) => (
        <Fragment key={index}>
          <Ln x1={M.l} y1={tick.y} x2={M.l + pw} y2={tick.y} stroke={T.grid} sw={1} />
          <Txt x={M.l - 6} y={tick.y} s={tick.label} fill={T.axis} size={9} anchor="end" />
        </Fragment>
      ))}
    </Fragment>
  );
  return { pw, ph, Y, frame };
}

/** 按操作员分组的点序控制图骨架(R 图与 Xbar 图共用):
 * X 轴 = 操作员块 × 部件序,组间虚线分隔 + 操作员标签;控制限横贯全图。 */
function GroupedControlPanel({
  T, panel, partLabels, operatorLabels, w = 560, h = 300,
  series, limits, title, limitLabel,
}: PanelProps & {
  series: number[][];
  limits: { cl: number; ucl: number; lcl: number } | null;
  title: string;
  limitLabel: string;
}) {
  const o = panel.operatorCount;
  const p = panel.partCount;
  const flat = series.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const dataLo = Math.min(flatLo, limits ? limits.lcl : Infinity);
  const dataHi = Math.max(flatHi, limits ? limits.ucl : -Infinity);
  const [yLo, yHi] = niceRange(dataLo, dataHi);
  const { pw, Y, frame } = panelFrame(T, w, h, yLo, yHi);
  const total = o * p;
  const X = (index: number) => M.l + ((index + 0.5) / total) * pw;
  const points: string[] = [];
  flat.forEach((value, index) => points.push(`${X(index)},${Y(value)}`));
  const limitLine = (value: number, label: string, color: string, solid: boolean) => (
    <Fragment key={label}>
      <Ln x1={M.l} y1={Y(value)} x2={M.l + pw} y2={Y(value)} stroke={color} sw={1.2} dash={solid ? undefined : T.limitDash} />
      <Txt x={M.l + pw + 4} y={Y(value)} s={label} fill={color} size={9} weight={600} />
    </Fragment>
  );
  return (
    <Svg w={w} h={h}>
      {frame}
      {limits && limitLine(limits.ucl, `UCL=${fmtTick(limits.ucl, yHi - yLo)}`, T.limit, T.classic)}
      {limits && limitLine(limits.cl, `${limitLabel}=${fmtTick(limits.cl, yHi - yLo)}`, T.center, true)}
      {limits && limits.lcl !== limits.ucl && limitLine(limits.lcl, `LCL=${fmtTick(limits.lcl, yHi - yLo)}`, T.limit, T.classic)}
      <polyline points={points.join(' ')} fill="none" stroke={T.line} strokeWidth={1.2} />
      {flat.map((value, index) => (
        <circle key={index} cx={X(index)} cy={Y(value)} r={2.4} fill={T.point} />
      ))}
      {Array.from({ length: o }, (_, operator) => (
        <Fragment key={operator}>
          {operator > 0 && (
            <Ln x1={M.l + (operator * p / total) * pw} y1={M.t} x2={M.l + (operator * p / total) * pw} y2={h - M.b} stroke={T.axis} sw={1} dash="4 3" />
          )}
          <Txt x={M.l + ((operator + 0.5) * p / total) * pw} y={h - M.b + 12} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9.5} anchor="middle" weight={600} />
        </Fragment>
      ))}
      {total <= 40 && flat.map((_, index) => (
        <Txt key={index} x={X(index)} y={h - M.b + 22} s={partLabels[index % p] ?? String((index % p) + 1)} fill={T.axis} size={7.5} anchor="middle" />
      ))}
      <Txt x={M.l} y={M.t - 12} s={title} fill={T.text} size={11} weight={600} />
    </Svg>
  );
}

/** R 控制图(按操作员分组;单操作员为单块)。UCL=D4·R̄,LCL=D3·R̄。 */
export function GageRPanel(props: PanelProps) {
  return (
    <GroupedControlPanel
      {...props}
      series={props.panel.cellRanges}
      limits={props.panel.rLimits}
      title={props.panel.operatorCount > 1 ? 'R 控制图（按操作员）' : 'R 控制图'}
      limitLabel="R̄"
    />
  );
}

/** Xbar 控制图(按操作员分组)。控制限 X̄̄ ± A2·R̄。 */
export function GageXbarPanel(props: PanelProps) {
  return (
    <GroupedControlPanel
      {...props}
      series={props.panel.cellMeans}
      limits={props.panel.xbarLimits}
      title={props.panel.operatorCount > 1 ? 'Xbar 控制图（按操作员）' : 'Xbar 控制图'}
      limitLabel="X̿"
    />
  );
}

/** 按部件的测量值:全部观测散点 + 部件均值连线。 */
export function GageByPartPanel({ T, panel, partLabels, w = 560, h = 300 }: PanelProps) {
  const p = panel.partCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame } = panelFrame(T, w, h, yLo, yHi);
  const X = (part: number) => M.l + ((part + 0.5) / p) * pw;
  const meanPoints = panel.partMeans.map((mean, part) => `${X(part)},${Y(mean)}`);
  return (
    <Svg w={w} h={h}>
      {frame}
      {panel.values.map((byPart, operator) => byPart.map((trials, part) => trials.map((value, trial) => (
        <circle key={`${operator}-${part}-${trial}`} cx={X(part)} cy={Y(value)} r={2.2} fill={T.axis} opacity={0.55} />
      ))))}
      <polyline points={meanPoints.join(' ')} fill="none" stroke={T.point} strokeWidth={1.6} />
      {panel.partMeans.map((mean, part) => (
        <circle key={part} cx={X(part)} cy={Y(mean)} r={3} fill={T.point} />
      ))}
      {Array.from({ length: p }, (_, part) => (
        <Txt key={part} x={X(part)} y={h - M.b + 12} s={partLabels[part] ?? String(part + 1)} fill={T.axis} size={9} anchor="middle" />
      ))}
      <Txt x={M.l} y={M.t - 12} s="按部件的测量值" fill={T.text} size={11} weight={600} />
      <Txt x={M.l + pw / 2} y={h - 8} s="部件" fill={T.axis} size={9.5} anchor="middle" />
    </Svg>
  );
}

function quantileOf(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface BoxplotStats {
  q1: number;
  median: number;
  q3: number;
  /** 箱须端点:1.5×IQR 栅栏内的最远相邻值(Minitab 默认规则),不是最小/最大值 */
  whiskerLo: number;
  whiskerHi: number;
  /** 栅栏外的离群点(Minitab 以星号单独绘制) */
  outliers: number[];
}

/** Minitab 默认箱线规则:箱须只延伸到 Q1−1.5·IQR / Q3+1.5·IQR 栅栏内的相邻值,
 * 栅栏外的点单独画星号——工厂案例5 的原始图即有多个星号离群点,不能被箱须吸收。 */
export function boxplotStats(values: number[]): BoxplotStats {
  const sorted = values.slice().sort((a, b) => a - b);
  const q1 = quantileOf(sorted, 0.25);
  const median = quantileOf(sorted, 0.5);
  const q3 = quantileOf(sorted, 0.75);
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  let whiskerLo = q1;
  let whiskerHi = q3;
  const outliers: number[] = [];
  for (const value of sorted) {
    if (value < loFence || value > hiFence) outliers.push(value);
    else {
      if (value < whiskerLo) whiskerLo = value;
      if (value > whiskerHi) whiskerHi = value;
    }
  }
  return { q1, median, q3, whiskerLo, whiskerHi, outliers };
}

/** 按操作员的测量值:Minitab 规则箱线(1.5×IQR 箱须+星号离群点) + 操作员均值连线。 */
export function GageByOperatorPanel({ T, panel, operatorLabels, w = 560, h = 300 }: PanelProps) {
  const o = panel.operatorCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame } = panelFrame(T, w, h, yLo, yHi);
  const X = (operator: number) => M.l + ((operator + 0.5) / o) * pw;
  const boxWidth = Math.min(60, (pw / o) * 0.4);
  const meanPoints = panel.operatorMeans.map((mean, operator) => `${X(operator)},${Y(mean)}`);
  return (
    <Svg w={w} h={h}>
      {frame}
      {panel.values.map((byPart, operator) => {
        const stats = boxplotStats(byPart.flat());
        const x = X(operator);
        return (
          <Fragment key={operator}>
            <Ln x1={x} y1={Y(stats.whiskerLo)} x2={x} y2={Y(stats.q1)} stroke={T.axis} sw={1} />
            <Ln x1={x} y1={Y(stats.q3)} x2={x} y2={Y(stats.whiskerHi)} stroke={T.axis} sw={1} />
            <rect x={x - boxWidth / 2} y={Y(stats.q3)} width={boxWidth} height={Math.max(1, Y(stats.q1) - Y(stats.q3))} fill={T.bar} opacity={0.5} stroke={T.axis} strokeWidth={1} />
            <Ln x1={x - boxWidth / 2} y1={Y(stats.median)} x2={x + boxWidth / 2} y2={Y(stats.median)} stroke={T.text} sw={1.4} />
            {stats.outliers.map((value, index) => (
              <Txt key={index} x={x} y={Y(value)} s="*" fill={T.text} size={13} anchor="middle" weight={700} />
            ))}
          </Fragment>
        );
      })}
      {o > 1 && <polyline points={meanPoints.join(' ')} fill="none" stroke={T.point} strokeWidth={1.4} />}
      {panel.operatorMeans.map((mean, operator) => (
        <circle key={operator} cx={X(operator)} cy={Y(mean)} r={3} fill={T.point} />
      ))}
      {Array.from({ length: o }, (_, operator) => (
        <Txt key={operator} x={X(operator)} y={h - M.b + 12} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9.5} anchor="middle" weight={600} />
      ))}
      <Txt x={M.l} y={M.t - 12} s="按操作员的测量值" fill={T.text} size={11} weight={600} />
    </Svg>
  );
}

/** 部件×操作员交互:各操作员的部件胞均值折线。 */
export function GageInteractionPanel({ T, panel, partLabels, operatorLabels, w = 560, h = 300 }: PanelProps) {
  const p = panel.partCount;
  const flat = panel.cellMeans.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const [yLo, yHi] = niceRange(flatLo, flatHi);
  const { pw, Y, frame } = panelFrame(T, w, h, yLo, yHi);
  const X = (part: number) => M.l + ((part + 0.5) / p) * pw;
  const colors = [T.point, T.bar2, T.bar3, T.curve, T.limit];
  return (
    <Svg w={w} h={h}>
      {frame}
      {panel.cellMeans.map((byPart, operator) => (
        <Fragment key={operator}>
          <polyline
            points={byPart.map((mean, part) => `${X(part)},${Y(mean)}`).join(' ')}
            fill="none" stroke={colors[operator % colors.length]} strokeWidth={1.5}
          />
          {byPart.map((mean, part) => (
            <circle key={part} cx={X(part)} cy={Y(mean)} r={2.6} fill={colors[operator % colors.length]} />
          ))}
          <Txt
            x={M.l + pw + 4} y={M.t + 10 + operator * 13}
            s={operatorLabels[operator] ?? `操作员${operator + 1}`}
            fill={colors[operator % colors.length]} size={9} weight={600}
          />
        </Fragment>
      ))}
      {Array.from({ length: p }, (_, part) => (
        <Txt key={part} x={X(part)} y={h - M.b + 12} s={partLabels[part] ?? String(part + 1)} fill={T.axis} size={9} anchor="middle" />
      ))}
      <Txt x={M.l} y={M.t - 12} s="部件 × 操作员 交互作用" fill={T.text} size={11} weight={600} />
      <Txt x={M.l + pw / 2} y={h - 8} s="部件" fill={T.axis} size={9.5} anchor="middle" />
    </Svg>
  );
}
