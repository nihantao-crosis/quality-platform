/**
 * 正态概率图 — 中位秩 vs 期望正态分位数，含拟合直线。
 * 数据落在直线附近 → 正态假设成立。
 */
import { memo, Fragment } from 'react';
import { probPlotPoints, mean, stdev, invNorm, decimateUniform, arrMin, arrMax } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';
import {
  coordinateDomain,
  coordinateTicks,
  createPowerOfTwoAxis,
  niceCoordinateTicks,
  projectCoordinate,
  type PowerOfTwoAxis,
} from './axisScale';

const PCT_TICKS = [1, 5, 20, 50, 80, 95, 99];
const MAX_RENDER_PTS = 800;

export interface NumericAxisScale {
  domain: readonly [number, number];
  ticks: readonly number[];
}

function residualCoordinateScale(data: readonly number[], axis: PowerOfTwoAxis): NumericAxisScale {
  const coordinates = data.filter(Number.isFinite).map(axis.coordinate);
  if (coordinates.length === 0) return { domain: [-1, 1], ticks: [-1, 0, 1] };
  let lo = arrMin(coordinates);
  let hi = arrMax(coordinates);
  if (!(hi > lo)) {
    [lo, hi] = coordinateDomain(axis, coordinates, {
      padding: 0,
      constantHalf: 1,
      constantRelative: 0.1,
      extremeConstantRelative: 0.1,
    });
  }
  const targetBins = Math.max(5, Math.min(15, Math.ceil(Math.sqrt(coordinates.length)) + 2));
  const step0 = (hi - lo) / targetBins;
  const mag = Math.pow(10, Math.floor(Math.log10(step0 || 1)));
  const norm = step0 / mag;
  const binWidth = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  let axisLo = Math.floor(lo / binWidth) * binWidth;
  let axisHi = Math.ceil(hi / binWidth - 1e-9) * binWidth;
  if (!(axisHi > axisLo)) axisHi = axisLo + binWidth;
  // Floating addition can produce -0 or a tiny tail; normalise only axis values.
  axisLo = Math.abs(axisLo) < binWidth * 1e-12 ? 0 : axisLo;
  axisHi = Math.abs(axisHi) < binWidth * 1e-12 ? 0 : axisHi;
  const domain: readonly [number, number] = [axisLo, axisHi];
  return { domain, ticks: niceCoordinateTicks(axis, domain, 6).map((tick) => tick.coordinate) };
}

/**
 * DOE 残差四联图的共享横轴。域边界同直方图的 1-2-5 整洁分箱对齐，
 * 因此正态概率图和直方图能够使用完全相同的 x-domain / x ticks。
 * 常数、单点和非有限输入均返回可绘制的有限坐标系。
 */
export function residualAxisScale(data: readonly number[]): NumericAxisScale {
  const finite = data.filter(Number.isFinite);
  if (finite.length === 0) return { domain: [-1, 1], ticks: [-1, 0, 1] };
  const axis = createPowerOfTwoAxis(finite);
  const coordinateScale = residualCoordinateScale(finite, axis);
  const restoredDomain = coordinateScale.domain.map(axis.restore) as [number, number];
  const restoredTicks = coordinateTicks(axis, coordinateScale.ticks).map((tick) => tick.value);
  return { domain: restoredDomain, ticks: restoredTicks };
}

interface NormalProbPlotProps {
  T: ChartTokens;
  data: number[];
  h?: number;
  xLabel?: string;
  xDomain?: readonly [number, number];
  xTicks?: readonly number[];
}

