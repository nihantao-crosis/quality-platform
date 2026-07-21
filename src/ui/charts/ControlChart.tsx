/**
 * 控制图（交互点选）— 从原型 controlChart() 迁移。
 * 中心线/UCL/LCL/σ 分区/失控点高亮/选中描边圈/点击回调。
 */
import { memo, Fragment } from 'react';
import { nf, arrMin, arrMax, decimateMinMax } from '../../core';
import type { ChartTokens } from '../tokens';
import { niceTicks, tickDecimals } from '../tokens';
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
  /** 明确的横轴点标签（如批次号/子组 ID）；长度须与 data 一致。 */
  xLabels?: string[];
  /** 轴语义；变量控制图不再只显示无含义的数字刻度。 */
  xLabel?: string;
  yLabel?: string;
  /** X 轴显示序号相对数组索引的偏移；MR[0] 对应原始观测 2，故传 1。 */
  xIndexOffset?: number;
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
  /** 合并双面板的上面板:隐藏 X 轴刻度与轴题,压缩底边距,与下面板共享横轴(批次716-R3)。 */
  hideXAxis?: boolean;
}

function ControlChartImpl(cfg: ControlChartProps) {
  const T = cfg.T;
  const W = 960;
  const H = cfg.h ?? 260;
  const m = { t: 24, r: 104, b: cfg.hideXAxis ? 12 : cfg.xLabel ? 48 : 30, l: cfg.yLabel ? 78 : 60 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const data = cfg.data;
  const dec = cfg.dec ?? 3;
  const xIndexOffset = cfg.xIndexOffset ?? 0;
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
  // xIndexOffset 不只属于轴刻度：MR[0] 对应原始观测 2，默认 tooltip/辅助标签也必须映射到同一点号空间。
  const label = (i: number) => (cfg.ptLabel ? cfg.ptLabel(i) : `点 ${i + 1 + xIndexOffset}`);
  const tickLabel = (i: number) => {
    const raw = cfg.xLabels?.length === data.length ? cfg.xLabels[i] : String(i + 1 + xIndexOffset);
    return raw.length > 12 ? raw.slice(0, 11) + '…' : raw;
  };
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
  // Y 轴刻度:经典主题按 Minitab 用 1-2-5 圆整刻度;其余主题保持 5 等分
  const yTicks: { v: number; s: string }[] = T.classic
    ? (() => {
        const tks = niceTicks(ymin, ymax, 5);
        // 小数位由圆整步长决定(取 min(dec,·) 会把 ppm 级刻度四舍五入成重复标签)
        const d = tickDecimals(tks);
        return tks.map((v) => ({ v, s: nf(v, d) }));
      })()
    : Array.from({ length: 5 }, (_, g) => {
        const v = ymax - ((ymax - ymin) * g) / 4;
        return { v, s: nf(v, dec) };
      });
  // σ 分区参考线:经典主题网格透明,需独立浅灰;判异标签(UCL/CL)经典用黑字含等号
  const zoneStroke = T.classic ? '#ccd2d9' : T.grid;
  const lblSep = T.classic ? '=' : ' ';
  const limitLblFill = T.classic ? '#111111' : T.limit;
  const centerLblFill = T.classic ? '#111111' : T.center;
  // ±1SL/±2SL 数值标注(批次720-A4,Minitab「显示控制图的 σ 区带」口径;SL=sigma level,
  // 与规格限 USL/LSL 无关)。审查修复:σ 区带线/标注严格夹在 (LCL,UCL) 开区间内——
  // R/S/MR/C/P 图 LCL 截 0 后,cl±2σ 可能低于 LCL 甚至为负(非负统计量不存在负参考线);
  // 标签改为逐条与 UCL/CL/LCL 标签逐对测距,间距不足 11px 的 SL 标签丢弃(线仍按区间画)。
  const zoneLblFill = T.classic ? '#111111' : T.axis;
  const zoneInside = (v: number) => v > cfg.lcl + (cfg.ucl - cfg.lcl) * 1e-9 && v < cfg.ucl - (cfg.ucl - cfg.lcl) * 1e-9;
  const fixedLabelYs = [Y(cfg.ucl), Y(cfg.cl), Y(cfg.lcl)];
  const zoneLabelOk = (v: number) => {
    if (!cfg.zones || cfg.stepSeries || !zoneInside(v)) return false;
    const y = Y(v);
    return fixedLabelYs.every((fy) => Math.abs(y - fy) >= 11);
  };
  const stagedZoneRanges = cfg.zones && cfg.stepSeries && cfg.clSeries && cfg.uclSeries && cfg.lclSeries
    ? [0, ...(cfg.stageBoundaries ?? []), data.length]
        .slice(0, -1)
        .map((start, index) => ({ start, end: [0, ...(cfg.stageBoundaries ?? []), data.length][index + 1] - 1 }))
        .filter(({ start, end }) => start >= 0 && end >= start && end < data.length)
    : [];

  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {yTicks.map(({ v, s }, g) => {
        const yy = Y(v);
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            {T.classic && <Ln x1={m.l - 4} y1={yy} x2={m.l} y2={yy} stroke={T.axis} sw={1} />}
            <Txt x={m.l - 8} y={yy} s={s} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {stagedZoneRanges.flatMap(({ start, end }, stageIndex) => {
        const cl = cfg.clSeries![start];
        const ucl = cfg.uclSeries![start];
        const lcl = cfg.lclSeries![start];
        const stageSigma = (ucl - cl) / 3;
        const left = start === 0 ? X(start) : (X(start - 1) + X(start)) / 2;
        const right = end === data.length - 1 ? X(end) : (X(end) + X(end + 1)) / 2;
        return [1, 2].flatMap((z) => ([1, -1] as const).flatMap((sign) => {
          const value = cl + sign * z * stageSigma;
          if (!(value > lcl + (ucl - lcl) * 1e-9 && value < ucl - (ucl - lcl) * 1e-9)) return [];
          const y = Y(value);
          // 跨阶段量级悬殊时，小量级阶段的 1σ 像素间距可能不足字体高度；
          // 标签改为在段内按 z 错开横向位置，保留全部数值而不与右侧 UCL/CL/LCL 文本碰撞。
          const labelX = left + (right - left) * (z === 1 ? 0.32 : 0.68);
          return [
            <Fragment key={`sz-${stageIndex}-${sign}-${z}`}>
              <Ln x1={left} y1={y} x2={right} y2={y} stroke={zoneStroke} sw={1} dash="2 4" />
              <Txt
                x={labelX}
                y={y - 3}
                s={`${sign > 0 ? '+' : '-'}${z}SL${lblSep}${nf(value, dec)}`}
                fill={zoneLblFill}
                size={8.5}
                anchor="middle"
                weight={600}
              />
            </Fragment>,
          ];
        }));
      })}
      {cfg.zones && !cfg.clSeries &&
        [1, 2].map((z) => (
          <Fragment key={'z' + z}>
            {zoneInside(cfg.cl + z * sigma) && Y(cfg.cl + z * sigma) > m.t && (
              <>
                <Ln x1={m.l} y1={Y(cfg.cl + z * sigma)} x2={m.l + pw} y2={Y(cfg.cl + z * sigma)} stroke={zoneStroke} sw={1} dash="2 4" />
                {zoneLabelOk(cfg.cl + z * sigma) && (
                  <Txt x={m.l + pw + 8} y={Y(cfg.cl + z * sigma)} s={'+' + z + 'SL' + lblSep + nf(cfg.cl + z * sigma, dec)} fill={zoneLblFill} size={10} weight={600} />
                )}
              </>
            )}
            {zoneInside(cfg.cl - z * sigma) && Y(cfg.cl - z * sigma) < m.t + ph && (
              <>
                <Ln x1={m.l} y1={Y(cfg.cl - z * sigma)} x2={m.l + pw} y2={Y(cfg.cl - z * sigma)} stroke={zoneStroke} sw={1} dash="2 4" />
                {zoneLabelOk(cfg.cl - z * sigma) && (
                  <Txt x={m.l + pw + 8} y={Y(cfg.cl - z * sigma)} s={'-' + z + 'SL' + lblSep + nf(cfg.cl - z * sigma, dec)} fill={zoneLblFill} size={10} weight={600} />
                )}
              </>
            )}
          </Fragment>
        ))}
      {cfg.uclSeries ? (
        <>
          <polyline points={seriesPts(cfg.uclSeries)} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.limitDash} />
          <polyline points={seriesPts(cfg.lclSeries ?? [])} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.limitDash} />
          <Txt x={m.l + pw + 8} y={Y(cfg.uclSeries[cfg.uclSeries.length - 1])} s={'UCL' + lblSep + nf(cfg.uclSeries[cfg.uclSeries.length - 1], dec)} fill={limitLblFill} size={10} weight={600} />
          {cfg.lclSeries && (
            <Txt x={m.l + pw + 8} y={Y(cfg.lclSeries[cfg.lclSeries.length - 1])} s={'LCL' + lblSep + nf(cfg.lclSeries[cfg.lclSeries.length - 1], dec)} fill={limitLblFill} size={10} weight={600} />
          )}
        </>
      ) : (
        <>
          <Ln x1={m.l} y1={Y(cfg.ucl)} x2={m.l + pw} y2={Y(cfg.ucl)} stroke={T.limit} sw={T.sw} dash={T.limitDash} />
          <Ln x1={m.l} y1={Y(cfg.lcl)} x2={m.l + pw} y2={Y(cfg.lcl)} stroke={T.limit} sw={T.sw} dash={T.limitDash} />
          <Txt x={m.l + pw + 8} y={Y(cfg.ucl)} s={'UCL' + lblSep + nf(cfg.ucl, dec)} fill={limitLblFill} size={10} weight={600} />
          <Txt x={m.l + pw + 8} y={Y(cfg.lcl)} s={'LCL' + lblSep + nf(cfg.lcl, dec)} fill={limitLblFill} size={10} weight={600} />
        </>
      )}
      {cfg.clSeries ? (
        <>
          <polyline points={seriesPts(cfg.clSeries)} fill="none" stroke={T.center} strokeWidth={T.sw} />
          <Txt x={m.l + pw + 8} y={Y(cfg.clSeries[cfg.clSeries.length - 1])} s={(cfg.clLabel || 'CL') + lblSep + nf(cfg.clSeries[cfg.clSeries.length - 1], dec)} fill={centerLblFill} size={10} weight={600} />
        </>
      ) : (
        <>
          <Ln x1={m.l} y1={Y(cfg.cl)} x2={m.l + pw} y2={Y(cfg.cl)} stroke={T.center} sw={T.sw} />
          <Txt x={m.l + pw + 8} y={Y(cfg.cl)} s={(cfg.clLabel || 'CL') + lblSep + nf(cfg.cl, dec)} fill={centerLblFill} size={10} weight={600} />
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
              <circle
                cx={X(i)} cy={Y(v)} r={11} fill="transparent" style={{ cursor: 'pointer' }}
                role="button" tabIndex={0} aria-label={`${label(i)}，值 ${nf(v, dec)}，查看明细`}
                onClick={() => cfg.onPoint!(i)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    cfg.onPoint!(i);
                  }
                }}
              >
                <title>{label(i) + ' = ' + nf(v, dec)}</title>
              </circle>
            )}
          </Fragment>
        );
      })}
      {!cfg.hideXAxis && idx.map((i) =>
        i % lblStep === 0 || i === data.length - 1 ? (
          <Txt key={'x' + i} x={X(i)} y={H - (cfg.xLabel ? 25 : 10)} s={tickLabel(i)} fill={T.axis} size={10} anchor="middle" />
        ) : null,
      )}
      {!cfg.hideXAxis && cfg.xLabel && <Txt x={m.l + pw / 2} y={H - 8} s={cfg.xLabel} fill={T.text} size={10.5} anchor="middle" weight={600} />}
      {cfg.yLabel && (
        <text
          x={18} y={m.t + ph / 2} fill={T.text} fontSize={10.5} textAnchor="middle"
          fontFamily="IBM Plex Mono, monospace" fontWeight={600}
          transform={`rotate(-90 18 ${m.t + ph / 2})`}
        >
          {cfg.yLabel}
        </text>
      )}
      {sampled && (
        <Txt x={m.l + pw} y={m.t - 10} s={`渲染 ${idx.length}/${data.length} 点(统计与判异基于全量)`} fill={T.axis} size={9.5} anchor="end" />
      )}
      {T.classic ? (
        <rect x={m.l} y={m.t} width={pw} height={ph} fill="none" stroke={T.frame} strokeWidth={1} />
      ) : (
        <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      )}
    </Svg>
  );
}

export const ControlChart = memo(ControlChartImpl);
