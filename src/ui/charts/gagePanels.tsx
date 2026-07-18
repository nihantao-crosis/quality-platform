/**
 * MSA 量具 R&R 图形报告（v1.40.1:对齐工厂 Minitab 17 图窗观感）。
 *
 * GageReportFigure 输出与 Minitab 一致的**单张整图**:
 * 主标题「量具 R&R(ANOVA): 〈测量项〉」+ 每面板灰色标题条;
 * 单操作员 4 联(左列 变异分量/R 图,右列 按部件/Xbar 图——与工厂 EMF 逐面板核对),
 * 多操作员 6 联(左列 变异分量/R/Xbar,右列 按部件/按操作员箱线/交互)。
 * 样式对齐要点(自工厂 EMF 渲染核对):整图浅灰底;按部件用灰色原始点簇+蓝⊕均值连线;
 * 箱线为浅蓝填充箱+⊕均值+均值连线+星号离群点;交互图三操作员实心 蓝●/深红■/绿◆+带框图例;
 * 变异分量为 浅蓝/红/黄 分组柱+面板内带框图例;控制图蓝点线/绿中心线/深红控制限。
 * 页面、专项报告导出与对比报告生成器共用本组件(react-dom/server 同一渲染路径)。
 */
import { Fragment } from 'react';
import type { ReactNode } from 'react';
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

/** 面板内容坐标系固定 560×300;组合图用 <g transform> 平移复用。 */
const PW = 560;
const PH = 300;
const M = { t: 14, r: 64, b: 34, l: 50 };

/** Minitab 17 图窗配色(自工厂 EMF 逐记录提取):整图浅灰底,数据蓝,中心线绿,控制限深红,
 * 变异分量三色柱 浅蓝/红/黄,箱体浅蓝填充,交互标记 蓝●/深红■/绿◆。 */
const MTB = {
  figureBg: '#e5e5e5',
  panelBg: '#ffffff',
  data: '#0054a6',
  center: '#00841f',
  limit: '#931313',
  raw: '#999999',
  barContrib: '#7da7d9',
  barStudy: '#c74542',
  barTol: '#ffec48',
  box: '#7da7d9',
  series: ['#0054a6', '#931313', '#00841f'],
};

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

