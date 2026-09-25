/**
 * 散点图 — X/Y 观测 + 最小二乘回归线。
 */
import { memo, Fragment } from 'react';
import { arrMax, arrMin, decimateUniform } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';
import {
  coordinateDomain,
  createPowerOfTwoAxis,
  niceCoordinateTicks,
  projectCoordinate,
} from './axisScale';

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
  const points = Array.from({ length: Math.min(xs.length, ys.length) }, (_, index) => ({
    x: xs[index], y: ys[index], sourceIndex: index,
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length === 0) {
    return (
      <Svg w={W} h={H}>
        <rect x={0} y={0} width={W} height={H} fill={T.bg} />
        <Txt x={W / 2} y={H / 2} s="无有效数据，无法绘制散点图" fill={T.axis} size={12} anchor="middle" />
      </Svg>
    );
  }
  const xAxis = createPowerOfTwoAxis(points.map((point) => point.x));
  const yAxis = createPowerOfTwoAxis(points.map((point) => point.y));
  const xCoordinates = points.map((point) => xAxis.coordinate(point.x));
  const yCoordinates = points.map((point) => yAxis.coordinate(point.y));
  const xDomain = coordinateDomain(xAxis, xCoordinates, { padding: 0.08, constantHalf: 1 });
  const yDomain = coordinateDomain(yAxis, yCoordinates, { padding: 0.12, constantHalf: 1 });
  const [xlo, xhi] = xDomain;
  const [ylo, yhi] = yDomain;
  // 极值必留(双审 P3):均匀抽稀会丢掉最大/最小残差点而坐标轴仍按全量拉伸,
  // 读者会以为"没有极端点"。四个方向极值点显式保留
  const xMin = arrMin(xCoordinates);
  const xMax = arrMax(xCoordinates);
  const yMin = arrMin(yCoordinates);
  const yMax = arrMax(yCoordinates);
  const extremes = [
    yCoordinates.indexOf(yMax), yCoordinates.indexOf(yMin),
    xCoordinates.indexOf(xMax), xCoordinates.indexOf(xMin),
  ].filter((k) => k >= 0);
  const idx = decimateUniform(points.length, MAX_RENDER_PTS, extremes);
  const X = (coordinate: number) => projectCoordinate(coordinate, xDomain, m.l, pw);
  const Y = (coordinate: number) => projectCoordinate(coordinate, yDomain, m.t, ph, true);
  // 回归线**真**裁剪到绘图区(蜂群 P3-03:此前只有这句注释,线段直接从 xlo 画到 xhi,
  // Y=[0,0,100] 这类陡斜率会越过底边约 25px 压进 X 轴文字区)。
  // 用 Liang-Barsky 对 y 轴上下界求交,得到落在 [ylo,yhi] 内的 x 区间。
  const coordinateSlope = slope * (xAxis.scale / yAxis.scale);
  const coordinateIntercept = yAxis.coordinate(intercept);
  const yAt = (x: number) => coordinateIntercept + coordinateSlope * x;
  const clippedLine = (() => {
    if (!Number.isFinite(coordinateSlope) || !Number.isFinite(coordinateIntercept)) return null;
    let x1 = xlo;
    let x2 = xhi;
    if (Math.abs(coordinateSlope) > 1e-300) {
      const xAtYlo = (ylo - coordinateIntercept) / coordinateSlope;
      const xAtYhi = (yhi - coordinateIntercept) / coordinateSlope;
      const [xa, xb] = xAtYlo <= xAtYhi ? [xAtYlo, xAtYhi] : [xAtYhi, xAtYlo];
      x1 = Math.max(xlo, xa);
      x2 = Math.min(xhi, xb);
    }
    if (!(x2 > x1) || !Number.isFinite(x1) || !Number.isFinite(x2)) return null; // 完全在窗口外
    const clampY = (v: number) => Math.max(ylo, Math.min(yhi, v));
    return { x1, x2, y1: clampY(yAt(x1)), y2: clampY(yAt(x2)) };
  })();
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {/* 批次720-C3:整洁刻度(1-2-5 阶梯)取代等分刻度。 */}
      {niceCoordinateTicks(yAxis, yDomain, 5).map((tick, index) => (
        <Fragment key={'g' + index}>
          <Ln x1={m.l} y1={Y(tick.coordinate)} x2={m.l + pw} y2={Y(tick.coordinate)} stroke={T.grid} sw={1} />
          <Txt x={m.l - 8} y={Y(tick.coordinate)} s={tick.label} fill={T.axis} size={10} anchor="end" />
        </Fragment>
      ))}
      {niceCoordinateTicks(xAxis, xDomain, 6).map((tick, index) => (
        <Txt key={'x' + index} x={X(tick.coordinate)} y={H - 22} s={tick.label} fill={T.axis} size={10} anchor="middle" />
      ))}
      {clippedLine && (
        <Ln
          x1={X(clippedLine.x1)} y1={Y(clippedLine.y1)}
          x2={X(clippedLine.x2)} y2={Y(clippedLine.y2)}
          stroke={T.center} sw={T.sw + 0.6}
        />
      )}
      {idx.map((i) => (
        <circle key={points[i].sourceIndex} cx={X(xCoordinates[i])} cy={Y(yCoordinates[i])} r={T.r} fill={T.point} stroke={T.bg} strokeWidth={1} opacity={0.85} />
      ))}
      {idx.length < points.length && (
        <Txt x={m.l + pw} y={m.t - 10} s={`渲染 ${idx.length}/${points.length} 点(回归基于全量)`} fill={T.axis} size={9.5} anchor="end" />
      )}
      <Txt x={m.l} y={m.t - 10} s={yLabel} fill={T.text} size={11} weight={600} />
      <Txt x={m.l + pw} y={H - 6} s={xLabel + ' →'} fill={T.axis} size={10.5} anchor="end" />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const ScatterPlot = memo(ScatterPlotImpl);
