/**
 * 控制图（交互点选）— 从原型 controlChart() 迁移。
 * 中心线/UCL/LCL/σ 分区/失控点高亮/选中描边圈/点击回调。
 */
import { memo, Fragment } from 'react';
import { nf } from '../../core';
import type { ChartTokens } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

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
  /** 时变控制限（EWMA）：提供时覆盖水平 UCL/LCL 直线 */
  uclSeries?: number[];
  lclSeries?: number[];
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
  const ys = [
    ...data, cfg.ucl, cfg.lcl, cfg.cl,
    ...(cfg.uclSeries ?? []), ...(cfg.lclSeries ?? []), ...(cfg.series2 ?? []),
  ];
  let ymin = Math.min(...ys);
  let ymax = Math.max(...ys);
  const pad = (ymax - ymin) * 0.18 || 1;
  ymin -= pad;
  ymax += pad;
  const X = (i: number) => m.l + (data.length > 1 ? i / (data.length - 1) : 0.5) * pw;
  const Y = (v: number) => m.t + (1 - (v - ymin) / (ymax - ymin)) * ph;
  const viol =
    cfg.violations ??
    new Set(data.map((v, i) => (v > cfg.ucl || v < cfg.lcl ? i : -1)).filter((i) => i >= 0));
  const label = (i: number) => (cfg.ptLabel ? cfg.ptLabel(i) : `点 ${i + 1}`);

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
          <polyline points={cfg.uclSeries.map((v, i) => `${X(i)},${Y(v)}`).join(' ')} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.dash} />
          <polyline points={(cfg.lclSeries ?? []).map((v, i) => `${X(i)},${Y(v)}`).join(' ')} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.dash} />
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
      <Ln x1={m.l} y1={Y(cfg.cl)} x2={m.l + pw} y2={Y(cfg.cl)} stroke={T.center} sw={T.sw} />
      <Txt x={m.l + pw + 8} y={Y(cfg.cl)} s={(cfg.clLabel || 'CL') + ' ' + nf(cfg.cl, dec)} fill={T.center} size={10} weight={600} />
      {cfg.series2 && (
        <>
          <polyline points={cfg.series2.map((v, i) => `${X(i)},${Y(v)}`).join(' ')} fill="none" stroke={T.curve2} strokeWidth={T.sw} />
          {cfg.series2.map((v, i) => (
            <circle key={'s2' + i} cx={X(i)} cy={Y(v)} r={T.r - 0.8} fill={T.curve2} stroke={T.bg} strokeWidth={1} />
          ))}
          {cfg.series2Label && (
            <Txt x={m.l + pw + 8} y={Y(cfg.series2[cfg.series2.length - 1])} s={cfg.series2Label} fill={T.curve2} size={10} weight={600} />
          )}
        </>
      )}
      <polyline points={data.map((v, i) => `${X(i)},${Y(v)}`).join(' ')} fill="none" stroke={T.line} strokeWidth={T.sw} />
      {data.map((v, i) => {
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
      {data.map((_, i) =>
        i % 5 === 0 || i === data.length - 1 ? (
          <Txt key={'x' + i} x={X(i)} y={H - 10} s={String(i + 1)} fill={T.axis} size={10} anchor="middle" />
        ) : null,
      )}
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const ControlChart = memo(ControlChartImpl);