/** 公共框架:白底、边框、水平网格与 Y 刻度。 */
function panelFrame(T: ChartTokens, yLo: number, yHi: number) {
  const pw = PW - M.l - M.r;
  const ph = PH - M.t - M.b;
  const Y = (value: number) => M.t + ((yHi - value) / (yHi - yLo)) * ph;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = yLo + ((yHi - yLo) * index) / 4;
    return { y: Y(value), label: fmtTick(value, yHi - yLo) };
  });
  const frame = (
    <Fragment>
      <rect x={0} y={0} width={PW} height={PH} fill={MTB.panelBg} />
      <rect x={M.l} y={M.t} width={pw} height={ph} fill="none" stroke={T.axis} strokeWidth={1} />
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

/** Minitab 式 ⊕ 均值标记:空心圆+十字。 */
function MeanMarker({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <Fragment>
      <circle cx={x} cy={y} r={4.2} fill="#fff" stroke={color} strokeWidth={1.3} />
      <Ln x1={x - 4.2} y1={y} x2={x + 4.2} y2={y} stroke={color} sw={1.1} />
      <Ln x1={x} y1={y - 4.2} x2={x} y2={y + 4.2} stroke={color} sw={1.1} />
    </Fragment>
  );
}

// ---------- 变异分量(分组柱 + 面板内带框图例,Minitab 布局) ----------

export interface GageBarCategory {
  name: string;
  contrib: number;
  study: number;
  tol: number | null;
}

function componentsBody(T: ChartTokens, cats: GageBarCategory[]): ReactNode {
  const hasTol = cats.some((cat) => cat.tol != null);
  const seriesDefs: Array<{ key: 'contrib' | 'study' | 'tol'; label: string; color: string }> = [
    { key: 'contrib', label: '%贡献', color: MTB.barContrib },
    { key: 'study', label: '%研究变异', color: MTB.barStudy },
    ...(hasTol ? [{ key: 'tol' as const, label: '%公差', color: MTB.barTol }] : []),
  ];
  let maxValue = 100;
  for (const cat of cats) {
    for (const def of seriesDefs) {
      const value = cat[def.key];
      if (value != null && value > maxValue) maxValue = value;
    }
  }
  const [yLo, yHi] = [0, maxValue * 1.08];
  const { pw, ph, Y, frame } = panelFrame(T, yLo, yHi);
  const groupWidth = pw / cats.length;
  const barWidth = Math.min(16, (groupWidth * 0.6) / seriesDefs.length);
  const legendW = 108;
  return (
    <Fragment>
      {frame}
      {cats.map((cat, catIndex) => (
        <Fragment key={cat.name}>
          {seriesDefs.map((def, seriesIndex) => {
            const value = cat[def.key];
            if (value == null) return null;
            const x = M.l + groupWidth * catIndex + groupWidth / 2 + (seriesIndex - (seriesDefs.length - 1) / 2) * (barWidth + 2) - barWidth / 2;
            return <rect key={def.key} x={x} y={Y(value)} width={barWidth} height={Math.max(0, M.t + ph - Y(value))} fill={def.color} stroke={T.axis} strokeWidth={0.6} />;
          })}
          <Txt x={M.l + groupWidth * catIndex + groupWidth / 2} y={PH - M.b + 12} s={cat.name} fill={T.text} size={9} anchor="middle" />
        </Fragment>
      ))}
      {/* Minitab:面板内右上角带框图例 */}
      <rect x={PW - M.r - legendW} y={M.t + 6} width={legendW} height={seriesDefs.length * 16 + 10} fill="#fff" stroke={T.axis} strokeWidth={0.8} />
      {seriesDefs.map((def, index) => (
        <Fragment key={def.key}>
          <rect x={PW - M.r - legendW + 8} y={M.t + 13 + index * 16} width={11} height={9} fill={def.color} stroke={T.axis} strokeWidth={0.6} />
          <Txt x={PW - M.r - legendW + 24} y={M.t + 18 + index * 16} s={def.label} fill={T.text} size={9} />
        </Fragment>
      ))}
    </Fragment>
  );
}

// ---------- 按操作员分组的控制图(R/Xbar 共用) ----------

function groupedControlBody(
  T: ChartTokens,
  panel: GagePanelData,
  operatorLabels: string[],
  series: number[][],
  limits: { cl: number; ucl: number; lcl: number } | null,
  limitLabel: string,
): ReactNode {
  const o = panel.operatorCount;
  const p = panel.partCount;
  const flat = series.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const dataLo = Math.min(flatLo, limits ? limits.lcl : Infinity);
  const dataHi = Math.max(flatHi, limits ? limits.ucl : -Infinity);
  const [yLo, yHi] = niceRange(dataLo, dataHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi);
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
    <Fragment>
      {frame}
      {limits && limitLine(limits.ucl, `UCL=${fmtTick(limits.ucl, yHi - yLo)}`, MTB.limit, true)}
      {limits && limitLine(limits.cl, `${limitLabel}=${fmtTick(limits.cl, yHi - yLo)}`, MTB.center, true)}
      {limits && limits.lcl !== limits.ucl && limitLine(limits.lcl, `LCL=${fmtTick(limits.lcl, yHi - yLo)}`, MTB.limit, true)}
      <polyline points={points.join(' ')} fill="none" stroke={MTB.data} strokeWidth={1.1} />
      {flat.map((value, index) => (
        <circle key={index} cx={X(index)} cy={Y(value)} r={2.6} fill={MTB.data} />
      ))}
      {Array.from({ length: o }, (_, operator) => (
        <Fragment key={operator}>
          {operator > 0 && (
            <Ln x1={M.l + (operator * p / total) * pw} y1={M.t} x2={M.l + (operator * p / total) * pw} y2={PH - M.b} stroke={MTB.data} sw={1} />
          )}
          {o > 1 && (
            <Txt x={M.l + ((operator + 0.5) * p / total) * pw} y={M.t + 11} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9.5} anchor="middle" weight={600} />
          )}
        </Fragment>
      ))}
      {total <= 40 && flat.map((_, index) => (
        <Txt key={index} x={X(index)} y={PH - M.b + 12} s={String((index % p) + 1)} fill={T.axis} size={7.5} anchor="middle" />
      ))}
    </Fragment>
  );
}

// ---------- 按部件:原始点簇 + ⊕ 均值连线(Minitab 样式) ----------

function byPartBody(T: ChartTokens, panel: GagePanelData, partLabels: string[]): ReactNode {
  const p = panel.partCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi);
  const X = (part: number) => M.l + ((part + 0.5) / p) * pw;
  const meanPoints = panel.partMeans.map((mean, part) => `${X(part)},${Y(mean)}`);
  return (
    <Fragment>
      {frame}
      {panel.values.map((byPart, operator) => byPart.map((trials, part) => trials.map((value, trial) => (
        <circle key={`${operator}-${part}-${trial}`} cx={X(part)} cy={Y(value)} r={1.9} fill={MTB.raw} />
      ))))}
      <polyline points={meanPoints.join(' ')} fill="none" stroke={MTB.data} strokeWidth={1.3} />
      {panel.partMeans.map((mean, part) => (
        <MeanMarker key={part} x={X(part)} y={Y(mean)} color={MTB.data} />
      ))}
      {Array.from({ length: p }, (_, part) => (
        <Txt key={part} x={X(part)} y={PH - M.b + 12} s={partLabels[part] ?? String(part + 1)} fill={T.axis} size={9} anchor="middle" />
      ))}
    </Fragment>
  );
}