function NormalProbPlotImpl({ T, data, h, xLabel, xDomain, xTicks }: NormalProbPlotProps) {
  const W = 960;
  const H = h ?? 320;
  const m = { t: 22, r: 30, b: 44, l: 60 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  // 残差可能全为 0(完美拟合)。过去 xlo=xhi 会使 SVG 坐标除以 0，
  // 最终向页面输出 NaN。先排除非有限值，并为常数数据建立有限坐标窗口。
  const finiteData = data.filter(Number.isFinite);
  if (finiteData.length === 0) {
    return (
      <Svg w={W} h={H} label="正态概率图">
        <rect x={0} y={0} width={W} height={H} fill={T.bg} />
        <Txt x={W / 2} y={H / 2} s="无有效数据，无法绘制正态概率图" fill={T.axis} size={12} anchor="middle" />
      </Svg>
    );
  }
  // Values, domain, padding, ticks and point projection all share one power-of-two
  // coordinate.  For ordinary input the scale is exactly 1, preserving the old path.
  const axis = createPowerOfTwoAxis([
    ...finiteData,
    ...(xDomain ?? []),
    ...(xTicks ?? []),
  ]);
  const coordinateData = finiteData.map(axis.coordinate);
  const pts = probPlotPoints(coordinateData);
  const mu = mean(coordinateData);
  const rawSd = coordinateData.length > 1 ? stdev(coordinateData, true) : 0;
  const sd = Number.isFinite(rawSd) ? rawSd : 0;
  const zmax = Math.max(2.6, Math.abs(pts[0].z), Math.abs(pts[pts.length - 1].z)) * 1.08;
  const fallbackScale = residualCoordinateScale(finiteData, axis);
  const suppliedDomainValid = xDomain != null
    && Number.isFinite(xDomain[0]) && Number.isFinite(xDomain[1]) && xDomain[1] > xDomain[0];
  const suppliedDomain = suppliedDomainValid
    ? [axis.coordinate(xDomain[0]), axis.coordinate(xDomain[1])] as const
    : null;
  const domain = suppliedDomain != null && suppliedDomain[1] > suppliedDomain[0]
    ? suppliedDomain
    : fallbackScale.domain;
  const [xlo, xhi] = domain;
  const suppliedTickCoordinates = xTicks?.map(axis.coordinate) ?? fallbackScale.ticks;
  const preparedTicks = coordinateTicks(
    axis,
    suppliedTickCoordinates.filter((value) => Number.isFinite(value) && value >= xlo && value <= xhi),
  );
  const axisTicks = preparedTicks.length > 0 ? preparedTicks : niceCoordinateTicks(axis, domain, 6);
  const X = (v: number) => projectCoordinate(v, domain, m.l, pw);
  const Y = (z: number) => m.t + (1 - (z + zmax) / (2 * zmax)) * ph;
  return (
    <Svg w={W} h={H} label="正态概率图">
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
      {axisTicks.map((tick, index) => (
        <Txt key={'x' + index} x={X(tick.coordinate)} y={H - 24} s={tick.label} fill={T.axis} size={10} anchor="middle" />
      ))}
      {/* 拟合直线 x = μ + σz,裁剪到 x 域内(σ=0 时退化为竖直参考,跳过) */}
      {sd > 0 && (() => {
        const x1 = Math.max(xlo, mu - zmax * sd);
        const x2 = Math.min(xhi, mu + zmax * sd);
        return <Ln x1={X(x1)} y1={Y((x1 - mu) / sd)} x2={X(x2)} y2={Y((x2 - mu) / sd)} stroke={T.center} sw={T.sw + 0.4} />;
      })()}
      {decimateUniform(pts.length, MAX_RENDER_PTS).map((i) => (
        <circle key={i} cx={X(pts[i].x)} cy={Y(pts[i].z)} r={T.r - 0.6} fill={T.point} stroke={T.bg} strokeWidth={1} opacity={0.85} />
      ))}
      <Txt x={m.l} y={m.t - 8} s="累积概率（正态分位）" fill={T.text} size={11} weight={600} />
      <text x={16} y={m.t + ph / 2} fill={T.text} fontSize={10.5} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontWeight={600}
        transform={`rotate(-90 16 ${m.t + ph / 2})`}>百分比</text>
      <Txt x={m.l + pw / 2} y={H - 8} s={xLabel ?? '数据'} fill={T.text} size={10.5} anchor="middle" weight={600} />
      {sd === 0 && <Txt x={m.l + pw} y={m.t - 8} s="数据无变异，正态性不可判定" fill={T.axis} size={10} anchor="end" />}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const NormalProbPlot = memo(NormalProbPlotImpl);
