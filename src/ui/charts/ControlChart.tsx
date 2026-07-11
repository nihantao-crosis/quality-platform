/**
 * 控制图（交互点选）— 从原型 controlChart() 迁移。
 * 中心线/UCL/LCL/σ 分区/失控点高亮/选中描边圈/点击回调。
 */
import { memo, Fragment } from 'react';
import { nf, arrMin, arrMax, decimateMinMax } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

/** 超过该点数即降采样渲染(统计/判异仍基于全量数据) */
const MAX_RENDER_PTS = 600;

export interface ControlChartProps {
  T: ChartTokens;
  data: number[];
  cl: number;
  ucl: number;
  lcl: number;
  clLabel?: string;
  dec?: number;
  h?: number;
  zones?: boolean;
  violations?: Set<number>;
  sel?: number | null;
  onPoint?: (i: number) => void;
  ptLabel?: (i: number) => string;
  /** 时变控制限（EWMA/分阶段）：提供时覆盖水平 UCL/LCL 直线 */
  uclSeries?: number[];
  lclSeries?: number[];
  /** 分段中心线（分阶段）与段边界(索引)、段标签 */
  clSeries?: number[];
  /** series 以阶梯(step)方式渲染——分阶段限值用;EWMA 等连续限值保持平滑 */
  stepSeries?: boolean;
  stageBoundaries?: number[];
  stageLabels?: { at: number; label: string }[];
  /** 第二序列（CUSUM 的 C⁻，用 curve2 色绘制） */
  series2?: number[];
  series2Label?: string;
}

