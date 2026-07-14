/**
 * 正态概率图 — 中位秩 vs 期望正态分位数，含拟合直线。
 * 数据落在直线附近 → 正态假设成立。
 */
import { memo, Fragment } from 'react';
import { nf, probPlotPoints, mean, stdev, invNorm, decimateUniform } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

const PCT_TICKS = [1, 5, 20, 50, 80, 95, 99];
const MAX_RENDER_PTS = 800;

function NormalProbPlotImpl({ T, data, h }: { T: ChartTokens; data: number[]; h?: number }) {
  const W = 960;
  const H = h ?? 320;
  const m = { t: 22, r: 30, b: 40, l: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  // 残差可能全为 0(完美拟合)。过去 xlo=xhi 会使 SVG 坐标除以 0，
  // 最终向页面输出 NaN。先排除非有限值，并为常数数据建立有限坐标窗口。
  const finiteData = data.filter(Number.isFinite);
  if (finiteData.length === 0) {
    return (
      <Svg w={W} h={H}>
        <rect x={0} y={0} width={W} height={H} fill={T.bg} />
        <Txt x={W / 2} y={H / 2} s="无有效数据，无法绘制正态概率图" fill={T.axis} size={12} anchor="middle" />
      </Svg>
    );
  }
  const pts = probPlotPoints(finiteData);
  const mu = mean(finiteData);
  const rawSd = finiteData.length > 1 ? stdev(finiteData, true) : 0;
  const sd = Number.isFinite(rawSd) ? rawSd : 0;
  const zmax = Math.max(2.6, Math.abs(pts[0].z), Math.abs(pts[pts.length - 1].z)) * 1.08;
  let xlo = Math.min(pts[0].x, mu - zmax * sd);
  let xhi = Math.max(pts[pts.length - 1].x, mu + zmax * sd);
  if (!(xhi > xlo)) {
    const half = Math.max(1, Math.abs(mu) * 0.1);
    xlo = mu - half;
    xhi = mu + half;
  } else {
    const pad = (xhi - xlo) * 0.05;
    xlo -= pad;
    xhi += pad;
  }
  const X = (v: number) => m.l + ((v - xlo) / (xhi - xlo)) * pw;
  const Y = (z: number) => m.t + (1 - (z + zmax) / (2 * zmax)) * ph;
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {PCT_TICKS.map((p) => {
        const z = invNorm(p / 100);
        return (
          <Fragment key={p}>
            <Ln x1={m.l} y1={Y(z)} x2={m.l + pw} y2={Y(z)} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={Y(z)} s={p + '%'} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {Array.from({ length: 6 }, (_, i) => {
        const v = xlo + ((xhi - xlo) * i) / 5;
        return <Txt key={'x' + i} x={X(v)} y={H - 12} s={nf(v, 2)} fill={T.axis} size={10} anchor="middle" />;
      })}
      {/* 拟合直线 x = μ + σz */}
      <Ln x1={X(mu - zmax * sd)} y1={Y(-zmax)} x2={X(mu + zmax * sd)} y2={Y(zmax)} stroke={T.center} sw={T.sw + 0.4} />
      {decimateUniform(pts.length, MAX_RENDER_PTS).map((i) => (
        <circle key={i} cx={X(pts[i].x)} cy={Y(pts[i].z)} r={T.r - 0.6} fill={T.point} stroke={T.bg} strokeWidth={1} opacity={0.85} />
      ))}
      <Txt x={m.l} y={m.t - 8} s="累积概率（正态分位）" fill={T.text} size={11} weight={600} />
      {sd === 0 && <Txt x={m.l + pw} y={m.t - 8} s="数据无变异，正态性不可判定" fill={T.axis} size={10} anchor="end" />}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const NormalProbPlot = memo(NormalProbPlotImpl);
