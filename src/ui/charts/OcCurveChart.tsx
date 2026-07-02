/**
 * OC 特性曲线 — 接收概率 Pa vs 批不良率 p，标注 AQL / RQL 点。
 * 从原型 ocCurve() 迁移。
 */
import { Fragment } from 'react';
import { binomCdf } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

export function OcCurveChart(cfg: {
  T: ChartTokens;
  n: number;
  ac: number;
  pmax?: number;
  aqlP?: number;
  rqlP?: number;
}) {
  const T = cfg.T;
  const { n, ac } = cfg;
  const W = 960;
  const H = 330;
  const m = { t: 24, r: 34, b: 50, l: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const pmax = cfg.pmax ?? 0.12;
  const X = (p: number) => m.l + (p / pmax) * pw;
  const Y = (pa: number) => m.t + (1 - pa) * ph;
  const pts: string[] = [];
  for (let i = 0; i <= 140; i++) {
    const p = (pmax * i) / 140;
    pts.push(X(p) + ',' + Y(binomCdf(ac, n, p)));
  }
  const mark = (p: number, col: string, lab: string) => {
    const pa = binomCdf(ac, n, p);
    return (
      <Fragment key={lab}>
        <Ln x1={X(p)} y1={m.t} x2={X(p)} y2={m.t + ph} stroke={col} sw={1.3} dash="4 3" />
        <Ln x1={m.l} y1={Y(pa)} x2={X(p)} y2={Y(pa)} stroke={col} sw={1.3} dash="4 3" />
        <circle cx={X(p)} cy={Y(pa)} r={T.r + 1.5} fill={col} />
        <Txt x={X(p) + 6} y={Y(pa) - 9} s={lab + ' ' + (pa * 100).toFixed(0) + '%'} fill={col} size={10.5} weight={700} />
      </Fragment>
    );
  };
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 6 }, (_, g) => {
        const yy = m.t + (g / 5) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={100 - g * 20 + '%'} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {Array.from({ length: 7 }, (_, g) => {
        const p = (pmax * g) / 6;
        return <Txt key={'x' + g} x={X(p)} y={H - 18} s={(p * 100).toFixed(1) + '%'} fill={T.axis} size={10} anchor="middle" />;
      })}
      <polyline points={pts.join(' ')} fill="none" stroke={T.point} strokeWidth={T.sw + 1} />
      {cfg.aqlP != null && mark(cfg.aqlP, T.center, 'AQL')}
      {cfg.rqlP != null && mark(cfg.rqlP, T.limit, 'RQL')}
      <Txt x={m.l} y={m.t - 9} s="接收概率 Pa" fill={T.text} size={11} weight={600} />
      <Txt x={m.l + pw} y={H - 2} s="批不良率 p →" fill={T.axis} size={10} anchor="end" />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
