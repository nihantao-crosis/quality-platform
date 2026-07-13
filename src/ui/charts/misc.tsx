/**
 * 帕累托图 / 分组柱状图 (Gage) / 箱线图 — 从原型 pareto/groupedBars/boxplot 迁移。
 */
import { memo, Fragment } from 'react';
import { nf, quantile, arrMin, arrMax, mean, stdev, tInv } from '../../core';
import type { ChartTokens } from '../tokens';
import { paretoColors } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

export interface GageBarCat {
  name: string;
  contrib: number;
  study: number;
  tol: number;
}

// ---------- 帕累托 ----------
function ParetoChartImpl(p: {
  T: ChartTokens;
  rows: { name: string; count: number }[];
  w?: number;
  h?: number;
}) {
  const T = p.T;
  const colors = paretoColors(T);
  const rows = p.rows;
  const W = p.w ?? 960;
  const H = p.h ?? 300;
  const m = { t: 24, r: 52, b: 52, l: 48 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  const maxc = (rows[0]?.count ?? 0) || 1;
  const bw = pw / rows.length;
  const Yc = (c: number) => m.t + (1 - c / (maxc * 1.05)) * ph;
  const Yp = (pc: number) => m.t + (1 - pc / 100) * ph;
  let cum = 0;
  const cumPts: Array<[number, number, number]> = [];
  rows.forEach((r, i) => {
    cum += r.count;
    cumPts.push([m.l + i * bw + bw / 2, Yp((cum / total) * 100), Math.round((cum / total) * 100)]);
  });
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 6} y={yy} s={String(Math.round(maxc * 1.05 - (maxc * 1.05 * g) / 4))} fill={T.axis} size={9} anchor="end" />
            <Txt x={m.l + pw + 6} y={yy} s={100 - (100 * g) / 4 + '%'} fill={T.axis} size={9} />
          </Fragment>
        );
      })}
      {rows.map((r, i) => {
        const x0 = m.l + i * bw + 6;
        const x1 = m.l + (i + 1) * bw - 6;
        return (
          <Fragment key={'b' + i}>
            <rect x={x0} y={Yc(r.count)} width={x1 - x0} height={m.t + ph - Yc(r.count)} fill={colors[i % colors.length]} opacity={0.9} />
            <Txt x={(x0 + x1) / 2} y={Yc(r.count) - 8} s={String(r.count)} fill={T.text} size={10} anchor="middle" weight={600} />
            <Txt x={m.l + i * bw + bw / 2} y={H - 26} s={r.name} fill={T.axis} size={10} anchor="middle" />
          </Fragment>
        );
      })}
      <polyline points={cumPts.map((p) => p[0] + ',' + p[1]).join(' ')} fill="none" stroke={T.curve} strokeWidth={T.sw + 0.4} />
      {cumPts.map((p, i) => (
        <Fragment key={'c' + i}>
          <circle cx={p[0]} cy={p[1]} r={T.r} fill={T.curve} stroke={T.bg} strokeWidth={1.2} />
          <Txt x={p[0]} y={p[1] - 11} s={p[2] + '%'} fill={T.curve} size={9.5} anchor="middle" weight={600} />
        </Fragment>
      ))}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
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
  const Y = (v: number) => m.t + (1 - v / 100) * ph;
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
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 6} y={yy} s={100 - (100 * g) / 4 + '%'} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {cats.map((cat, i) => {
        const gx = m.l + i * gw + gw * 0.14;
        return (
          <Fragment key={'c' + i}>
            {series.map((s, j) => (
              <rect key={s.k} x={gx + j * bw} y={Y(cat[s.k])} width={bw - 3} height={m.t + ph - Y(cat[s.k])} fill={s.c} />
            ))}
            <Txt x={m.l + i * gw + gw / 2} y={H - 30} s={cat.name} fill={T.text} size={10.5} anchor="middle" weight={500} />
          </Fragment>
        );
      })}
      {legendEls}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