// ---------- 箱线:空心箱 + ⊕ 均值 + 均值连线(Minitab 1.5×IQR 规则) ----------

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

function byOperatorBody(T: ChartTokens, panel: GagePanelData, operatorLabels: string[]): ReactNode {
  const o = panel.operatorCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi);
  const X = (operator: number) => M.l + ((operator + 0.5) / o) * pw;
  const boxWidth = Math.min(64, (pw / o) * 0.42);
  const meanPoints = panel.operatorMeans.map((mean, operator) => `${X(operator)},${Y(mean)}`);
  return (
    <Fragment>
      {frame}
      {o > 1 && <polyline points={meanPoints.join(' ')} fill="none" stroke={T.line} strokeWidth={1.1} />}
      {panel.values.map((byPart, operator) => {
        const stats = boxplotStats(byPart.flat());
        const x = X(operator);
        return (
          <Fragment key={operator}>
            <Ln x1={x} y1={Y(stats.whiskerLo)} x2={x} y2={Y(stats.q1)} stroke={T.text} sw={1} />
            <Ln x1={x} y1={Y(stats.q3)} x2={x} y2={Y(stats.whiskerHi)} stroke={T.text} sw={1} />
            {/* Minitab:浅蓝填充箱体(自工厂 EMF 色) */}
            <rect x={x - boxWidth / 2} y={Y(stats.q3)} width={boxWidth} height={Math.max(1, Y(stats.q1) - Y(stats.q3))} fill={MTB.box} stroke={T.text} strokeWidth={1.1} />
            <Ln x1={x - boxWidth / 2} y1={Y(stats.median)} x2={x + boxWidth / 2} y2={Y(stats.median)} stroke={T.text} sw={1.3} />
            <MeanMarker x={x} y={Y(byPart.flat().reduce((a, b) => a + b, 0) / byPart.flat().length)} color={MTB.data} />
            {stats.outliers.map((value, index) => (
              <Txt key={index} x={x} y={Y(value)} s="*" fill={T.text} size={14} anchor="middle" weight={700} />
            ))}
          </Fragment>
        );
      })}
      {Array.from({ length: o }, (_, operator) => (
        <Txt key={operator} x={X(operator)} y={PH - M.b + 12} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9.5} anchor="middle" weight={600} />
      ))}
    </Fragment>
  );
}

// ---------- 交互:●/□/◇ 标记 + 带框图例(Minitab 样式) ----------

function interactionMarker(shape: number, x: number, y: number, color: string): ReactNode {
  // Minitab:实心标记 ●/■/◆(自工厂 EMF:蓝圆/深红方/绿菱)
  if (shape === 0) return <circle cx={x} cy={y} r={3.2} fill={color} />;
  if (shape === 1) return <rect x={x - 3.2} y={y - 3.2} width={6.4} height={6.4} fill={color} />;
  return <polygon points={`${x},${y - 4.4} ${x + 4.4},${y} ${x},${y + 4.4} ${x - 4.4},${y}`} fill={color} />;
}

function interactionBody(T: ChartTokens, panel: GagePanelData, partLabels: string[], operatorLabels: string[]): ReactNode {
  const p = panel.partCount;
  const flat = panel.cellMeans.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const [yLo, yHi] = niceRange(flatLo, flatHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi);
  const X = (part: number) => M.l + ((part + 0.5) / p) * pw;
  const colors = MTB.series;
  const legendW = 96;
  return (
    <Fragment>
      {frame}
      {panel.cellMeans.map((byPart, operator) => (
        <Fragment key={operator}>
          <polyline
            points={byPart.map((mean, part) => `${X(part)},${Y(mean)}`).join(' ')}
            fill="none" stroke={colors[operator % colors.length]} strokeWidth={1.3}
          />
          {byPart.map((mean, part) => (
            <Fragment key={part}>{interactionMarker(operator % 3, X(part), Y(mean), colors[operator % colors.length])}</Fragment>
          ))}
        </Fragment>
      ))}
      {Array.from({ length: p }, (_, part) => (
        <Txt key={part} x={X(part)} y={PH - M.b + 12} s={partLabels[part] ?? String(part + 1)} fill={T.axis} size={9} anchor="middle" />
      ))}
      {/* Minitab:带框图例(标记形状+操作员名) */}
      <rect x={PW - M.r - legendW} y={M.t + 6} width={legendW} height={panel.operatorCount * 16 + 10} fill="#fff" stroke={T.axis} strokeWidth={0.8} />
      {panel.cellMeans.map((_, operator) => (
        <Fragment key={operator}>
          {interactionMarker(operator % 3, PW - M.r - legendW + 13, M.t + 17 + operator * 16, colors[operator % colors.length])}
          <Txt x={PW - M.r - legendW + 24} y={M.t + 18 + operator * 16} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9} />
        </Fragment>
      ))}
    </Fragment>
  );
}