function ControlChartImpl(cfg: ControlChartProps) {
  const T = cfg.T;
  const W = 960;
  const H = cfg.h ?? 260;
  const m = { t: 24, r: 104, b: 30, l: 60 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const data = cfg.data;
  const dec = cfg.dec ?? 3;
  const sigma = (cfg.ucl - cfg.cl) / 3;
  // 大数组安全的 y 轴范围(Math.min(...) 十万级会栈溢出)
  let ymin = Math.min(arrMin(data), cfg.lcl, cfg.cl);
  let ymax = Math.max(arrMax(data), cfg.ucl, cfg.cl);
  for (const s of [cfg.uclSeries, cfg.lclSeries, cfg.clSeries, cfg.series2]) {
    if (s) { ymin = Math.min(ymin, arrMin(s)); ymax = Math.max(ymax, arrMax(s)); }
  }
  const pad = (ymax - ymin) * 0.18 || 1;
  ymin -= pad;
  ymax += pad;
  const X = (i: number) => m.l + (data.length > 1 ? i / (data.length - 1) : 0.5) * pw;
  const Y = (v: number) => m.t + (1 - (v - ymin) / (ymax - ymin)) * ph;
  const viol =
    cfg.violations ??
    new Set(data.map((v, i) => (v > cfg.ucl || v < cfg.lcl ? i : -1)).filter((i) => i >= 0));
  const label = (i: number) => (cfg.ptLabel ? cfg.ptLabel(i) : `点 ${i + 1}`);
  // 渲染降采样:失控点/选中点/段边界必留,min-max 分桶保形;统计与判异均基于全量
  const keep = [...viol, ...(cfg.sel != null ? [cfg.sel] : []), ...(cfg.stageBoundaries ?? []).flatMap((b) => [b - 1, b])];
  const idx = decimateMinMax(data, MAX_RENDER_PTS, keep);
  const sampled = idx.length < data.length;
  // 序列折线:step 模式在值跳变处插入垂直拐点(段边界中点)
  const seriesPts = (series: number[]) => {
    if (!cfg.stepSeries) return idx.map((i) => `${X(i)},${Y(series[i])}`).join(' ');
    const pts: string[] = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const prev = k > 0 ? idx[k - 1] : -1;
      if (prev >= 0 && series[i] !== series[prev]) {
        const mid = (X(i) + X(prev)) / 2;
        pts.push(`${mid},${Y(series[prev])}`, `${mid},${Y(series[i])}`);
      }
      pts.push(`${X(i)},${Y(series[i])}`);
    }
    return pts.join(' ');
  };
  // 自适应 X 轴刻度密度(全量时保持原每 5 点一签)
  const lblStep = Math.max(5, Math.ceil(data.length / 60) * 5);

  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 5 }, (_, g) => {
        const yy = m.t + (g / 4) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={nf(ymax - ((ymax - ymin) * g) / 4, dec)} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {cfg.zones &&
        [1, 2].map((z) => (
          <Fragment key={'z' + z}>
            {Y(cfg.cl + z * sigma) > m.t && (
              <Ln x1={m.l} y1={Y(cfg.cl + z * sigma)} x2={m.l + pw} y2={Y(cfg.cl + z * sigma)} stroke={T.grid} sw={1} dash="2 4" />
            )}
            {Y(cfg.cl - z * sigma) < m.t + ph && (
              <Ln x1={m.l} y1={Y(cfg.cl - z * sigma)} x2={m.l + pw} y2={Y(cfg.cl - z * sigma)} stroke={T.grid} sw={1} dash="2 4" />
            )}
          </Fragment>
        ))}
      {cfg.uclSeries ? (
        <>
          <polyline points={seriesPts(cfg.uclSeries)} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.dash} />
          <polyline points={seriesPts(cfg.lclSeries ?? [])} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.dash} />
          <Txt x={m.l + pw + 8} y={Y(cfg.uclSeries[cfg.uclSeries.length - 1])} s={'UCL ' + nf(cfg.uclSeries[cfg.uclSeries.length - 1], dec)} fill={T.limit} size={10} weight={600} />
          {cfg.lclSeries && (
            <Txt x={m.l + pw + 8} y={Y(cfg.lclSeries[cfg.lclSeries.length - 1])} s={'LCL ' + nf(cfg.lclSeries[cfg.lclSeries.length - 1], dec)} fill={T.limit} size={10} weight={600} />
          )}
        </>
      ) : (
        <>
          <Ln x1={m.l} y1={Y(cfg.ucl)} x2={m.l + pw} y2={Y(cfg.ucl)} stroke={T.limit} sw={T.sw} dash={T.dash} />
          <Ln x1={m.l} y1={Y(cfg.lcl)} x2={m.l + pw} y2={Y(cfg.lcl)} stroke={T.limit} sw={T.sw} dash={T.dash} />
          <Txt x={m.l + pw + 8} y={Y(cfg.ucl)} s={'UCL ' + nf(cfg.ucl, dec)} fill={T.limit} size={10} weight={600} />
          <Txt x={m.l + pw + 8} y={Y(cfg.lcl)} s={'LCL ' + nf(cfg.lcl, dec)} fill={T.limit} size={10} weight={600} />
        </>
      )}
      {cfg.clSeries ? (
        <>
          <polyline points={seriesPts(cfg.clSeries)} fill="none" stroke={T.center} strokeWidth={T.sw} />
          <Txt x={m.l + pw + 8} y={Y(cfg.clSeries[cfg.clSeries.length - 1])} s={(cfg.clLabel || 'CL') + ' ' + nf(cfg.clSeries[cfg.clSeries.length - 1], dec)} fill={T.center} size={10} weight={600} />
        </>
      ) : (
        <>
          <Ln x1={m.l} y1={Y(cfg.cl)} x2={m.l + pw} y2={Y(cfg.cl)} stroke={T.center} sw={T.sw} />
          <Txt x={m.l + pw + 8} y={Y(cfg.cl)} s={(cfg.clLabel || 'CL') + ' ' + nf(cfg.cl, dec)} fill={T.center} size={10} weight={600} />
        </>
      )}
      {cfg.stageBoundaries?.map((b) => (
        <Ln key={'sb' + b} x1={(X(b) + X(b - 1)) / 2} y1={m.t} x2={(X(b) + X(b - 1)) / 2} y2={m.t + ph} stroke={T.axis} sw={1.2} dash="6 4" />
      ))}
      {cfg.stageLabels?.map((sl) => (
        <Txt key={'sl' + sl.at} x={X(sl.at)} y={m.t - 12} s={sl.label} fill={T.text} size={10} anchor="middle" weight={700} />
      ))}
      {cfg.series2 && (
        <>
          <polyline points={idx.map((i) => `${X(i)},${Y(cfg.series2![i])}`).join(' ')} fill="none" stroke={T.curve2} strokeWidth={T.sw} />
          {idx.map((i) => (
            <circle key={'s2' + i} cx={X(i)} cy={Y(cfg.series2![i])} r={T.r - 0.8} fill={T.curve2} stroke={T.bg} strokeWidth={1} />
          ))}
          {cfg.series2Label && (
            <Txt x={m.l + pw + 8} y={Y(cfg.series2[cfg.series2.length - 1])} s={cfg.series2Label} fill={T.curve2} size={10} weight={600} />
          )}
        </>
      )}
      <polyline points={idx.map((i) => `${X(i)},${Y(data[i])}`).join(' ')} fill="none" stroke={T.line} strokeWidth={T.sw} />
      {idx.map((i) => {
        const v = data[i];
        const bad = viol.has(i);
        const sel = cfg.sel === i;
        return (
          <Fragment key={'p' + i}>
            {sel && <circle cx={X(i)} cy={Y(v)} r={T.r + 5} fill="none" stroke="#1f6fb2" strokeWidth={1.8} />}
            <circle cx={X(i)} cy={Y(v)} r={bad ? T.r + 1.6 : T.r} fill={bad ? T.limit : T.point} stroke={T.bg} strokeWidth={1.2}>
              <title>{label(i) + ' = ' + nf(v, dec)}</title>
            </circle>
            {cfg.onPoint && (
              <circle cx={X(i)} cy={Y(v)} r={11} fill="transparent" style={{ cursor: 'pointer' }} onClick={() => cfg.onPoint!(i)}>
                <title>{label(i) + ' = ' + nf(v, dec)}</title>
              </circle>
            )}
          </Fragment>
        );
      })}
      {idx.map((i) =>
        i % lblStep === 0 || i === data.length - 1 ? (
          <Txt key={'x' + i} x={X(i)} y={H - 10} s={String(i + 1)} fill={T.axis} size={10} anchor="middle" />
        ) : null,
      )}
      {sampled && (
        <Txt x={m.l + pw} y={m.t - 10} s={`渲染 ${idx.length}/${data.length} 点(统计与判异基于全量)`} fill={T.axis} size={9.5} anchor="end" />
      )}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const ControlChart = memo(ControlChartImpl);
