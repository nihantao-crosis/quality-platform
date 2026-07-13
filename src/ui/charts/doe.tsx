/**
 * DOE 四视图 — 主效应图 / 交互作用图 / 效应帕累托 / 立方图。
 * 从原型 mainEffects/interactionPlot/effectsBar/cubePlot 迁移。
 */
import { memo, Fragment } from 'react';
import { nf } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

// ---------- 主效应图 ----------
function MainEffectsImpl({ T, factors }: { T: ChartTokens; factors: { name: string; lo: number; hi: number }[] }) {
  const W = 960;
  const H = 230;
  const pn = factors.length;
  const pad = 30;
  const gap = 26;
  const panelW = (W - pad * 2 - gap * (pn - 1)) / pn;
  const m = { t: 20, b: 34 };
  const allMeans = factors.flatMap((f) => [f.lo, f.hi]);
  let lo = Math.min(...allMeans);
  let hi = Math.max(...allMeans);
  const p = (hi - lo) * 0.3;
  lo -= p;
  hi += p;
  const ph = H - m.t - m.b;
  const grand = allMeans.reduce((a, b) => a + b, 0) / allMeans.length;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ph;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {factors.map((f, i) => {
        const x0 = pad + i * (panelW + gap);
        const xL = x0 + panelW * 0.25;
        const xH = x0 + panelW * 0.75;
        return (
          <Fragment key={f.name}>
            <Ln x1={x0} y1={Y(grand)} x2={x0 + panelW} y2={Y(grand)} stroke={T.grid} sw={1} dash="4 3" />
            <Ln x1={xL} y1={Y(f.lo)} x2={xH} y2={Y(f.hi)} stroke={T.point} sw={T.sw + 0.6} />
            <circle cx={xL} cy={Y(f.lo)} r={T.r + 0.5} fill={T.point} />
            <circle cx={xH} cy={Y(f.hi)} r={T.r + 0.5} fill={T.point} />
            <Txt x={xL} y={H - 20} s="-1" fill={T.axis} size={10} anchor="middle" />
            <Txt x={xH} y={H - 20} s="+1" fill={T.axis} size={10} anchor="middle" />
            <Txt x={x0 + panelW / 2} y={H - 6} s={f.name} fill={T.text} size={11} anchor="middle" weight={600} />
            <Ln x1={x0} y1={m.t} x2={x0} y2={m.t + ph} stroke={T.axis} sw={1} />
          </Fragment>
        );
      })}
      <Ln x1={0} y1={m.t + ph} x2={W} y2={m.t + ph} stroke={T.grid} sw={1} />
    </Svg>
  );
}

