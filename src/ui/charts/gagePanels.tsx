/**
 * MSA 量具 R&R 图形报告(v1.40.2:对齐工厂 Minitab 17「量具 R&R(方差分析)报告」形制,
 * 经 PPT 全保真渲染逐面板核对)。
 *
 * GageReportFigure 输出单张报告式整图:
 * 主标题「〈测量项〉 的量具 R&R(方差分析)报告」+ 表头信息块(量具名称/研究日期/报表人/公差/其他);
 * 面板标题无底色居中(变异分量 / R 控制图(按 测试人) / 〈测量项〉 × 部件 / Xbar 控制图(按 测试人) /
 * 〈测量项〉 × 测试人 / 部件 乘 测试人 交互作用),带 y 轴标题(百分比/样本极差/样本均值/平均);
 * 单操作员 4 联(变异分量/R 图/×部件/XBar),多操作员 6 联。
 * 变异分量固定 4 类别(量具 R&R/重复(Repeat)/再现性/部件间)——单操作员时再现性为零高柱占位,与 Minitab 一致。
 * 操作员/部件水平顺序由 gageData 按 Minitab 排序(数值/拼音),控制图分段与交互图例与工厂输出同序。
 * 样式:白底;按部件灰点簇+蓝⊕均值连线;箱线浅蓝填充+⊕+星号离群点;交互实心 蓝●/深红■/绿◆+带框图例;
 * 变异分量 浅蓝/红/黄 柱+带框图例;控制图蓝点线/绿中心线/深红控制限(色值自工厂 EMF 逐记录提取)。
 * 页面、专项报告导出与对比报告生成器共用本组件(react-dom/server 同一渲染路径)。
 */
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { GagePanelData, GageResult, GageComponentKey } from '../../core';
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
const M = { t: 14, r: 64, b: 40, l: 62 };

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

