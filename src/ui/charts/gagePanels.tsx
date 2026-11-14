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
import { dataDecimals, decimateUniform, minitabQuantile, nf } from '../../core';
import type { GagePanelData, GageResult, GageComponentKey } from '../../core';
import { niceTicks, tickFormatter, type ChartTokens } from '../tokens';
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
/** 限值标签(9px 等宽)每字符宽度估计 = 0.6×字号;与几何回归断言同一口径。 */
const LIMIT_LABEL_SIZE = 9;
const LIMIT_LABEL_CHAR_W = 0.6 * LIMIT_LABEL_SIZE;
/** 标签可见字符数:组合附加符(R̄/X̿ 的上横线)不占独立字宽。 */
export function gageLabelChars(text: string): number {
  return Array.from(text.replace(/[\u0300-\u036f]/g, '')).length;
}
/**
 * 控制图面板的右边距(fix2609k UI-07 残余):限值标签画在绘图区右侧 x = PW − r + 4,
 * 固定 r=64 只容得下约 11 个字符——0.0003267、1234582.26 这类标签会越过面板右缘,被 6 联图
 * 右列面板的白底遮住(页面与 Word/PPT/HTML 导出同一张 SVG)。按最长标签加宽右边距并压缩绘图区,
 * 保证标签整体落在本面板 PW 之内(独立面板 SVG 也不被裁切)。
 */
export function gageLimitRightMargin(labels: readonly string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, gageLabelChars(label)), 0);
  return Math.max(M.r, Math.ceil(4 + longest * LIMIT_LABEL_CHAR_W + 2));
}

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
};

export type GageInteractionMarker = 'circle' | 'square' | 'diamond' | 'triangle'
  | 'triangle-down' | 'cross' | 'plus' | 'hexagon';
export interface GageInteractionSeriesStyle {
  color: string;
  marker: GageInteractionMarker;
  /** undefined 表示实线；其余为 SVG stroke-dasharray。 */
  dash?: string;
}

const INTERACTION_MARKERS: readonly GageInteractionMarker[] = [
  'circle', 'square', 'diamond', 'triangle', 'triangle-down', 'cross', 'plus', 'hexagon',
];
const INTERACTION_DASHES: ReadonlyArray<string | undefined> = [
  undefined, '8 3', '2 2', '9 3 2 3', '5 2', '10 2 2 2', '1 3', '6 2 1 2',
];
const INTERACTION_COLORS = [
  '#0054a6', '#931313', '#00841f', '#6f42a8', '#b35c00', '#007a78', '#a51f6f', '#4d5d00',
] as const;

/** 数据线和图例共用的操作员视觉编码；前 8 人的颜色/形状/线型均不重复。 */
export function gageInteractionSeriesStyle(operator: number): GageInteractionSeriesStyle {
  const index = Math.max(0, Math.trunc(operator));
  return {
    color: INTERACTION_COLORS[index]
      ?? `hsl(${Math.round((index * 137.508) % 360)} 62% 36%)`,
    marker: INTERACTION_MARKERS[index % INTERACTION_MARKERS.length],
    dash: INTERACTION_DASHES[index % INTERACTION_DASHES.length],
  };
}

const GAGE_AXIS_EXTREME_THRESHOLD = Number.MAX_VALUE / 16;

function gageAxisScale(lo: number, hi: number): number {
  const maximum = Math.max(Math.abs(lo), Math.abs(hi));
  if (!Number.isFinite(maximum) || maximum <= GAGE_AXIS_EXTREME_THRESHOLD) return 1;
  return 2 ** Math.min(1023, Math.floor(Math.log2(maximum)));
}