// ---------- 箱线图 ----------
function BoxPlotImpl({ T, groups }: { T: ChartTokens; groups: { name: string; vals: number[] }[] }) {
  const W = 960;
  const H = 320;
  const m = { t: 24, r: 30, b: 44, l: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const allv = groups.flatMap((g) => g.vals);
  let lo = arrMin(allv);
  let hi = arrMax(allv);
  const p = (hi - lo) * 0.15;
  lo -= p;
  hi += p;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ph;
  const gw = pw / groups.length;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={nf(hi - ((hi - lo) * g) / 4, 3)} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {groups.map((grp, i) => {
        const cx = m.l + i * gw + gw / 2;
        const bw = gw * 0.32;
        const q1 = quantile(grp.vals, 0.25);
        const q2 = quantile(grp.vals, 0.5);
        const q3 = quantile(grp.vals, 0.75);
        const mn = arrMin(grp.vals);
        const mx = arrMax(grp.vals);
        const mean = grp.vals.reduce((a, b) => a + b, 0) / grp.vals.length;
        return (
          <Fragment key={'b' + i}>
            <Ln x1={cx} y1={Y(mn)} x2={cx} y2={Y(mx)} stroke={T.axis} sw={1.4} />
            <Ln x1={cx - bw * 0.4} y1={Y(mn)} x2={cx + bw * 0.4} y2={Y(mn)} stroke={T.axis} sw={1.4} />
            <Ln x1={cx - bw * 0.4} y1={Y(mx)} x2={cx + bw * 0.4} y2={Y(mx)} stroke={T.axis} sw={1.4} />
            <rect x={cx - bw} y={Y(q3)} width={bw * 2} height={Y(q1) - Y(q3)} fill={T.point} opacity={0.28} stroke={T.point} strokeWidth={1.6} />
            <Ln x1={cx - bw} y1={Y(q2)} x2={cx + bw} y2={Y(q2)} stroke={T.center} sw={2.4} />
            <circle cx={cx} cy={Y(mean)} r={T.r} fill={T.limit} stroke={T.bg} strokeWidth={1.2} />
            <Txt x={cx} y={H - 24} s={grp.name} fill={T.text} size={11} anchor="middle" weight={500} />
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


/** 区间图 — 各组均值 ± 95% CI(t 分布),对标 Minitab Interval Plot。 */
function IntervalPlotImpl({ T, groups, h }: {
  T: ChartTokens;
  groups: { name: string; vals: number[] }[];
  h?: number;
}) {
  const W = 960;
  const H = h ?? 320;
  const m = { t: 26, r: 30, b: 44, l: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const stats = groups.map((g) => {
    const n = g.vals.length;
    const mu = mean(g.vals);
    const half = n > 1 ? tInv(0.975, n - 1) * stdev(g.vals) / Math.sqrt(n) : 0;
    return { name: g.name, mu, lo: mu - half, hi: mu + half, n };
  });
  let lo = arrMin(stats.map((s) => s.lo));
  let hi = arrMax(stats.map((s) => s.hi));
  const pad = (hi - lo) * 0.15 || 1;
  lo -= pad; hi += pad;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ph;
  const gw = pw / stats.length;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={nf(hi - ((hi - lo) * g) / 4, 3)} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {stats.map((s, i) => {
        const cx = m.l + i * gw + gw / 2;
        return (
          <Fragment key={s.name}>
            <Ln x1={cx} y1={Y(s.hi)} x2={cx} y2={Y(s.lo)} stroke={T.point} sw={2} />
            <Ln x1={cx - 9} y1={Y(s.hi)} x2={cx + 9} y2={Y(s.hi)} stroke={T.point} sw={2} />
            <Ln x1={cx - 9} y1={Y(s.lo)} x2={cx + 9} y2={Y(s.lo)} stroke={T.point} sw={2} />
            <circle cx={cx} cy={Y(s.mu)} r={4.5} fill={T.point} stroke={T.bg} strokeWidth={1.4}>
              <title>{`${s.name} 均值 ${nf(s.mu, 4)} · 95% CI (${nf(s.lo, 4)}, ${nf(s.hi, 4)}) · n=${s.n}`}</title>
            </circle>
            <Txt x={cx} y={H - 24} s={s.name} fill={T.text} size={11} anchor="middle" />
            <Txt x={cx} y={H - 10} s={'n=' + s.n} fill={T.axis} size={9.5} anchor="middle" />
          </Fragment>
        );
      })}
      <Txt x={m.l} y={m.t - 10} s="各组均值 ± 95% 置信区间" fill={T.text} size={11} weight={600} />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
export const IntervalPlot = memo(IntervalPlotImpl);

/** 迷你直方图 — 残差诊断用(无规格/目标线,带 0 参考线)。 */
function MiniHistImpl({ T, data, h, xLabel }: { T: ChartTokens; data: number[]; h?: number; xLabel?: string }) {
  const W = 960;
  const H = h ?? 240;
  const m = { t: 22, r: 24, b: 34, l: 46 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  let lo = arrMin(data);
  let hi = arrMax(data);
  if (hi === lo) { lo -= 1; hi += 1; }
  const nb = Math.max(7, Math.min(15, Math.ceil(Math.sqrt(data.length))));
  const bw = (hi - lo) / nb;
  const counts = new Array(nb).fill(0);
  data.forEach((v) => {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / bw)));
    counts[b]++;
  });
  const maxc = arrMax(counts) || 1;
  const X = (v: number) => m.l + ((v - lo) / (hi - lo)) * pw;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {counts.map((c, i) => {
        const x0 = X(lo + i * bw);
        const bh = (c / (maxc * 1.08)) * ph;
        return <rect key={i} x={x0 + 1} y={m.t + ph - bh} width={pw / nb - 2} height={bh} fill={T.bar} opacity={0.85} />;
      })}
      {lo < 0 && hi > 0 && <Ln x1={X(0)} y1={m.t} x2={X(0)} y2={m.t + ph} stroke={T.center} sw={1.4} dash="5 4" />}
      {Array.from({ length: 5 }, (_, i) => {
        const v = lo + ((hi - lo) * i) / 4;
        return <Txt key={'x' + i} x={X(v)} y={H - 10} s={nf(v, 3)} fill={T.axis} size={9.5} anchor="middle" />;
      })}
      <Txt x={m.l} y={m.t - 8} s={xLabel ?? '残差'} fill={T.text} size={11} weight={600} />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
export const MiniHist = memo(MiniHistImpl);