/** 公共框架:白底、边框、水平网格与 Y 刻度;可带 Minitab 式 y 轴标题(旋转)与 x 轴标题。 */
function panelFrame(T: ChartTokens, yLo: number, yHi: number, yTitle?: string, xTitle?: string) {
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
      {yTitle && (
        <text x={14} y={M.t + ph / 2} fill={T.text} fontSize={9.5}
          textAnchor="middle" fontFamily="IBM Plex Mono, monospace"
          transform={`rotate(-90 14 ${M.t + ph / 2})`}>{yTitle}</text>
      )}
      {xTitle && <Txt x={M.l + pw / 2} y={PH - 8} s={xTitle} fill={T.text} size={9.5} anchor="middle" />}
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

/** Minitab「报告」变体的变异分量固定 4 类别:量具 R&R/重复(Repeat)/再现性/部件间。
 * 单操作员研究再现性以零高柱占位(与工厂 PPT 一致),不省略类别。 */
export function gageBarCategories(result: GageResult): GageBarCategory[] {
  const find = (key: GageComponentKey) => result.components.find((component) => component.key === key);
  const grr = find('grr');
  const hasTol = grr?.pctTolerance != null;
  const rowOf = (name: string, component: ReturnType<typeof find>): GageBarCategory => ({
    name,
    contrib: component?.pctContribution ?? 0,
    study: component?.pctStudyVar ?? 0,
    tol: hasTol ? (component?.pctTolerance ?? 0) : null,
  });
  return [
    rowOf('量具 R&R', grr),
    rowOf('重复(Repeat)', find('repeatability')),
    rowOf('再现性', find('reproducibility')),
    rowOf('部件间', find('part')),
  ];
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
  const { pw, ph, Y, frame } = panelFrame(T, yLo, yHi, '百分比');
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
  yTitle?: string,
  xTitle?: string,
): ReactNode {
  const o = panel.operatorCount;
  const p = panel.partCount;
  const flat = series.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const dataLo = Math.min(flatLo, limits ? limits.lcl : Infinity);
  const dataHi = Math.max(flatHi, limits ? limits.ucl : -Infinity);
  const [yLo, yHi] = niceRange(dataLo, dataHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi, yTitle, xTitle);
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

function byPartBody(T: ChartTokens, panel: GagePanelData, partLabels: string[], partName = '部件'): ReactNode {
  const p = panel.partCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi, undefined, partName);
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
  if (!sorted.length) return Number.NaN;
  // Minitab 箱线图四分位数：位置=(n+1)p（1-based），相邻次序统计量间线性插值；
  // 超出首尾时钳到最小/最大值。不得使用常见的 (n-1)p 浏览器/NumPy 默认口径。
  const position = (sorted.length + 1) * q;
  if (position <= 1) return sorted[0];
  if (position >= sorted.length) return sorted[sorted.length - 1];
  const lowerPosition = Math.floor(position);
  const fraction = position - lowerPosition;
  const lower = sorted[lowerPosition - 1];
  const upper = sorted[lowerPosition];
  return lower + (upper - lower) * fraction;
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

function byOperatorBody(T: ChartTokens, panel: GagePanelData, operatorLabels: string[], operatorName = '测试人'): ReactNode {
  const o = panel.operatorCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi, undefined, operatorName);
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

function interactionBody(T: ChartTokens, panel: GagePanelData, partLabels: string[], operatorLabels: string[], partName = '部件'): ReactNode {
  const p = panel.partCount;
  const flat = panel.cellMeans.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const [yLo, yHi] = niceRange(flatLo, flatHi);
  const { pw, Y, frame } = panelFrame(T, yLo, yHi, '平均', partName);
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
  /** 测量项列名(主标题「〈测量项〉 的量具 R&R(方差分析)报告」) */
  valueName: string;
  partName?: string;
  operatorName?: string;
  /** 表头信息块(Minitab 报告字段);缺省留空 */
  gaugeName?: string;
  reportBy?: string;
  studyDate?: string;
  toleranceText?: string;
  otherText?: string;
}

const TITLE_H = 20;
const HEADER_H = 92;
const CELL_GAP = 8;
const FIG_M = 14;

/** SVG 表头空间固定；完整追溯值保留在报告信息表，图内只做可读缩略。 */
function compactHeaderText(value: string, maxCharacters = 36): string {
  const characters = Array.from(value.trim());
  return characters.length <= maxCharacters
    ? characters.join('')
    : `${characters.slice(0, maxCharacters - 1).join('')}…`;
}

/** 与工厂 Minitab 17「量具 R&R(方差分析)报告」同形制的单张整图。 */
export function GageReportFigure({
  T, panel, partLabels, operatorLabels, cats, valueName,
  partName = '部件', operatorName = '测试人',
  gaugeName = '', reportBy = '', studyDate = '', toleranceText = '', otherText = '',
}: GageReportFigureProps) {
  const single = panel.operatorCount === 1;
  const cells: Array<{ title: string; body: ReactNode }> = single
    ? [
      { title: '变异分量', body: componentsBody(T, cats) },
      { title: 'R 控制图', body: groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄', '样本极差', partName) },
      { title: `${valueName} × ${partName}`, body: byPartBody(T, panel, partLabels, partName) },
      { title: 'XBar 控制图', body: groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿', '样本均值', partName) },
    ]
    : [
      { title: '变异分量', body: componentsBody(T, cats) },
      { title: `${valueName} × ${partName}`, body: byPartBody(T, panel, partLabels, partName) },
      { title: `R 控制图（按 ${operatorName}）`, body: groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄', '样本极差', partName) },
      { title: `${valueName} × ${operatorName}`, body: byOperatorBody(T, panel, operatorLabels, operatorName) },
      { title: `Xbar 控制图（按 ${operatorName}）`, body: groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿', '样本均值', partName) },
      { title: `${partName} 乘 ${operatorName} 交互作用`, body: interactionBody(T, panel, partLabels, operatorLabels, partName) },
    ];
  const rows = single ? 2 : 3;
  const width = FIG_M * 2 + PW * 2 + CELL_GAP;
  const height = HEADER_H + rows * (TITLE_H + PH + CELL_GAP) + FIG_M;
  return (
    <Svg w={width} h={height}>
      {/* Minitab 报告:白底纸面 + 细边框 */}
      <rect x={0} y={0} width={width} height={height} fill="#ffffff" stroke={T.axis} strokeWidth={1} />
      <Txt x={FIG_M + 4} y={22} s={`${valueName} 的量具 R&R (方差分析) 报告`} fill="#111820" size={15} weight={700} />
      {/* 表头信息块(量具名称/研究日期 | 报表人/公差/其他) */}
      <Txt x={FIG_M + 4} y={50} s={`量具名称：${compactHeaderText(gaugeName)}`} fill="#333c46" size={10.5} />
      <Txt x={FIG_M + 4} y={68} s={`研究日期：${compactHeaderText(studyDate, 20)}`} fill="#333c46" size={10.5} />
      <Txt x={width / 2 + 10} y={50} s={`报表人：${compactHeaderText(reportBy)}`} fill="#333c46" size={10.5} />
      <Txt x={width / 2 + 10} y={68} s={`公差：${compactHeaderText(toleranceText, 30)}`} fill="#333c46" size={10.5} />
      <Txt x={width / 2 + 10} y={84} s={`其他：${compactHeaderText(otherText)}`} fill="#333c46" size={10.5} />
      <Ln x1={FIG_M} y1={HEADER_H - 4} x2={width - FIG_M} y2={HEADER_H - 4} stroke="#c8cdd4" sw={1} />
      {cells.map((cell, index) => {
        const col = index % 2;
        const row = Math.floor(index / 2);
        const x = FIG_M + col * (PW + CELL_GAP);
        const y = HEADER_H + row * (TITLE_H + PH + CELL_GAP);
        return (
          <g key={index} transform={`translate(${x},${y})`}>
            {/* Minitab 报告:面板标题无底色居中粗体 */}
            <Txt x={PW / 2} y={TITLE_H / 2 + 1} s={cell.title} fill="#111820" size={11.5} anchor="middle" weight={700} />
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
