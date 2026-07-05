/**
 * 过程能力直方图 — 13 柱 + 组内正态曲线（实线）+ 整体正态曲线（虚线）+ 规格线。
 * 从原型 histogram() 迁移。
 */
import { memo, Fragment } from 'react';
import { nf } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

export interface HistogramProps {
  T: ChartTokens;
  data: number[];
  mu: number;
  sigmaWithin: number;
  sigmaOverall: number;
  lsl: number | null;
  usl: number | null;
  tgt: number;
  h?: number;
  bins?: number; // 组数,默认 13(原型值)
}

function HistogramImpl(p: HistogramProps) {
  const T = p.T;
  const W = 960;
  const H = p.h ?? 320;
  const m = { t: 22, r: 26, b: 42, l: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const data = p.data;
  let lo = Math.min(p.lsl ?? Infinity, ...data);
  let hi = Math.max(p.usl ?? -Infinity, ...data);
  const sp = (hi - lo) * 0.08;
  lo -= sp;
  hi += sp;
  const nb = Math.max(5, Math.min(40, p.bins ?? 13));
  const bw = (hi - lo) / nb;
  const counts = new Array(nb).fill(0);
  data.forEach((v) => {
    let b = Math.floor((v - lo) / bw);
    if (b < 0) b = 0;
    if (b >= nb) b = nb - 1;
    counts[b]++;
  });
  const maxc = Math.max(...counts);
  const pdf = (x: number, mu: number, sd: number) =>
    Math.exp(-((x - mu) ** 2) / (2 * sd * sd)) / (sd * Math.sqrt(2 * Math.PI));
  const curveMax = pdf(p.mu, p.mu, p.sigmaWithin) * data.length * bw;
  const ytop = Math.max(maxc, curveMax) * 1.12;
  const X = (v: number) => m.l + ((v - lo) / (hi - lo)) * pw;
  const Y = (c: number) => m.t + (1 - c / ytop) * ph;
  const curvePts = (sd: number, mu: number) => {
    const a: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const x = lo + ((hi - lo) * i) / 80;
      a.push(`${X(x)},${Y(pdf(x, mu, sd) * data.length * bw)}`);
    }
    return a.join(' ');
  };
  const specs: Array<[string, number]> = [
    ...(p.lsl != null ? ([['LSL', p.lsl]] as Array<[string, number]>) : []),
    ['目标', p.tgt],
    ...(p.usl != null ? ([['USL', p.usl]] as Array<[string, number]>) : []),
  ];
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={String(Math.round(ytop - (ytop * g) / 4))} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {counts.map((c, i) => {
        const x0 = X(lo + i * bw) + 1.5;
        const x1 = X(lo + (i + 1) * bw) - 1.5;
        return <rect key={'b' + i} x={x0} y={Y(c)} width={Math.max(1, x1 - x0)} height={m.t + ph - Y(c)} fill={T.bar} opacity={0.82} />;
      })}
      <polyline points={curvePts(p.sigmaWithin, p.mu)} fill="none" stroke={T.curve} strokeWidth={T.sw + 0.4} />
      <polyline points={curvePts(p.sigmaOverall, p.mu)} fill="none" stroke={T.curve2} strokeWidth={T.sw + 0.2} strokeDasharray={T.dash} />
      {specs.map(([lab, v]) => (
        <Fragment key={lab}>
          <Ln x1={X(v)} y1={m.t - 4} x2={X(v)} y2={m.t + ph} stroke="#c026a6" sw={T.sw} dash={lab === '目标' ? '2 3' : undefined} />
          <Txt x={X(v)} y={m.t - 10} s={lab} fill="#c026a6" size={10} anchor="middle" weight={600} />
        </Fragment>
      ))}
      {Array.from({ length: 6 }, (_, i) => {
        const v = lo + ((hi - lo) * i) / 5;
        return <Txt key={'t' + i} x={X(v)} y={H - 14} s={nf(v, 2)} fill={T.axis} size={10} anchor="middle" />;
      })}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const Histogram = memo(HistogramImpl);