// ---------- Minitab 式整图(主标题 + 灰色面板标题条 + 2×2/2×3 组合) ----------

export interface GageReportFigureProps {
  T: ChartTokens;
  panel: GagePanelData;
  partLabels: string[];
  operatorLabels: string[];
  cats: GageBarCategory[];
  /** 测量项列名(主标题「量具 R&R(ANOVA): 〈测量项〉」) */
  valueName: string;
  partName?: string;
  operatorName?: string;
}

const TITLE_H = 20;
const MASTER_H = 34;
const CELL_GAP = 12;
const FIG_M = 12;

/** 与工厂 Minitab 17 图窗同布局的单张整图。 */
export function GageReportFigure({
  T, panel, partLabels, operatorLabels, cats, valueName,
  partName = '部件', operatorName = '操作员',
}: GageReportFigureProps) {
  const single = panel.operatorCount === 1;
  const cells: Array<{ title: string; body: ReactNode }> = single
    ? [
      { title: '变异分量', body: componentsBody(T, cats) },
      { title: 'R 控制图', body: groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄') },
      { title: `按 ${partName} 的测量值`, body: byPartBody(T, panel, partLabels) },
      { title: 'Xbar 控制图', body: groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿') },
    ]
    : [
      { title: '变异分量', body: componentsBody(T, cats) },
      { title: `按 ${partName} 的测量值`, body: byPartBody(T, panel, partLabels) },
      { title: `R 控制图（按 ${operatorName}）`, body: groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄') },
      { title: `按 ${operatorName} 的测量值`, body: byOperatorBody(T, panel, operatorLabels) },
      { title: `Xbar 控制图（按 ${operatorName}）`, body: groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿') },
      { title: `${partName} * ${operatorName} 交互作用`, body: interactionBody(T, panel, partLabels, operatorLabels) },
    ];
  const rows = single ? 2 : 3;
  const width = FIG_M * 2 + PW * 2 + CELL_GAP;
  const height = MASTER_H + rows * (TITLE_H + PH + CELL_GAP) + FIG_M;
  return (
    <Svg w={width} h={height}>
      <rect x={0} y={0} width={width} height={height} fill={MTB.figureBg} />
      <rect x={0} y={0} width={width} height={height} fill="none" stroke={T.axis} strokeWidth={1} />
      {/* Minitab 主标题条 */}
      <rect x={1} y={1} width={width - 2} height={MASTER_H - 6} fill="#d9dde3" />
      <Txt x={width / 2} y={MASTER_H / 2 - 2} s={`量具 R&R(ANOVA): ${valueName}`} fill="#1c2733" size={14} anchor="middle" weight={700} />
      {cells.map((cell, index) => {
        const col = index % 2;
        const row = Math.floor(index / 2);
        const x = FIG_M + col * (PW + CELL_GAP);
        const y = MASTER_H + row * (TITLE_H + PH + CELL_GAP);
        return (
          <g key={index} transform={`translate(${x},${y})`}>
            {/* 灰色面板标题条(Minitab) */}
            <rect x={0} y={0} width={PW} height={TITLE_H} fill="#cfd6dd" stroke={T.axis} strokeWidth={0.7} />
            <Txt x={PW / 2} y={TITLE_H / 2 + 0.5} s={cell.title} fill="#1c2733" size={11} anchor="middle" weight={700} />
            <g transform={`translate(0,${TITLE_H})`}>{cell.body}</g>
          </g>
        );
      })}
    </Svg>
  );
}

// ---------- 兼容导出:独立面板组件(测试与旧调用方使用) ----------

export function GageRPanel({ T, panel, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH}>{groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄')}</Svg>;
}

export function GageXbarPanel({ T, panel, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH}>{groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿')}</Svg>;
}

export function GageByPartPanel({ T, panel, partLabels }: PanelProps) {
  return <Svg w={PW} h={PH}>{byPartBody(T, panel, partLabels)}</Svg>;
}

export function GageByOperatorPanel({ T, panel, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH}>{byOperatorBody(T, panel, operatorLabels)}</Svg>;
}

export function GageInteractionPanel({ T, panel, partLabels, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH}>{interactionBody(T, panel, partLabels, operatorLabels)}</Svg>;
}