function restoreGageAxisCoordinate(value: number, scale: number): number {
  if (Number.isNaN(value)) return Number.NaN;
  if (value === 0) return value;
  const restored = value * scale;
  if (Number.isFinite(restored)) return restored;
  return value < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

function niceRange(lo: number, hi: number): [number, number] {
  const ordinarySpan = hi - lo;
  if (
    hi > lo
    && Number.isFinite(ordinarySpan)
    && Math.max(Math.abs(lo), Math.abs(hi)) <= GAGE_AXIS_EXTREME_THRESHOLD
  ) {
    const pad = ordinarySpan * 0.12;
    return [lo - pad, hi + pad];
  }
  if (!(hi > lo)) {
    if (Number.isFinite(lo) && Math.abs(lo) <= GAGE_AXIS_EXTREME_THRESHOLD) return [lo - 1, hi + 1];
    const scale = gageAxisScale(lo, hi);
    const center = lo / scale;
    return [
      restoreGageAxisCoordinate(center - 0.12, scale),
      restoreGageAxisCoordinate(center + 0.12, scale),
    ];
  }
  const scale = gageAxisScale(lo, hi);
  const loCoordinate = lo / scale;
  const hiCoordinate = hi / scale;
  const pad = (hiCoordinate - loCoordinate) * 0.12;
  return [
    restoreGageAxisCoordinate(loCoordinate - pad, scale),
    restoreGageAxisCoordinate(hiCoordinate + pad, scale),
  ];
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

/**
 * 控制限标签的小数位(UI-07)。此前刻度与 UCL/CL/LCL 标签共用「按量程取 0/2/3 位定点」:
 * 0.07±1e-4 的量具数据 UCL=X̿=LCL 印成同一个数、R̄ 印成 0.000、刻度重复并出现 -0.000;
 * 万级数据 span≥100 走 0 位,R 图/Xbar 图的三条限值同样塌成同一个整数。
 * 现在:刻度走 tokens.tickFormatter(位数按相邻刻度间距推导、整轴统一记数法、去负零);
 * 限值标签沿用刻度的记数法(定点/指数),定点时位数只取下列三者最大(fix2609k:不再继承刻度保真循环
 * 升出来的位数,否则标签位数随轴留白漂移、带多余尾零):
 *  ① Minitab 口径(批次720-A3):均值图 = 数据位数+1,极差图 = 数据位数;
 *  ② UCL−LCL 保留 2 位有效数字(三条限值两两可分);
 *  ③ 中心线保留 3 位有效数字(R̄ 不塌成 0)。
 * 注意(ControlChart 闭环教训):cl/ucl/lcl **不进入刻度位数推导**,只以差值/自身量级给下限;
 * UCL−LCL 相对量级 <1e-9、中心线相对轴跨度 <1e-6 视为浮点噪声不计,避免被 1e-15 级差异逼到 15 位。
 * 精确 0 的限值标签印「0」(工厂 Minitab 形制「LCL=0」)。
 */
export function gageLimitDecimals(
  limits: { cl: number; ucl: number; lcl: number },
  axisSpan: number,
  roleDecimals: number,
): number {
  let dp = Math.max(0, roleDecimals);
  // fix2609k:数量级取整带 1e-9 容差(与 tokens.tickDecimals 同口径)——真值 1e-4 算成
  // 9.9999999999983e-5(残差相对量级随数据尺度可达 1e-12)时不得跨到下一个数量级多出 1 位小数,
  // 否则数学上相同的两组镜像数据印出 0.0001000 / 0.000100 两种标签。
  const magnitudeOf = (value: number) => Math.floor(Math.log10(value) + 1e-9);
  const spread = Math.abs(limits.ucl - limits.lcl);
  const magnitude = Math.max(Math.abs(limits.ucl), Math.abs(limits.lcl), Math.abs(limits.cl));
  if (Number.isFinite(spread) && spread > 0 && spread > magnitude * 1e-9) {
    dp = Math.max(dp, 1 - magnitudeOf(spread));
  }
  const center = Math.abs(limits.cl);
  if (Number.isFinite(center) && center > 0 && !(center < Math.abs(axisSpan) * 1e-6)) {
    dp = Math.max(dp, 2 - magnitudeOf(center));
  }
  return Math.min(20, dp);
}

/** 原始观测的数据位数(values[operator][part][trial],与 dataDecimals 同一 3 位上限);
 * 逐格取最大并在触顶时提前返回,20 万行不做 flat 拷贝。 */
function panelDataDecimals(panel: GagePanelData): number {
  const cap = 3;
  let dp = 0;
  for (const operator of panel.values) {
    for (const part of operator) {
      dp = Math.max(dp, dataDecimals(part, cap));
      if (dp >= cap) return dp;
    }
  }
  return dp;
}

/**
 * 纵轴坐标域与刻度(panelFrame 与限值标签共用同一算法:限值标签需在确定右边距之前知道轴的记数法)。
 * fix2609k UI-07 残余:刻度位置走 tokens.niceTicks(1-2-5 阶梯,与 Minitab/ControlChart 一致)。
 * 此前是量程 5 等分的非圆整位置,保真循环因此升出 0.377428 / 1234561.3 这类 7~9 字符刻度,
 * 右对齐后左端压到旋转的 y 轴标题上。圆整刻度的误差为 0,位数按步长自然回落。
 */
function panelAxis(yLo: number, yHi: number) {
  const coordinateScale = gageAxisScale(yLo, yHi);
  let loCoordinate = yLo / coordinateScale;
  let hiCoordinate = yHi / coordinateScale;
  // 饱和回原单位后可能吃掉超出 ±MAX 的外边距，在坐标域补一层
  // 小留白，保证端点不贴边，同时不生成不可表示的 SVG 属性。
  if (coordinateScale !== 1) {
    const extra = (hiCoordinate - loCoordinate) * 0.02 || 0.02;
    loCoordinate -= extra;
    hiCoordinate += extra;
  }
  if (!(hiCoordinate > loCoordinate)) {
    const center = Number.isFinite(loCoordinate) ? loCoordinate : 0;
    loCoordinate = center - 1;
    hiCoordinate = center + 1;
  }
  const coordinateSpan = hiCoordinate - loCoordinate;
  // 1-2-5 阶梯在 5 目标下至少 3 条网格(与 Minitab 同为 3~6 条);不足 3 条才按更细目标重取——
  // 不为凑条数细分,否则大量级窄量程会多出一位小数(1234579.5),刻度又变长
  const coarse = niceTicks(loCoordinate, hiCoordinate, 5);
  const niceCoordinates = coarse.length >= 3 ? coarse : niceTicks(loCoordinate, hiCoordinate, 8);
  const gridCoordinates = niceCoordinates.length >= 2
    ? niceCoordinates
    : Array.from({ length: 5 }, (_, index) => loCoordinate + (coordinateSpan * index) / 4);
  const tickValues = gridCoordinates.map((coordinate) => restoreGageAxisCoordinate(coordinate, coordinateScale));
  return { coordinateScale, hiCoordinate, coordinateSpan, gridCoordinates, tickValues };
}

/** 旋转 y 轴标题(x=14,字号 9.5)右侧与刻度文本之间至少留到的 x 位置。 */
const Y_TITLE_CLEAR_X = 20;

/** 公共框架:白底、边框、水平网格与 Y 刻度;可带 Minitab 式 y 轴标题(旋转)与 x 轴标题。
 * rightMargin:控制图面板按限值标签长度加宽(gageLimitRightMargin),其余面板用默认 M.r。
 * 左边距(fix2609k UI-07 残余):大量级窄量程的圆整刻度仍可达 9 字符(1234579.4),右对齐于
 * left−6 时左端会压到旋转的 y 轴标题;按最长刻度文本加宽左边距,调用方一律用返回的 left 定位。 */
function panelFrame(T: ChartTokens, yLo: number, yHi: number, yTitle?: string, xTitle?: string, rightMargin: number = M.r) {
  const ph = PH - M.t - M.b;
  const { coordinateScale, hiCoordinate, coordinateSpan, gridCoordinates, tickValues } = panelAxis(yLo, yHi);
  const YCoordinate = (value: number) => M.t + ((hiCoordinate - value) / coordinateSpan) * ph;
  const Y = (value: number) => YCoordinate(value / coordinateScale);
  // UI-07:全部面板的纵轴刻度统一走 tickFormatter(按相邻刻度间距推位数、去重、去负零)
  const tickText = tickFormatter(tickValues.filter(Number.isFinite));
  const grid = gridCoordinates.map((coordinate, index) => ({
    y: YCoordinate(coordinate),
    label: tickText(tickValues[index]),
  }));
  const longestTick = grid.reduce((max, tick) => Math.max(max, gageLabelChars(tick.label)), 0);
  const left = Math.max(M.l, Math.ceil(6 + longestTick * LIMIT_LABEL_CHAR_W + (yTitle ? Y_TITLE_CLEAR_X : 4)));
  const pw = PW - left - rightMargin;
  const frame = (
    <Fragment>
      <rect x={0} y={0} width={PW} height={PH} fill={MTB.panelBg} />
      <rect x={left} y={M.t} width={pw} height={ph} fill="none" stroke={T.axis} strokeWidth={1} />
      {grid.map((tick, index) => (
        <Fragment key={index}>
          <Ln x1={left} y1={tick.y} x2={left + pw} y2={tick.y} stroke={T.grid} sw={1} />
          <Txt x={left - 6} y={tick.y} s={tick.label} fill={T.axis} size={9} anchor="end" />
        </Fragment>
      ))}
      {yTitle && (
        <text x={14} y={M.t + ph / 2} fill={T.text} fontSize={9.5}
          textAnchor="middle" fontFamily="IBM Plex Mono, monospace"
          transform={`rotate(-90 14 ${M.t + ph / 2})`}>{yTitle}</text>
      )}
      {xTitle && <Txt x={left + pw / 2} y={PH - 8} s={xTitle} fill={T.text} size={9.5} anchor="middle" />}
    </Fragment>
  );
  return { pw, ph, Y, frame, tickValues, left };
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
  // 防御旧快照/外部调用方：SVG 坐标永不消费非有限百分比。
  // 新引擎会将无法表示的 %Tol fail-closed 为 null，此处再保证图形不被污染。
  const finitePercent = (value: number | null | undefined): number => (
    value != null && Number.isFinite(value) && value >= 0 ? value : 0
  );
  const hasTol = grr?.pctTolerance != null && Number.isFinite(grr.pctTolerance);
  const rowOf = (name: string, component: ReturnType<typeof find>): GageBarCategory => ({
    name,
    contrib: finitePercent(component?.pctContribution),
    study: finitePercent(component?.pctStudyVar),
    tol: hasTol ? finitePercent(component?.pctTolerance) : null,
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
  const { pw, ph, Y, frame, left } = panelFrame(T, yLo, yHi, '百分比');
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
            const x = left + groupWidth * catIndex + groupWidth / 2 + (seriesIndex - (seriesDefs.length - 1) / 2) * (barWidth + 2) - barWidth / 2;
            return <rect key={def.key} x={x} y={Y(value)} width={barWidth} height={Math.max(0, M.t + ph - Y(value))} fill={def.color} stroke={T.axis} strokeWidth={0.6} />;
          })}
          <Txt x={left + groupWidth * catIndex + groupWidth / 2} y={PH - M.b + 12} s={cat.name} fill={T.text} size={9} anchor="middle" />
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
  roleDecimals: number,
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
  const total = o * p;
  // 限值标签沿用刻度的记数法;定点时位数只取 gageLimitDecimals(不把 cl/ucl/lcl 混进刻度推导,
  // 也不继承刻度保真循环升出来的位数——fix2609k UI-07 残余)
  const finiteTicks = panelAxis(yLo, yHi).tickValues.filter(Number.isFinite);
  const limitText = limits
    ? (() => {
      const axisSpan = finiteTicks.length > 1 ? finiteTicks[finiteTicks.length - 1] - finiteTicks[0] : 0;
      const limitDp = gageLimitDecimals(limits, axisSpan, roleDecimals);
      const axisFmt = tickFormatter(finiteTicks, limitDp);
      const axisExponent = finiteTicks.some((tick) => /e/i.test(axisFmt(tick)));
      const fixed = (value: number) => nf(value, Math.min(100, limitDp)).replace(/^-(?=0(\.0*)?$)/, '');
      return (value: number) => (value === 0 ? '0' : axisExponent ? axisFmt(value) : fixed(value));
    })()
    : null;
  const labels = limits && limitText
    ? {
      ucl: `UCL=${limitText(limits.ucl)}`,
      cl: `${limitLabel}=${limitText(limits.cl)}`,
      lcl: limits.lcl !== limits.ucl ? `LCL=${limitText(limits.lcl)}` : null,
    }
    : null;
  const rightMargin = labels
    ? gageLimitRightMargin([labels.ucl, labels.cl, ...(labels.lcl ? [labels.lcl] : [])])
    : M.r;
  const { pw, Y, frame, left } = panelFrame(T, yLo, yHi, yTitle, xTitle, rightMargin);
  const X = (index: number) => left + ((index + 0.5) / total) * pw;
  const points: string[] = [];
  flat.forEach((value, index) => points.push(`${X(index)},${Y(value)}`));
  const limitLine = (value: number, label: string, color: string, solid: boolean) => (
    <Fragment key={label}>
      <Ln x1={left} y1={Y(value)} x2={left + pw} y2={Y(value)} stroke={color} sw={1.2} dash={solid ? undefined : T.limitDash} />
      <Txt x={left + pw + 4} y={Y(value)} s={label} fill={color} size={LIMIT_LABEL_SIZE} weight={600} />
    </Fragment>
  );
  return (
    <Fragment>
      {frame}
      {limits && labels && limitLine(limits.ucl, labels.ucl, MTB.limit, true)}
      {limits && labels && limitLine(limits.cl, labels.cl, MTB.center, true)}
      {limits && labels?.lcl && limitLine(limits.lcl, labels.lcl, MTB.limit, true)}
      <polyline points={points.join(' ')} fill="none" stroke={MTB.data} strokeWidth={1.1} />
      {flat.map((value, index) => (
        <circle key={index} cx={X(index)} cy={Y(value)} r={2.6} fill={MTB.data} />
      ))}
      {Array.from({ length: o }, (_, operator) => (
        <Fragment key={operator}>
          {operator > 0 && (
            <Ln x1={left + (operator * p / total) * pw} y1={M.t} x2={left + (operator * p / total) * pw} y2={PH - M.b} stroke={MTB.data} sw={1} />
          )}
          {o > 1 && (
            <Txt x={left + ((operator + 0.5) * p / total) * pw} y={M.t + 11} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9.5} anchor="middle" weight={600} />
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
  const { pw, Y, frame, left } = panelFrame(T, yLo, yHi, undefined, partName);
  const X = (part: number) => left + ((part + 0.5) / p) * pw;
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

// v1.43.0:四分位数实现下沉 core.minitabQuantile 单源(双审:口径三分裂收口),此处仅留薄别名
const quantileOf = (sorted: number[], q: number): number => minitabQuantile(sorted, q, true); // 入参已排序

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
  // 闭环 P3:入口统一过滤非有限值——此前 Summary 传原数组、misc 传已过滤数组,
  // 同一份含 NaN 的数据两处画出不同的箱须。
  values = values.filter(Number.isFinite);
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

/** 离群点抽稀:与 ControlChart 的失控点同口径(均匀抽稀 + 最小/最大必留),
 * 返回 {shown, total};total>shown 时调用方须写明「共 N 个,图上显示 M 个」。
 * 自审 P2:此前 Summary 用 slice(0,500) 直接砍前 500 个——按值排序后这是方向性偏倚,
 * 只保留最小的一批,最大的离群点全部消失;misc.BoxPlot 则完全没有上限。 */
export function sampleOutliers(outliers: number[], cap = 500): { shown: number[]; total: number } {
  // 闭环 P3:两条分支必须同口径——都返回**已排序**的数组,否则未超限时给原序、
  // 超限时给升序,消费方(圆圈绘制顺序、极值判断)行为随数据量突变。
  const sorted = [...outliers].sort((a, b) => a - b);
  const total = sorted.length;
  // 两条分支同口径:都按升序返回、都**保留重数**。
  // 自审 P1:曾为消除 cap 边界的「一侧去重一侧不去重」而给两侧都加去重,结果把
  // 「重复离群值的密集程度」这一视觉信息整块抹掉(同一个值出现 200 次只画 1 个圈),
  // 而且未超限时也报「抽样显示」是谎报。正确做法是两侧都不去重。
  if (total <= cap) return { shown: sorted, total };
  const picked = decimateUniform(sorted.length, cap).map((k) => sorted[k]);
  // 极值必留:仅在首末缺席时补,不对中间抽样结果去重
  const shown = picked.slice();
  if (shown[0] !== sorted[0]) shown.unshift(sorted[0]);
  if (shown[shown.length - 1] !== sorted[sorted.length - 1]) shown.push(sorted[sorted.length - 1]);
  return { shown, total };
}

function byOperatorBody(T: ChartTokens, panel: GagePanelData, operatorLabels: string[], operatorName = '测试人'): ReactNode {
  const o = panel.operatorCount;
  const all: number[] = panel.values.flat(2);
  const [allLo, allHi] = rangeOf(all);
  const [yLo, yHi] = niceRange(allLo, allHi);
  const { pw, Y, frame, left } = panelFrame(T, yLo, yHi, undefined, operatorName);
  const X = (operator: number) => left + ((operator + 0.5) / o) * pw;
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
            <MeanMarker x={x} y={Y(panel.operatorMeans[operator])} color={MTB.data} />
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

function interactionMarker(shape: GageInteractionMarker, x: number, y: number, color: string): ReactNode {
  if (shape === 'circle') return <circle cx={x} cy={y} r={3.2} fill={color} />;
  if (shape === 'square') return <rect x={x - 3.2} y={y - 3.2} width={6.4} height={6.4} fill={color} />;
  if (shape === 'diamond') {
    return <polygon points={`${x},${y - 4.4} ${x + 4.4},${y} ${x},${y + 4.4} ${x - 4.4},${y}`} fill={color} />;
  }
  if (shape === 'triangle') {
    return <polygon points={`${x},${y - 4.5} ${x + 4.2},${y + 3.5} ${x - 4.2},${y + 3.5}`} fill={color} />;
  }
  if (shape === 'triangle-down') {
    return <polygon points={`${x - 4.2},${y - 3.5} ${x + 4.2},${y - 3.5} ${x},${y + 4.5}`} fill={color} />;
  }
  if (shape === 'hexagon') {
    return <polygon points={`${x - 4},${y} ${x - 2},${y - 3.6} ${x + 2},${y - 3.6} ${x + 4},${y} ${x + 2},${y + 3.6} ${x - 2},${y + 3.6}`} fill={color} />;
  }
  if (shape === 'cross') {
    return <path d={`M ${x - 3.5} ${y - 3.5} L ${x + 3.5} ${y + 3.5} M ${x + 3.5} ${y - 3.5} L ${x - 3.5} ${y + 3.5}`} fill="none" stroke={color} strokeWidth={1.8} />;
  }
  return <path d={`M ${x - 4} ${y} L ${x + 4} ${y} M ${x} ${y - 4} L ${x} ${y + 4}`} fill="none" stroke={color} strokeWidth={1.8} />;
}

function interactionBody(T: ChartTokens, panel: GagePanelData, partLabels: string[], operatorLabels: string[], partName = '部件'): ReactNode {
  const p = panel.partCount;
  const flat = panel.cellMeans.flat();
  const [flatLo, flatHi] = rangeOf(flat);
  const [yLo, yHi] = niceRange(flatLo, flatHi);
  const { pw, Y, frame, left } = panelFrame(T, yLo, yHi, '平均', partName);
  const X = (part: number) => left + ((part + 0.5) / p) * pw;
  const styles = panel.cellMeans.map((_, operator) => gageInteractionSeriesStyle(operator));
  const legendW = 112;
  return (
    <Fragment>
      {frame}
      {panel.cellMeans.map((byPart, operator) => (
        <Fragment key={operator}>
          <polyline
            points={byPart.map((mean, part) => `${X(part)},${Y(mean)}`).join(' ')}
            fill="none" stroke={styles[operator].color} strokeWidth={1.3}
            strokeDasharray={styles[operator].dash}
          />
          {byPart.map((mean, part) => (
            <Fragment key={part}>{interactionMarker(styles[operator].marker, X(part), Y(mean), styles[operator].color)}</Fragment>
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
          <Ln x1={PW - M.r - legendW + 7} y1={M.t + 17 + operator * 16}
            x2={PW - M.r - legendW + 29} y2={M.t + 17 + operator * 16}
            stroke={styles[operator].color} sw={1.3} dash={styles[operator].dash} />
          {interactionMarker(styles[operator].marker, PW - M.r - legendW + 18, M.t + 17 + operator * 16, styles[operator].color)}
          <Txt x={PW - M.r - legendW + 34} y={M.t + 18 + operator * 16} s={operatorLabels[operator] ?? `操作员${operator + 1}`} fill={T.text} size={9} />
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

/**
 * 整图画布尺寸的唯一来源(fix2611a G25c C4):GageReportFigure 的 SVG viewBox 与报告层声明的
 * 位图尺寸(activeAnalysisReport → Word/PPT 位图化)都由这组常量推导,单操作员 2×2、多操作员 2×3。
 */
export function gageReportFigureSize(single: boolean): { width: number; height: number } {
  const rows = single ? 2 : 3;
  return {
    width: FIG_M * 2 + PW * 2 + CELL_GAP,
    height: HEADER_H + rows * (TITLE_H + PH + CELL_GAP) + FIG_M,
  };
}

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
  // Minitab 限值标签口径:均值图 = 数据位数+1,极差图 = 数据位数(与 SPC ControlChart 同源)
  const dataDp = panelDataDecimals(panel);
  const cells: Array<{ title: string; body: ReactNode }> = single
    ? [
      { title: '变异分量', body: componentsBody(T, cats) },
      { title: 'R 控制图', body: groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄', dataDp, '样本极差', partName) },
      { title: `${valueName} × ${partName}`, body: byPartBody(T, panel, partLabels, partName) },
      { title: 'XBar 控制图', body: groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿', dataDp + 1, '样本均值', partName) },
    ]
    : [
      { title: '变异分量', body: componentsBody(T, cats) },
      { title: `${valueName} × ${partName}`, body: byPartBody(T, panel, partLabels, partName) },
      { title: `R 控制图（按 ${operatorName}）`, body: groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄', dataDp, '样本极差', partName) },
      { title: `${valueName} × ${operatorName}`, body: byOperatorBody(T, panel, operatorLabels, operatorName) },
      { title: `Xbar 控制图（按 ${operatorName}）`, body: groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿', dataDp + 1, '样本均值', partName) },
      { title: `${partName} 乘 ${operatorName} 交互作用`, body: interactionBody(T, panel, partLabels, operatorLabels, partName) },
    ];
  const { width, height } = gageReportFigureSize(single);
  return (
    <Svg w={width} h={height} readable label={`量具研究 · ${valueName} 的量具 R&R（方差分析）报告`}>
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
  return <Svg w={PW} h={PH} readable label="量具研究 · 极差（R）控制图">{groupedControlBody(T, panel, operatorLabels, panel.cellRanges, panel.rLimits, 'R̄', panelDataDecimals(panel))}</Svg>;
}

export function GageXbarPanel({ T, panel, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH} readable label="量具研究 · 均值（X̄）控制图">{groupedControlBody(T, panel, operatorLabels, panel.cellMeans, panel.xbarLimits, 'X̿', panelDataDecimals(panel) + 1)}</Svg>;
}

export function GageByPartPanel({ T, panel, partLabels }: PanelProps) {
  return <Svg w={PW} h={PH} readable label="量具研究 · 按部件的测量值">{byPartBody(T, panel, partLabels)}</Svg>;
}

export function GageByOperatorPanel({ T, panel, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH} readable label="量具研究 · 按操作员的测量值">{byOperatorBody(T, panel, operatorLabels)}</Svg>;
}

export function GageInteractionPanel({ T, panel, partLabels, operatorLabels }: PanelProps) {
  return <Svg w={PW} h={PH} readable label="量具研究 · 部件 × 操作员交互作用">{interactionBody(T, panel, partLabels, operatorLabels)}</Svg>;
}
