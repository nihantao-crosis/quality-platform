/** 每百单位不合格数体系专用 OC 曲线（泊松模型）。 */
import { Fragment } from 'react';
import { ocPa, type SamplingPlan } from '../../core';
import type { ChartTokens } from '../tokens';
import { Ln, Svg, Txt } from './primitives';

export function OcCurvePer100({
  T,
  plan,
  aql,
  rqlLambda,
}: {
  T: ChartTokens;
  plan: SamplingPlan;
  aql: number;
  rqlLambda?: number;
}) {
  const W = 960;
  const H = 330;
  const m = { t: 24, r: 34, b: 50, l: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const lmax = Math.max(aql * 1.6, (rqlLambda ?? aql * 3) * 1.25);
  const X = (lambda: number) => m.l + (lambda / lmax) * pw;
  const Y = (pa: number) => m.t + (1 - pa) * ph;
  const fmtLambda = (lambda: number) => (lmax >= 100 ? lambda.toFixed(0) : lambda.toFixed(1));
  const points = Array.from({ length: 141 }, (_, index) => {
    const lambda = (lmax * index) / 140;
    return `${X(lambda)},${Y(ocPa(plan, lambda, 'per100'))}`;
  });
  const mark = (lambda: number, color: string, label: string) => {
    const pa = ocPa(plan, lambda, 'per100');
    return (
      <Fragment key={label}>
        <Ln x1={X(lambda)} y1={m.t} x2={X(lambda)} y2={m.t + ph} stroke={color} sw={1.3} dash="4 3" />
        <Ln x1={m.l} y1={Y(pa)} x2={X(lambda)} y2={Y(pa)} stroke={color} sw={1.3} dash="4 3" />
        <circle cx={X(lambda)} cy={Y(pa)} r={T.r + 1.5} fill={color} />
        <Txt x={X(lambda) + 6} y={Y(pa) - 9} s={`${label} ${(pa * 100).toFixed(0)}%`} fill={color} size={10.5} weight={700} />
      </Fragment>
    );
  };

  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 6 }, (_, index) => {
        const y = m.t + (index / 5) * ph;
        return (
          <Fragment key={`g${index}`}>
            <Ln x1={m.l} y1={y} x2={m.l + pw} y2={y} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={y} s={`${100 - index * 20}%`} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {Array.from({ length: 7 }, (_, index) => {
        const lambda = (lmax * index) / 6;
        return <Txt key={`x${index}`} x={X(lambda)} y={H - 18} s={fmtLambda(lambda)} fill={T.axis} size={10} anchor="middle" />;
      })}
      <polyline points={points.join(' ')} fill="none" stroke={T.point} strokeWidth={T.sw + 1} />
      {mark(aql, '#1a8a3a', 'AQL')}
      {rqlLambda != null && mark(rqlLambda, T.limit, 'RQL')}
      <Txt x={m.l} y={m.t - 9} s="接收概率 Pa（泊松）" fill={T.text} size={11} weight={600} />
      <Txt x={m.l + pw} y={H - 2} s="每百单位不合格数 λ →" fill={T.axis} size={10} anchor="end" />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
