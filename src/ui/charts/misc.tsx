/**
 * 帕累托图 / 分组柱状图 (Gage) / 箱线图 — 从原型 pareto/groupedBars/boxplot 迁移。
 */
import { memo, Fragment } from 'react';
import { nf, arrMax, mean, stdev, tInv, decimateUniform } from '../../core';
import { sampleOutliers, boxplotStats } from './gagePanels';
import type { ChartTokens } from '../tokens';
/** 左槽宽度:按最长刻度标签估算(自审 P2:改用 tickFormatter 后标签变长,
 * 固定 44~56px 装不下,标签被 viewBox 裁掉)。10px 字号下每字符约 6px。 */
const axisLeft = (labels: readonly string[], base: number) => {
  const longest = labels.reduce((length, label) => Math.max(length, label.length), 0);
  return Math.max(base, longest * 6 + 14);
};
import { Svg, Ln, Txt } from './primitives';
import {
  coordinateDomain,
  coordinateTicks,
  createPowerOfTwoAxis,
  linearCoordinateTicks,
  niceCoordinateTicks,
  projectCoordinate,
} from './axisScale';

/** 960px 分组图的共同显示预算；仅限制绘图，不截断统计输入。 */
export const MAX_GROUPED_PLOT_GROUPS = 12;
export const MAX_GROUPED_PLOT_POINTS = 1200;

export function groupedPlotWindow<G>(groups: G[], requestedStart = 0) {
  const lastStart = Math.max(0, Math.floor((groups.length - 1) / MAX_GROUPED_PLOT_GROUPS) * MAX_GROUPED_PLOT_GROUPS);
  const start = Math.min(lastStart, Math.max(0, Number.isFinite(requestedStart)
    ? Math.floor(requestedStart / MAX_GROUPED_PLOT_GROUPS) * MAX_GROUPED_PLOT_GROUPS : 0));
  const end = Math.min(groups.length, start + MAX_GROUPED_PLOT_GROUPS);
  return {
    groups: groups.slice(start, end), start, end, total: groups.length,
    note: groups.length > MAX_GROUPED_PLOT_GROUPS
      ? `显示第 ${start + 1}–${end} 组，共 ${groups.length} 组；其余组未在本图显示。统计使用全部组与观测。`
      : '',
  };
}

/** 标签按当前组槽缩短；完整名称保留在 SVG tooltip 中。 */
function GroupAxisLabel({ name, x, y, width, T }: { name: string; x: number; y: number; width: number; T: ChartTokens }) {
  const maxChars = Math.max(2, Math.floor(width / 11));
  const characters = Array.from(name);
  const label = characters.length > maxChars ? `${characters.slice(0, maxChars - 1).join('')}…` : name;
  return <g><title>{name}</title><Txt x={x} y={y} s={label} fill={T.text} size={11} anchor="middle" weight={500} /></g>;
}

export interface GageBarCat {
  name: string;
  contrib: number;
  study: number;
  tol: number | null;
}

// ---------- 帕累托 ----------
/** 帕累托图显示预算(UI-10):导入契约允许 5 万类别,逐类画柱/累计点/统计表会生成数十万 SVG 节点
 * 并冻结总览(默认落地页)与帕累托页;柱宽在 ~1000 类时已不足 1px,图本身也不可读。
 * 超出预算时按输入顺序(已按频数降序)保留前 N−1 类,其余合并为一根「其他(X 类)」柱,
 * 并在图上注明折叠数。只限制绘图,频数总和、累计%与结论仍按全部类别计算。 */
export const MAX_PARETO_PLOT_BARS = 30;

export interface ParetoDisplayWindow<R> {
  /** 逐类显示的前若干行(原样引用输入行)。 */
  shown: R[];
  /** 被折叠的尾部合计;未超预算时为 null。 */
  other: { name: string; count: number; categories: number } | null;
  totalCategories: number;
}

/** 帕累托图/明细表共用的显示窗口:超过 maxRows 时保留前 maxRows−1 行 + 一行「其他(X 类)」。 */
export function paretoDisplayWindow<R extends { name: string; count: number }>(
  rows: readonly R[],
  maxRows: number,
): ParetoDisplayWindow<R> {
  const budget = Math.max(2, Math.floor(maxRows));
  if (rows.length <= budget) return { shown: rows.slice(), other: null, totalCategories: rows.length };
  const keep = budget - 1;
  let tail = 0;
  for (let i = keep; i < rows.length; i++) tail += rows[i].count;
  const categories = rows.length - keep;
  return {
    shown: rows.slice(0, keep),
    other: { name: `其他（${categories} 类）`, count: tail, categories },
    totalCategories: rows.length,
  };
}

