/**
 * 帕累托图 / 分组柱状图 (Gage) / 箱线图 — 从原型 pareto/groupedBars/boxplot 迁移。
 */
import { Fragment } from 'react';
import { nf, quantile } from '../../core';
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
export function ParetoChart(p: {
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
  const total = rows.reduce((a, r) => a + r.count, 0);
  const maxc = rows[0].count;
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
export function GroupedBars({ T, cats }: { T: ChartTokens; cats: GageBarCat[] }) {
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
export function BoxPlot({ T, groups }: { T: ChartTokens; groups: { name: string; vals: number[] }[] }) {
  const W = 960;
  const H = 320;
  const m = { t: 24, r: 30, b: 44, l: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const allv = groups.flatMap((g) => g.vals);
  let lo = Math.min(...allv);
  let hi = Math.max(...allv);
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
        const mn = Math.min(...grp.vals);
        const mx = Math.max(...grp.vals);
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