// ---------- 交互作用图 ----------
function InteractionPlotImpl({ T, c00, c10, c01, c11, labelA = 'A', labelB = 'B' }: { T: ChartTokens; c00: number; c10: number; c01: number; c11: number; labelA?: string; labelB?: string }) {
  const W = 960;
  const H = 250;
  const m = { t: 24, r: 120, b: 42, l: 58 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const vals = [c00, c10, c01, c11];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.32;
  lo -= pad;
  hi += pad;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ph;
  const xL = m.l + pw * 0.22;
  const xH = m.l + pw * 0.78;
  const dots: Array<[number, number, string]> = [
    [xL, c00, T.point], [xH, c10, T.point], [xL, c01, T.curve2], [xH, c11, T.curve2],
  ];
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={nf(hi - ((hi - lo) * g) / 4, 1)} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      <polyline points={`${xL},${Y(c00)} ${xH},${Y(c10)}`} fill="none" stroke={T.point} strokeWidth={T.sw + 0.8} />
      <polyline points={`${xL},${Y(c01)} ${xH},${Y(c11)}`} fill="none" stroke={T.curve2} strokeWidth={T.sw + 0.8} strokeDasharray={T.dash} />
      {dots.map(([x, v, c], i) => (
        <circle key={i} cx={x} cy={Y(v)} r={T.r + 1} fill={c} />
      ))}
      <Txt x={xL} y={H - 18} s={`${labelA} 低 (−1)`} fill={T.axis} size={10.5} anchor="middle" />
      <Txt x={xH} y={H - 18} s={`${labelA} 高 (+1)`} fill={T.axis} size={10.5} anchor="middle" />
      <Txt x={m.l + pw + 10} y={Y(c10)} s={`${labelB} 低`} fill={T.point} size={11} weight={600} />
      <Txt x={m.l + pw + 10} y={Y(c11)} s={`${labelB} 高`} fill={T.curve2} size={11} weight={600} />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

// ---------- 效应帕累托（Lenth 显著界限） ----------
function EffectsBarImpl({ T, terms, refLine }: { T: ChartTokens; terms: { name: string; abs: number }[]; refLine: number }) {
  const W = 960;
  const H = 290;
  const m = { t: 26, r: 40, b: 26, l: 88 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const maxv = Math.max(refLine, ...terms.map((t) => t.abs)) * 1.12;
  const X = (v: number) => m.l + (v / maxv) * pw;
  const bh = (ph / terms.length) * 0.6;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {terms.map((t, i) => {
        const y = m.t + ((i + 0.5) * ph) / terms.length;
        const sig = t.abs >= refLine;
        return (
          <Fragment key={t.name}>
            <rect x={m.l} y={y - bh / 2} width={Math.max(1, X(t.abs) - m.l)} height={bh} fill={sig ? T.point : T.bar3} />
            <Txt x={m.l - 8} y={y} s={t.name} fill={T.text} size={11.5} anchor="end" weight={600} />
            <Txt x={X(t.abs) + 6} y={y} s={nf(t.abs, 2)} fill={T.axis} size={10.5} />
          </Fragment>
        );
      })}
      <Ln x1={X(refLine)} y1={m.t - 4} x2={X(refLine)} y2={m.t + ph} stroke={T.limit} sw={1.8} dash="6 3" />
      <Txt x={X(refLine)} y={m.t - 10} s={'显著界限 ' + nf(refLine, 2)} fill={T.limit} size={10.5} anchor="middle" weight={700} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

// ---------- 立方图 ----------
function CubePlotImpl({ T, y, labels = ['A 温度', 'B 压力', 'C 时间'] }: { T: ChartTokens; y: (a: number, b: number, c: number) => number; labels?: [string, string, string] }) {
  const W = 960;
  const H = 360;
  const s = 210;
  const dx = 150;
  const dy = -95;
  const ox = 210;
  const oy = 250;
  const P = (a: number, b: number, c: number): [number, number] => [ox + a * s + c * dx, oy - b * s + c * dy];
  const edges: Array<{ p: [number, number]; q: [number, number]; front?: boolean }> = [];
  // 后面 c=1
  edges.push({ p: P(0, 0, 1), q: P(1, 0, 1) }, { p: P(1, 0, 1), q: P(1, 1, 1) }, { p: P(1, 1, 1), q: P(0, 1, 1) }, { p: P(0, 1, 1), q: P(0, 0, 1) });
  // 竖边
  ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).forEach(([a, b]) => edges.push({ p: P(a, b, 0), q: P(a, b, 1) }));
  // 前面 c=0
  edges.push(
    { p: P(0, 0, 0), q: P(1, 0, 0), front: true },
    { p: P(1, 0, 0), q: P(1, 1, 0), front: true },
    { p: P(1, 1, 0), q: P(0, 1, 0), front: true },
    { p: P(0, 1, 0), q: P(0, 0, 0), front: true },
  );
  const verts: Array<{ p: [number, number]; val: number }> = [];
  for (let c = 0; c < 2; c++)
    for (let b = 0; b < 2; b++)
      for (let a = 0; a < 2; a++) verts.push({ p: P(a, b, c), val: y(a, b, c) });
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {edges.map((e, i) => (
        <Ln key={i} x1={e.p[0]} y1={e.p[1]} x2={e.q[0]} y2={e.q[1]} stroke={e.front ? T.text : T.axis} sw={1.4} dash={e.front ? undefined : '3 3'} />
      ))}
      {verts.map((v, i) => (
        <Fragment key={i}>
          <circle cx={v.p[0]} cy={v.p[1]} r={16} fill={T.bg} stroke={T.point} strokeWidth={1.8} />
          <Txt x={v.p[0]} y={v.p[1]} s={Number.isFinite(v.val) ? nf(v.val, 1) : '—'} fill={T.point} size={12} anchor="middle" weight={700} />
        </Fragment>
      ))}
      <Txt x={ox + s / 2} y={oy + 30} s={`${labels[0]} →`} fill={T.axis} size={11} anchor="middle" weight={600} />
      <Txt x={ox - 42} y={oy - s / 2} s={`${labels[1]} ↑`} fill={T.axis} size={11} anchor="middle" weight={600} />
      <Txt x={ox + s + dx / 2 + 20} y={oy + dy / 2 + 8} s={`${labels[2]} ↗`} fill={T.axis} size={11} anchor="middle" weight={600} />
    </Svg>
  );
}

export const MainEffects = memo(MainEffectsImpl);

export const InteractionPlot = memo(InteractionPlotImpl);

export const EffectsBar = memo(EffectsBarImpl);

export const CubePlot = memo(CubePlotImpl);