function ParetoChartImpl(p: {
  T: ChartTokens;
  rows: { name: string; count: number }[];
  w?: number;
  h?: number;
  /** 经典主题标题(Minitab 式「〈列名〉 的 Pareto 图」);其余主题忽略 */
  title?: string;
}) {
  const T = p.T;
  const plotWindow = paretoDisplayWindow(p.rows, MAX_PARETO_PLOT_BARS);
  const rows = plotWindow.other
    ? [...plotWindow.shown, { name: plotWindow.other.name, count: plotWindow.other.count }]
    : plotWindow.shown;
  const foldNote = plotWindow.other
    ? `共 ${plotWindow.totalCategories} 类 · 显示前 ${plotWindow.shown.length} 类，其余 ${plotWindow.other.categories} 类合并为「其他」`
    : '';
  const W = p.w ?? 960;
  const H = p.h ?? 300;
  // 批次720-C2:帕累托不再跟随图表风格切换形制——任何主题都输出 Minitab 形制
  // (顶部居中标题+钢蓝零间距柱+底部 类别/频数/百分比/累积% 统计表+黑色清晰字体)。
  // 工厂旧持久化 chartStyle='现代'(v1.34 前默认)曾让验收看到彩色渐变柱与灰色小字。
  const classic = true;
  // 此图始终使用一套独立的经典白底 token，避免“高对比”主题把白字/深色网格
  // 混进 Minitab 形制，造成黑底黑字或统计表不可读。
  const colors = ['#5B9BD5'];
  const showTable = classic && H >= 260;
  const m = {
    t: classic && p.title ? 36 : 24,
    r: 66,
    b: showTable ? 88 : 64,
    l: 62,
  };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  const maxc = (rows[0]?.count ?? 0) || 1;
  const bw = pw / rows.length;
  // 经典主题左轴量程 = 累计总数(与右轴 0–100% 逐点对齐);其余主题按最大柱 1.05 倍
  const yMaxCount = classic ? total : maxc * 1.05;
  const Yc = (c: number) => m.t + (1 - c / yMaxCount) * ph;
  const Yp = (pc: number) => m.t + (1 - pc / 100) * ph;
  let cum = 0;
  const cumPts: Array<[number, number, number]> = [];
  rows.forEach((r, i) => {
    cum += r.count;
    cumPts.push([m.l + i * bw + bw / 2, Yp((cum / total) * 100), Math.round((cum / total) * 100)]);
  });
  const cumLine = '#1F3864';
  const barStroke = classic ? '#2A4B8D' : undefined;
  // 表格行:类别名按柱宽截断(CJK 字宽 ≈ 10px @ size 9.5)
  const clip = (s: string) => {
    const maxCh = Math.max(2, Math.floor(bw / 12));
    return s.length > maxCh ? s.slice(0, maxCh - 1) + '…' : s;
  };
  const tableRows: Array<{ label: string; value: (i: number) => string }> = [
    { label: '类别', value: (i) => clip(rows[i].name) },
    { label: '频数', value: (i) => String(rows[i].count) },
    { label: '百分比', value: (i) => Math.round((rows[i].count / total) * 100) + '' },
    { label: '累积%', value: (i) => String(cumPts[i][2]) },
  ];
  return (
    <Svg w={W} h={H} readable label={`${p.title?.trim() || '帕累托图'}${foldNote ? `；${foldNote}` : ''}`}>
      <rect x={0} y={0} width={W} height={H} fill="#FFFFFF" />
      {classic && p.title && (
        <Txt x={m.l + pw / 2} y={15} s={p.title} fill="#111111" size={14} anchor="middle" weight={700} />
      )}
      {foldNote && <Txt x={m.l + pw} y={m.t - 8} s={foldNote} fill="#5b6472" size={10} anchor="end" />}
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke="#D9D9D9" sw={1} />
            <Txt x={m.l - 6} y={yy} s={String(Math.round(yMaxCount - (yMaxCount * g) / 4))} fill="#111111" size={10.5} anchor="end" />
            <Txt x={m.l + pw + 6} y={yy} s={100 - (100 * g) / 4 + '%'} fill="#111111" size={10.5} />
          </Fragment>
        );
      })}
      {rows.map((r, i) => {
        // 经典主题零间距(Minitab 柱贴合);其余主题保留 6px 间隙
        const gap = classic ? 0 : 6;
        const x0 = m.l + i * bw + gap;
        const x1 = m.l + (i + 1) * bw - gap;
        return (
          <Fragment key={'b' + i}>
            <rect
              x={x0} y={Yc(r.count)} width={x1 - x0} height={m.t + ph - Yc(r.count)}
              fill={colors[i % colors.length]} opacity={classic ? 1 : 0.9}
              stroke={barStroke} strokeWidth={barStroke ? 1 : 0}
            />
            {!classic && <Txt x={(x0 + x1) / 2} y={Yc(r.count) - 8} s={String(r.count)} fill={T.text} size={10} anchor="middle" weight={600} />}
            {!showTable && <Txt x={m.l + i * bw + bw / 2} y={H - 34} s={r.name} fill={T.axis} size={10} anchor="middle" />}
          </Fragment>
        );
      })}
      <polyline points={cumPts.map((pt) => pt[0] + ',' + pt[1]).join(' ')} fill="none" stroke={cumLine} strokeWidth={2} />
      {cumPts.map((pt, i) => (
        <Fragment key={'c' + i}>
          <circle cx={pt[0]} cy={pt[1]} r={3.4} fill={cumLine} stroke="#FFFFFF" strokeWidth={1.2} />
          {!classic && <Txt x={pt[0]} y={pt[1] - 11} s={pt[2] + '%'} fill={cumLine} size={9.5} anchor="middle" weight={600} />}
        </Fragment>
      ))}
      {showTable ? (
        tableRows.map((row, ri) => {
          const yy = m.t + ph + 16 + ri * 15;
          return (
            <Fragment key={'tr' + ri}>
              <Txt x={m.l - 6} y={yy} s={row.label} fill="#111111" size={11} anchor="end" weight={600} />
              {rows.map((_, ci) => (
                <Txt key={'tc' + ci} x={m.l + ci * bw + bw / 2} y={yy} s={row.value(ci)} fill="#111111" size={11} anchor="middle" />
              ))}
            </Fragment>
          );
        })
      ) : (
        <Txt x={m.l + pw / 2} y={H - 10} s="缺陷 / 原因类别（按频数降序）" fill="#111111" size={10.5} anchor="middle" weight={600} />
      )}
      <text x={16} y={m.t + ph / 2} fill="#111111" fontSize={10.5} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontWeight={600} transform={`rotate(-90 16 ${m.t + ph / 2})`}>计数</text>
      <text x={W - 14} y={m.t + ph / 2} fill="#111111" fontSize={10.5} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontWeight={600} transform={`rotate(90 ${W - 14} ${m.t + ph / 2})`}>百分比</text>
      {classic ? (
        <rect x={m.l} y={m.t} width={pw} height={ph} fill="none" stroke="#7F7F7F" strokeWidth={1} />
      ) : (
        <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke="#7F7F7F" sw={1} />
      )}
    </Svg>
  );
}

