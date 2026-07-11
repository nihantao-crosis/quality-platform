/**
 * 散点图 — X/Y 观测 + 最小二乘回归线。
 */
import { memo, Fragment } from 'react';
import { nf, arrMin, arrMax, decimateUniform } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

const MAX_RENDER_PTS = 1000;

function ScatterPlotImpl({ T, xs, ys, slope, intercept, xLabel, yLabel, h }: {
  T: ChartTokens; xs: number[]; ys: number[];
  slope: number; intercept: number;
  xLabel: string; yLabel: string; h?: number;
}) {
  const W = 960;
  const H = h ?? 320;
  const m = { t: 26, r: 30, b: 46, l: 62 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  let xlo = arrMin(xs);
  let xhi = arrMax(xs);
  let ylo = arrMin(ys);
  let yhi = arrMax(ys);
  const idx = decimateUniform(xs.length, MAX_RENDER_PTS);
  const px = (xhi - xlo) * 0.08 || 1;
  const py = (yhi - ylo) * 0.12 || 1;
  xlo -= px; xhi += px; ylo -= py; yhi += py;
  const X = (v: number) => m.l + ((v - xlo) / (xhi - xlo)) * pw;
  const Y = (v: number) => m.t + (1 - (v - ylo) / (yhi - ylo)) * ph;
  // 回归线裁剪到绘图区
  const yAt = (x: number) => intercept + slope * x;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={nf(yhi - ((yhi - ylo) * g) / 4, 3)} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {Array.from({ length: 6 }, (_, i) => {
        const v = xlo + ((xhi - xlo) * i) / 5;
        return <Txt key={'x' + i} x={X(v)} y={H - 22} s={nf(v, 3)} fill={T.axis} size={10} anchor="middle" />;
      })}
      <Ln x1={X(xlo)} y1={Y(yAt(xlo))} x2={X(xhi)} y2={Y(yAt(xhi))} stroke={T.center} sw={T.sw + 0.6} />
      {idx.map((i) => (
        <circle key={i} cx={X(xs[i])} cy={Y(ys[i])} r={T.r} fill={T.point} stroke={T.bg} strokeWidth={1} opacity={0.85} />
      ))}
      {idx.length < xs.length && (
        <Txt x={m.l + pw} y={m.t - 10} s={`渲染 ${idx.length}/${xs.length} 点(回归基于全量)`} fill={T.axis} size={9.5} anchor="end" />
      )}
      <Txt x={m.l} y={m.t - 10} s={yLabel} fill={T.text} size={11} weight={600} />
      <Txt x={m.l + pw} y={H - 6} s={xLabel + ' →'} fill={T.axis} size={10.5} anchor="end" />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const ScatterPlot = memo(ScatterPlotImpl);
