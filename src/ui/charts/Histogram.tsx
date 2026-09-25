/**
 * 过程能力直方图 — 13 柱 + 组内正态曲线（实线）+ 整体正态曲线（虚线）+ 规格线。
 * 从原型 histogram() 迁移。
 */
import { memo, Fragment } from 'react';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';
import {
  coordinateDomain,
  createPowerOfTwoAxis,
  niceCoordinateTicks,
  projectCoordinate,
} from './axisScale';

export interface HistogramProps {
  T: ChartTokens;
  data: number[];
  mu: number;
  sigmaWithin: number;
  sigmaOverall: number;
  lsl: number | null;
  usl: number | null;
  tgt: number;
  /** 目标线标签(默认「目标」);描述统计页把均值画在此位置时须改标「均值」,不得冒充规格目标 */
  tgtLabel?: string;
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
  const data = p.data.filter(Number.isFinite);
  if (data.length === 0) return null;
  const sourceAxisValues = [
    ...data,
    p.mu,
    p.tgt,
    ...(p.lsl == null ? [] : [p.lsl]),
    ...(p.usl == null ? [] : [p.usl]),
  ];
  const axis = createPowerOfTwoAxis(sourceAxisValues);
  const coordinateData = data.map(axis.coordinate);
  const relevantCoordinates = sourceAxisValues.map(axis.coordinate);
  // 数据、分箱、规格线和刻度始终共用一个二次幂坐标域。普通量程 scale=1，
  // 保留原有 8% padding/常量列 5% 口径；±MAX 不再因 hi-lo 溢出而全投影到左边。
  const domain = coordinateDomain(axis, relevantCoordinates, {
    padding: 0.08,
    constantHalf: 1,
    constantRelative: 0.05,
    extremeConstantRelative: 0.05,
  });
  const [lo, hi] = domain;
  const span = hi - lo;
  const nb = Math.max(5, Math.min(40, p.bins ?? 13));
  const bw = span / nb;
  const counts = new Array(nb).fill(0);
  coordinateData.forEach((v) => {
    let b = Math.floor((v - lo) / bw);
    if (b < 0) b = 0;
    if (b >= nb) b = nb - 1;
    counts[b]++;
  });
  const maxc = Math.max(...counts);
  const pdf = (x: number, mu: number, sd: number) => {
    // 复审 P2:σ 为次正规时 2σ² 下溢为 0,x==mu 处 0/0 → NaN,整条曲线的 y 全变 NaN。
    // 必须判方差而非只判 σ;结果非有限时按 0 处理。
    const variance2 = 2 * sd * sd;
    if (!(sd > 0) || !Number.isFinite(sd) || !(variance2 > 0)) return 0;
    const y = Math.exp(-((x - mu) ** 2) / variance2) / (sd * Math.sqrt(2 * Math.PI));
    return Number.isFinite(y) ? y : 0;
  };
  const muCoordinate = axis.coordinate(p.mu);
  const withinSigmaCoordinate = p.sigmaWithin / axis.scale;
  const overallSigmaCoordinate = p.sigmaOverall / axis.scale;
  const rawCurveMax = pdf(muCoordinate, muCoordinate, withinSigmaCoordinate) * data.length * bw;
  // 复审 P2:次正规 σ 会让 1/(σ√2π) 溢出为 Infinity,ytop 变 Infinity → 全部柱子 y/height = NaN。
  // 密度峰非有限时退回按频数定轴(曲线本身另有有限性过滤)。
  const curveMax = Number.isFinite(rawCurveMax) ? rawCurveMax : 0;
  const ytop = Math.max(1, maxc, curveMax) * 1.12;
  const X = (coordinate: number) => projectCoordinate(
    Math.max(lo, Math.min(hi, coordinate)),
    domain,
    m.l,
    pw,
  );
  const Y = (c: number) => m.t + (1 - c / ytop) * ph;
  const curvePts = (sd: number, mu: number) => {
    const a: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const x = lo + (span * i) / 80;
      const px = X(x);
      const py = Y(pdf(x, mu, sd) * data.length * bw);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue; // 非有限点不进 polyline
      a.push(`${px},${py}`);
    }
    return a.join(' ');
  };
  const specs: Array<[string, number]> = [
    ...(p.lsl != null ? ([['LSL', p.lsl]] as Array<[string, number]>) : []),
    [p.tgtLabel ?? '目标', p.tgt],
    ...(p.usl != null ? ([['USL', p.usl]] as Array<[string, number]>) : []),
  ];
  return (
    <Svg w={W} h={H} label="直方图与正态曲线">
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
      {p.sigmaWithin > 0 && Number.isFinite(p.sigmaWithin) && <polyline points={curvePts(withinSigmaCoordinate, muCoordinate)} fill="none" stroke={T.curve} strokeWidth={T.sw + 0.4} />}
      {p.sigmaOverall > 0 && Number.isFinite(p.sigmaOverall) && <polyline points={curvePts(overallSigmaCoordinate, muCoordinate)} fill="none" stroke={T.curve2} strokeWidth={T.sw + 0.2} strokeDasharray={T.dash} />}
      {specs.map(([lab, v]) => (
        <Fragment key={lab}>
          <Ln x1={X(axis.coordinate(v))} y1={m.t - 4} x2={X(axis.coordinate(v))} y2={m.t + ph} stroke="#c026a6" sw={T.sw} dash={lab === '目标' ? '2 3' : undefined} />
          <Txt x={X(axis.coordinate(v))} y={m.t - 10} s={lab} fill="#c026a6" size={10} anchor="middle" weight={600} />
        </Fragment>
      ))}
      {(() => {
        // 第三轮 P3:小数位随量程取(硬编码 2 位在小量程下出现连续重复刻度)。
        // 复审 P2:此前直接对 6 个等分点取 tickDecimals,步长与「好看的刻度」不一致,
        // 标签最多错半格还会印出「-0」——改与其余 5 处图表同口径:先 niceTicks 再定位数。
        const ticks = niceCoordinateTicks(axis, domain, 8); // 自审 P3:6 个目标经圆整后常只剩 3~4 个
        return ticks.map((tick, i) => (
          <Txt key={'t' + i} x={X(tick.coordinate)} y={H - 14} s={tick.label} fill={T.axis} size={10} anchor="middle" />
        ));
      })()}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const Histogram = memo(HistogramImpl);