// ---------- Gage 分组柱 ----------
function GroupedBarsImpl({ T, cats }: { T: ChartTokens; cats: GageBarCat[] }) {
  const W = 960;
  const H = 300;
  const m = { t: 26, r: 24, b: 52, l: 48 };
  const series = [
    { k: 'contrib' as const, c: T.bar },
    { k: 'study' as const, c: T.bar2 },
    { k: 'tol' as const, c: T.bar3 },
  ];
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const gw = pw / cats.length;
  const bw = (gw * 0.72) / series.length;
  const finiteValues = cats
    .flatMap((cat) => series.map((item) => cat[item.k]))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const rawMax = Math.max(0, ...finiteValues);
  const axisMax = Math.max(100, Math.ceil(rawMax / 25) * 25);
  const Y = (v: number) => m.t + (1 - v / axisMax) * ph;
  const leg: Array<[string, string]> = [['%贡献', T.bar], ['%研究变异', T.bar2], ['%公差', T.bar3]];
  let lx = m.l;
  const legendEls = leg.map(([lab, c]) => {
    const x = lx;
    lx += lab.length * 11 + 34;
    return (
      <Fragment key={lab}>
        <rect x={x} y={H - 14} width={11} height={11} fill={c} />
        <Txt x={x + 16} y={H - 8} s={lab} fill={T.text} size={10} />
      </Fragment>
    );
  });
  return (
    <Svg w={W} h={H} readable label={`量具 R&R 变异分量图 · ${cats.length} 个分量（%贡献 / %研究变异 / %公差）`}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 6} y={yy} s={nf(axisMax - (axisMax * g) / 4, 0) + '%'} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {cats.map((cat, i) => {
        const gx = m.l + i * gw + gw * 0.14;
        return (
          <Fragment key={'c' + i}>
            {series.map((s, j) => {
              const value = cat[s.k];
              return value == null ? null : (
                <rect key={s.k} x={gx + j * bw} y={Y(value)} width={bw - 3} height={m.t + ph - Y(value)} fill={s.c} />
              );
            })}
            <Txt x={m.l + i * gw + gw / 2} y={H - 30} s={cat.name} fill={T.text} size={10.5} anchor="middle" weight={500} />
          </Fragment>
        );
      })}
      {legendEls}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

/** 分组图的无障碍名称里列出的组名(至多 6 个，其余以「等 N 组」收尾)。 */
function groupNamesText(groups: ReadonlyArray<{ name: string }>): string {
  if (groups.length === 0) return '无分组';
  const shown = groups.slice(0, 6).map((group) => group.name).join('、');
  return groups.length > 6 ? `${shown} 等 ${groups.length} 组` : shown;
}

// ---------- 箱线图 ----------
function BoxPlotImpl({ T, groups: allGroups, groupStart }: {
  T: ChartTokens; groups: { name: string; vals: number[] }[]; groupStart?: number;
}) {
  const W = 960;
  const H = 320;
  const window = groupedPlotWindow(allGroups, groupStart);
  const groups = window.groups;
  const allValues = groups.flatMap((group) => group.vals).filter(Number.isFinite);
  const axis = createPowerOfTwoAxis(allValues);
  const allCoordinates = allValues.map(axis.coordinate);
  const domain = coordinateDomain(axis, allCoordinates, {
    padding: 0.15,
    constantHalf: 1,
    constantRelative: 0.1,
    extremeConstantRelative: 0.1,
  });
  // 闭环 P3:截断说明必须走 Svg 的 label(= aria-label);挂在根 <svg> 里的 <title>
  // 会被 role="img"+aria-label 压过,屏幕阅读器读不到,页面上也没有可见文字。
  // 自审 P3:每组只算一次(此前截断说明与渲染各算一遍 boxplotStats+sampleOutliers)
  const perGroup = groups.map((g) => {
    const coordinates = g.vals.filter(Number.isFinite).map(axis.coordinate);
    const stats = boxplotStats(coordinates);
    return {
      g,
      stats,
      sampled: sampleOutliers(stats.outliers),
      groupMean: coordinates.length ? mean(coordinates) : Number.NaN,
    };
  });
  const truncation = perGroup
    .map(({ g, sampled }) => sampled.total > sampled.shown.length
      ? `${g.name} 共 ${sampled.total} 个离群观测，图上抽样显示 ${sampled.shown.length} 个` : null)
    .filter(Boolean);
  const truncatedNote = truncation.length ? truncation.join('；') : null;
  const yTicks = linearCoordinateTicks(axis, domain, 5);
  // 左槽按最长刻度标签定宽。自审 P1:必须在 lo/hi 已知后**一次算定**——
  // 先定 m 再改写 m.l 会让 pw(const,早已求值)不跟着收窄,绘图区右界冲出 viewBox。
  const m = { t: window.note ? 42 : 24, r: 30, b: 44, l: axisLeft(yTicks.map((tick) => tick.label), 52) };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const Y = (coordinate: number) => projectCoordinate(coordinate, domain, m.t, ph, true);
  const gw = pw / Math.max(1, groups.length);
  return (
    <Svg
      w={W}
      h={H}
      // 有截断/窗口说明(实质补充信息)时沿用 role="img"；否则以具名 group 呈现，刻度文字仍可读(fix2611a D5)。
      // fix2611b B3:与个体值图、区间图同形制——有说明时名称以「箱线图；」开头再接说明。
      label={truncatedNote || window.note
        ? `箱线图；${[truncatedNote, window.note].filter(Boolean).join('；')}`
        : `箱线图 · ${groupNamesText(groups)}`}
      readable={!truncatedNote && !window.note}
    >
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {window.note && <Txt x={m.l} y={16} s={window.note} fill={T.text} size={10.5} />}
      {yTicks.map((tick, index) => (
        <Fragment key={'g' + index}>
          <Ln x1={m.l} y1={Y(tick.coordinate)} x2={m.l + pw} y2={Y(tick.coordinate)} stroke={T.grid} sw={1} />
          <Txt x={m.l - 8} y={Y(tick.coordinate)} s={tick.label} fill={T.axis} size={10} anchor="end" />
        </Fragment>
      ))}
      {groups.map((grp, i) => {
        const cx = m.l + i * gw + gw / 2;
        const bw = gw * 0.32;
        // 箱线统计走共享实现(闭环审核 P3:此前本处与 MSA 箱线的须钳位不同,
        // 同一列数据两处画出不同的须——boxplotStats 保证「须不短于箱边」)
        // 自审 P3:复用上面 perGroup 的同一次计算(此前截断说明与渲染各算一遍)
        const { stats, sampled, groupMean } = perGroup[i];
        const { q1, median: q2, q3, whiskerLo: mn, whiskerHi: mx } = stats;
        const outliers = sampled.shown;
        const drawable = [q1, q2, q3, mn, mx].every(Number.isFinite);
        return (
          <Fragment key={'b' + i}>
            {drawable && (
              <>
                <Ln x1={cx} y1={Y(mn)} x2={cx} y2={Y(mx)} stroke={T.axis} sw={1.4} />
                <Ln x1={cx - bw * 0.4} y1={Y(mn)} x2={cx + bw * 0.4} y2={Y(mn)} stroke={T.axis} sw={1.4} />
                <Ln x1={cx - bw * 0.4} y1={Y(mx)} x2={cx + bw * 0.4} y2={Y(mx)} stroke={T.axis} sw={1.4} />
                {outliers.map((value, outlierIndex) => (
                  <circle key={'o' + outlierIndex} cx={cx} cy={Y(value)} r={T.r * 0.9} fill="none" stroke={T.axis} strokeWidth={1.4} />
                ))}
                <rect x={cx - bw} y={Y(q3)} width={bw * 2} height={Math.max(1, Y(q1) - Y(q3))} fill={T.point} opacity={0.28} stroke={T.point} strokeWidth={1.6} />
                <Ln x1={cx - bw} y1={Y(q2)} x2={cx + bw} y2={Y(q2)} stroke={T.center} sw={2.4} />
                {Number.isFinite(groupMean) && <circle cx={cx} cy={Y(groupMean)} r={T.r} fill={T.limit} stroke={T.bg} strokeWidth={1.2} />}
              </>
            )}
            <GroupAxisLabel name={grp.name} x={cx} y={H - 24} width={gw} T={T} />
          </Fragment>
        );
      })}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const ParetoChart = memo(ParetoChartImpl);

export const GroupedBars = memo(GroupedBarsImpl);

export const BoxPlot = memo(BoxPlotImpl);

/** 个体值图 — 按组显示每个原始观测，短横线为组均值。 */
function IndividualValuePlotImpl({ T, groups: allGroups, h, groupStart }: {
  T: ChartTokens;
  groups: { name: string; vals: number[] }[];
  h?: number;
  groupStart?: number;
}) {
  const W = 960;
  const H = h ?? 320;
  const window = groupedPlotWindow(allGroups, groupStart);
  const groups = window.groups;
  const all = groups.flatMap((group) => group.vals).filter(Number.isFinite);
  const axis = createPowerOfTwoAxis(all);
  const allCoordinates = all.map(axis.coordinate);
  const domain = coordinateDomain(axis, allCoordinates, {
    padding: 0.12,
    constantHalf: 1,
    constantRelative: 0.1,
    extremeConstantRelative: 0.1,
  });
  const yTicks = linearCoordinateTicks(axis, domain, 5);
  // 左槽按最长刻度标签定宽。自审 P1:必须在 lo/hi 已知后**一次算定**——
  // 先定 m 再改写 m.l 会让 pw(const,早已求值)不跟着收窄,绘图区右界冲出 viewBox。
  const m = { t: window.note ? 46 : 26, r: 30, b: 44, l: axisLeft(yTicks.map((tick) => tick.label), 56) };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const Y = (coordinate: number) => projectCoordinate(coordinate, domain, m.t, ph, true);
  const gw = pw / Math.max(1, groups.length);
  const perGroupLimit = Math.floor(MAX_GROUPED_PLOT_POINTS / Math.max(1, groups.length));
  const prepared = groups.map((grp) => {
    const finite = grp.vals
      .map((value, index) => ({ value, coordinate: axis.coordinate(value), index }))
      .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.coordinate));
    let minI = 0; let maxI = 0;
    finite.forEach((point, index) => {
      if (point.coordinate < (finite[minI]?.coordinate ?? Infinity)) minI = index;
      if (point.coordinate > (finite[maxI]?.coordinate ?? -Infinity)) maxI = index;
    });
    return {
      grp,
      finite,
      // 额外保留的两个极值也计入总点预算，不能让 decimateUniform 的 keep 超支。
      selected: finite.length <= perGroupLimit
        ? decimateUniform(finite.length, perGroupLimit)
        : decimateUniform(finite.length, perGroupLimit - 2, [minI, maxI]),
    };
  });
  const plotted = prepared.reduce((a, p) => a + p.selected.length, 0);
  const total = prepared.reduce((a, p) => a + p.finite.length, 0);
  // 组均值连接折线(对标 Minitab 个体值图):空组不参与连线,均值用全量数据。
  const meanPts = prepared
    .map(({ finite }, groupIndex) => (finite.length
      ? `${m.l + groupIndex * gw + gw / 2},${Y(mean(finite.map((point) => point.coordinate)))}`
      : null))
    .filter((s): s is string => s != null);
  return (
    <Svg w={W} h={H} label={window.note ? `个体值图；${window.note}` : `个体值图 · ${groupNamesText(groups)}`} readable={!window.note}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {window.note && <Txt x={m.l} y={32} s={window.note} fill={T.text} size={10.5} />}
      {yTicks.map((tick, index) => (
        <Fragment key={'g' + index}>
          <Ln x1={m.l} y1={Y(tick.coordinate)} x2={m.l + pw} y2={Y(tick.coordinate)} stroke={T.grid} sw={1} />
          <Txt x={m.l - 8} y={Y(tick.coordinate)} s={tick.label} fill={T.axis} size={10} anchor="end" />
        </Fragment>
      ))}
      {meanPts.length > 1 && (
        <polyline points={meanPts.join(' ')} fill="none" stroke={T.center} strokeWidth={1.4} opacity={0.85} />
      )}
      {prepared.map(({ grp, finite, selected }, gi) => {
        const cx = m.l + gi * gw + gw / 2;
        // 大样本时保留首尾与极值，并明确标注渲染数；均值仍使用全量数据。
        const mu = finite.length ? mean(finite.map((point) => point.coordinate)) : 0;
        return (
          <Fragment key={grp.name}>
            {selected.map((si) => {
              const point = finite[si];
              // 确定性水平抖动，使重合观测仍可见，同时不改变纵轴数值。
              const jitter = (((point.index * 37) % 9) - 4) * Math.min(5, gw * 0.035);
              return (
                <circle key={point.index} cx={cx + jitter} cy={Y(point.coordinate)} r={T.r} fill={T.point} stroke={T.bg} strokeWidth={1} opacity={0.82}>
                  <title>{`${grp.name} · ${nf(point.value, 4)}`}</title>
                </circle>
              );
            })}
            {finite.length > 0 && <Ln x1={cx - Math.min(18, gw * 0.18)} y1={Y(mu)} x2={cx + Math.min(18, gw * 0.18)} y2={Y(mu)} stroke={T.center} sw={2.2} />}
            <GroupAxisLabel name={grp.name} x={cx} y={H - 17} width={gw} T={T} />
          </Fragment>
        );
      })}
      <Txt
        x={m.l} y={16}
        s={plotted < total ? `个体值（渲染 ${plotted}/${total} 点，含极值；短横线 = 全量组均值）` : '个体值（短横线 = 组均值）'}
        fill={T.text} size={11} weight={600}
      />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
export const IndividualValuePlot = memo(IndividualValuePlotImpl);


/** 区间图 — 各组均值 ± 95% CI(t 分布),对标 Minitab Interval Plot。 */
function IntervalPlotImpl({ T, groups: allGroups, h, pooledError, groupStart }: {
  T: ChartTokens;
  groups: { name: string; vals: number[] }[];
  h?: number;
  groupStart?: number;
  /** ANOVA 页传入模型的合并误差，使置信区间与方差分析的等方差假设保持一致。 */
  pooledError?: { mse: number; df: number };
}) {
  const W = 960;
  const H = h ?? 320;
  const window = groupedPlotWindow(allGroups, groupStart);
  const groups = window.groups;
  const allValues = groups.flatMap((group) => group.vals).filter(Number.isFinite);
  const axis = createPowerOfTwoAxis(allValues);
  const stats = groups.map((g) => {
    const coordinates = g.vals.filter(Number.isFinite).map(axis.coordinate);
    const n = coordinates.length;
    const mu = n ? mean(coordinates) : Number.NaN;
    const usePooled = pooledError != null && Number.isFinite(pooledError.mse) && pooledError.mse >= 0 && pooledError.df > 0;
    const half = usePooled
      ? axis.scaled
        ? tInv(0.975, pooledError.df) * (Math.sqrt(pooledError.mse) / axis.scale) / Math.sqrt(n)
        : tInv(0.975, pooledError.df) * Math.sqrt(pooledError.mse / n)
      : n > 1 ? tInv(0.975, n - 1) * stdev(coordinates) / Math.sqrt(n) : 0;
    return { name: g.name, mu, lo: mu - half, hi: mu + half, n };
  });
  const intervalCoordinates = stats.flatMap((stat) => [stat.lo, stat.hi]).filter(Number.isFinite);
  const domain = coordinateDomain(axis, intervalCoordinates, {
    padding: 0.15,
    constantHalf: 1,
    extremeConstantRelative: 0.15,
  });
  const yTicks = linearCoordinateTicks(axis, domain, 5);
  // 左槽按最长刻度标签定宽。自审 P1:必须在 lo/hi 已知后**一次算定**——
  // 先定 m 再改写 m.l 会让 pw(const,早已求值)不跟着收窄,绘图区右界冲出 viewBox。
  const m = { t: window.note ? 46 : 26, r: 30, b: 44, l: axisLeft(yTicks.map((tick) => tick.label), 56) };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const Y = (coordinate: number) => projectCoordinate(coordinate, domain, m.t, ph, true);
  const gw = pw / Math.max(1, stats.length);
  const drawableStats = stats.filter((stat) => [stat.mu, stat.lo, stat.hi].every(Number.isFinite));
  return (
    <Svg w={W} h={H} label={window.note ? `均值与 95% 置信区间；${window.note}` : `均值与 95% 置信区间 · ${groupNamesText(groups)}`} readable={!window.note}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {window.note && <Txt x={m.l} y={32} s={window.note} fill={T.text} size={10.5} />}
      {yTicks.map((tick, index) => (
        <Fragment key={'g' + index}>
          <Ln x1={m.l} y1={Y(tick.coordinate)} x2={m.l + pw} y2={Y(tick.coordinate)} stroke={T.grid} sw={1} />
          <Txt x={m.l - 8} y={Y(tick.coordinate)} s={tick.label} fill={T.axis} size={10} anchor="end" />
        </Fragment>
      ))}
      {drawableStats.length > 1 && (
        <polyline
          points={stats.map((stat, index) => Number.isFinite(stat.mu)
            ? `${m.l + index * gw + gw / 2},${Y(stat.mu)}`
            : null).filter(Boolean).join(' ')}
          fill="none" stroke={T.point} strokeWidth={1.4} opacity={0.85}
        />
      )}
      {stats.map((s, i) => {
        const cx = m.l + i * gw + gw / 2;
        const drawable = [s.mu, s.lo, s.hi].every(Number.isFinite);
        return (
          <Fragment key={s.name}>
            {drawable && (
              <>
                <Ln x1={cx} y1={Y(s.hi)} x2={cx} y2={Y(s.lo)} stroke={T.point} sw={2} />
                <Ln x1={cx - 9} y1={Y(s.hi)} x2={cx + 9} y2={Y(s.hi)} stroke={T.point} sw={2} />
                <Ln x1={cx - 9} y1={Y(s.lo)} x2={cx + 9} y2={Y(s.lo)} stroke={T.point} sw={2} />
                <circle cx={cx} cy={Y(s.mu)} r={4.5} fill={T.point} stroke={T.bg} strokeWidth={1.4}>
                  <title>{`${s.name} 均值 ${nf(axis.restore(s.mu), 4)} · 95% CI (${nf(axis.restore(s.lo), 4)}, ${nf(axis.restore(s.hi), 4)}) · n=${s.n}`}</title>
                </circle>
              </>
            )}
            <GroupAxisLabel name={s.name} x={cx} y={H - 24} width={gw} T={T} />
            <Txt x={cx} y={H - 10} s={'n=' + s.n} fill={T.axis} size={9.5} anchor="middle" />
          </Fragment>
        );
      })}
      <Txt x={m.l} y={16} s={pooledError ? `各组均值 ± 95% 置信区间（合并误差 MSE，df=${pooledError.df}）` : '各组均值 ± 95% 置信区间'} fill={T.text} size={11} weight={600} />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
export const IntervalPlot = memo(IntervalPlotImpl);

/** 迷你直方图 — 残差诊断用(无规格/目标线,带 0 参考线)。
 * 批次720-C3:整洁分箱(1-2-5 步长对齐)+频数纵轴刻度与「频率」轴题——此前无纵轴,
 * 横轴为数据极值等分的 3 位小数,工厂对照 Minitab 直方图(频率 0–4/残差 -20..20)判为缺项。 */
function MiniHistImpl({ T, data, h, title, xLabel, xDomain, xTicks }: {
  T: ChartTokens;
  data: number[];
  h?: number;
  /** 图内标题，与横轴语义分离（例：「标准化残差分布」）。 */
  title?: string;
  /** 横轴变量名（例：「标准化残差」）。 */
  xLabel?: string;
  xDomain?: readonly [number, number];
  xTicks?: readonly number[];
}) {
  const W = 960;
  const H = h ?? 240;
  const m = { t: 22, r: 24, b: 44, l: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const finiteData = data.filter(Number.isFinite);
  if (finiteData.length === 0) {
    return (
      <Svg w={W} h={H} readable label={`直方图 · ${title ?? xLabel ?? '残差'}（无有效数据）`}>
        <rect x={0} y={0} width={W} height={H} fill={T.bg} />
        <Txt x={W / 2} y={H / 2} s="无有效数据，无法绘制直方图" fill={T.axis} size={12} anchor="middle" />
      </Svg>
    );
  }
  const axis = createPowerOfTwoAxis([
    ...finiteData,
    ...(xDomain ?? []),
    ...(xTicks ?? []),
  ]);
  const coordinateData = finiteData.map(axis.coordinate);
  const dataDomain = coordinateDomain(axis, coordinateData, {
    padding: 0,
    constantHalf: 1,
    extremeConstantRelative: 0.1,
  });
  const [lo, hi] = dataDomain;
  // 目标箱数取样本量平方根;箱宽吸附 1-2-5 阶梯,箱边界对齐步长整倍数(Minitab 式整洁分箱)
  const nbTarget = Math.max(5, Math.min(15, Math.ceil(Math.sqrt(data.length)) + 2));
  const step0 = (hi - lo) / nbTarget;
  const mag = Math.pow(10, Math.floor(Math.log10(step0 || 1)));
  const norm = step0 / mag;
  const bw = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const suppliedDomainValid = xDomain != null
    && Number.isFinite(xDomain[0]) && Number.isFinite(xDomain[1]) && xDomain[1] > xDomain[0];
  const suppliedCoordinateDomain = suppliedDomainValid
    ? [axis.coordinate(xDomain[0]), axis.coordinate(xDomain[1])] as const
    : null;
  const useSuppliedDomain = suppliedCoordinateDomain != null
    && suppliedCoordinateDomain[1] > suppliedCoordinateDomain[0];
  const binLo = useSuppliedDomain ? suppliedCoordinateDomain[0] : Math.floor(lo / bw) * bw;
  const naturalBinCount = Math.max(1, Math.ceil((hi - binLo) / bw + 1e-9));
  const nb = useSuppliedDomain
    ? Math.max(1, Math.round((suppliedCoordinateDomain[1] - suppliedCoordinateDomain[0]) / bw))
    : naturalBinCount;
  const binHi = useSuppliedDomain ? suppliedCoordinateDomain[1] : binLo + nb * bw;
  const effectiveBw = (binHi - binLo) / nb;
  const counts = new Array(nb).fill(0);
  coordinateData.forEach((coordinate) => {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((coordinate - binLo) / effectiveBw)));
    counts[b]++;
  });
  const maxc = arrMax(counts) || 1;
  const binDomain: readonly [number, number] = [binLo, binHi];
  const X = (coordinate: number) => projectCoordinate(coordinate, binDomain, m.l, pw);
  const Yc = (c: number) => m.t + (1 - c / (maxc * 1.08)) * ph;
  const yStep = Math.max(1, Math.ceil(maxc / 4));
  const yTicks = Array.from({ length: Math.floor(maxc / yStep) + 1 }, (_, i) => i * yStep);
  const requestedTickCoordinates = xTicks?.map(axis.coordinate)
    ?? niceCoordinateTicks(axis, binDomain, 6).map((tick) => tick.coordinate);
  const preparedTicks = coordinateTicks(
    axis,
    requestedTickCoordinates.filter((value) => Number.isFinite(value) && value >= binLo && value <= binHi),
  );
  const axisTicks = preparedTicks.length > 0 ? preparedTicks : niceCoordinateTicks(axis, binDomain, 6);
  const legacyAxisLabel = (xLabel ?? '残差').replace(/分布$/, '');
  const chartTitle = title ?? ((xLabel ?? '残差').endsWith('分布') ? xLabel! : `${xLabel ?? '残差'}分布`);
  return (
    <Svg w={W} h={H} readable label={`直方图 · ${chartTitle}`}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {yTicks.map((c) => (
        <Fragment key={'y' + c}>
          <Ln x1={m.l} y1={Yc(c)} x2={m.l + pw} y2={Yc(c)} stroke={T.grid} sw={1} />
          <Txt x={m.l - 6} y={Yc(c)} s={String(c)} fill={T.axis} size={10} anchor="end" />
        </Fragment>
      ))}
      {counts.map((c, i) => {
        const x0 = X(binLo + i * effectiveBw);
        const bh = (c / (maxc * 1.08)) * ph;
        return <rect key={i} x={x0 + 1} y={m.t + ph - bh} width={pw / nb - 2} height={bh} fill={T.bar} opacity={0.85} stroke={T.classic ? '#2A4B8D' : undefined} strokeWidth={T.classic ? 1 : 0} />;
      })}
      {binLo < 0 && binHi > 0 && <Ln x1={X(0)} y1={m.t} x2={X(0)} y2={m.t + ph} stroke={T.center} sw={1.4} dash="5 4" />}
      {axisTicks.map((tick, index) => (
        <Txt key={'x' + index} x={X(tick.coordinate)} y={H - 24} s={tick.label} fill={T.axis} size={10} anchor="middle" />
      ))}
      <Txt x={m.l} y={m.t - 8} s={chartTitle} fill={T.text} size={11} weight={600} />
      <text x={16} y={m.t + ph / 2} fill={T.text} fontSize={10.5} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontWeight={600}
        transform={`rotate(-90 16 ${m.t + ph / 2})`}>频率</text>
      <Txt x={m.l + pw / 2} y={H - 8} s={legacyAxisLabel} fill={T.text} size={10.5} anchor="middle" weight={600} />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
export const MiniHist = memo(MiniHistImpl);
