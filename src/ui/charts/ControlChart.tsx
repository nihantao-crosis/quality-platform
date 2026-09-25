/**
 * 控制图（交互点选）— 从原型 controlChart() 迁移。
 * 中心线/UCL/LCL/σ 分区/失控点高亮/选中描边圈/点击回调。
 */
import { memo, Fragment } from 'react';
import { decimateUniform, arrMin, arrMax, decimateMinMax } from '../../core';
import type { ChartTokens } from '../tokens';
import { tickFormatter, niceTicks } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

/** 超过该点数即降采样渲染(统计/判异仍基于全量数据) */
const MAX_RENDER_PTS = 600;
const EXTREME_AXIS_THRESHOLD = Number.MAX_VALUE / 16;

function finiteAxisScale(values: readonly (number | number[] | undefined)[]): number {
  let maximum = 0;
  for (const item of values) {
    if (Array.isArray(item)) {
      for (const value of item) {
        const magnitude = Math.abs(value);
        if (magnitude > maximum) maximum = magnitude;
      }
    } else if (typeof item === 'number') {
      const magnitude = Math.abs(item);
      if (magnitude > maximum) maximum = magnitude;
    }
  }
  if (!Number.isFinite(maximum) || maximum <= EXTREME_AXIS_THRESHOLD) return 1;
  return 2 ** Math.min(1023, Math.floor(Math.log2(maximum)));
}

function restoreAxisCoordinate(value: number, scale: number): number {
  if (Number.isNaN(value)) return Number.NaN;
  if (value === 0) return value;
  const restored = value * scale;
  if (Number.isFinite(restored)) return restored;
  return value < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

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
  // 端点可以同时是 -MAX/+MAX，所以 y 轴的求差、padding 与映射必须在
  // 共同坐标域中完成，不能先构造 2·MAX。常规量程 scale=1，保持原渲染路径。
  const axisScale = finiteAxisScale([
    data, cfg.cl, cfg.ucl, cfg.lcl,
    cfg.uclSeries, cfg.lclSeries, cfg.clSeries, cfg.series2,
  ]);
  const axisCoordinate = (value: number) => value / axisScale;
  const clCoordinate = axisCoordinate(cfg.cl);
  const uclCoordinate = axisCoordinate(cfg.ucl);
  const lclCoordinate = axisCoordinate(cfg.lcl);
  const sigmaCoordinate = (uclCoordinate - clCoordinate) / 3;
  // 大数组安全的 y 轴范围(Math.min(...) 十万级会栈溢出)
  let ymin = Math.min(axisCoordinate(arrMin(data)), lclCoordinate, clCoordinate);
  let ymax = Math.max(axisCoordinate(arrMax(data)), uclCoordinate, clCoordinate);
  for (const s of [cfg.uclSeries, cfg.lclSeries, cfg.clSeries, cfg.series2]) {
    if (s) {
      ymin = Math.min(ymin, axisCoordinate(arrMin(s)));
      ymax = Math.max(ymax, axisCoordinate(arrMax(s)));
    }
  }
  // UI-03/CORE-08:亚 ulp 跨度(常数读数的均值漂移 1 ulp)按常数处理,与 axisScale.coordinateDomain
  // 的常量列口径一致(半宽 max(1, 4ulp));否则 pad≈1e-18 被量级吃掉,纵轴只有 1 ulp 宽。
  const ySpan = ymax - ymin;
  const yMagnitude = Math.max(Math.abs(ymin), Math.abs(ymax));
  const pad = ySpan > Number.EPSILON * yMagnitude * 8
    ? ySpan * 0.18
    : Number.isFinite(yMagnitude) ? Math.max(1, Number.EPSILON * Math.max(1, yMagnitude) * 4) : 1;
  ymin -= pad;
  ymax += pad;
  const X = (i: number) => m.l + (data.length > 1 ? i / (data.length - 1) : 0.5) * pw;
  const YCoordinate = (value: number) => m.t + (1 - (value - ymin) / (ymax - ymin)) * ph;
  const Y = (value: number) => YCoordinate(axisCoordinate(value));
  const viol =
    cfg.violations ??
    new Set(data.map((v, i) => (v > cfg.ucl || v < cfg.lcl ? i : -1)).filter((i) => i >= 0));
  // xIndexOffset 不只属于轴刻度：MR[0] 对应原始观测 2，默认 tooltip/辅助标签也必须映射到同一点号空间。
  const label = (i: number) => (cfg.ptLabel ? cfg.ptLabel(i) : `点 ${i + 1 + xIndexOffset}`);
  const tickLabel = (i: number) => {
    const raw = cfg.xLabels?.length === data.length ? cfg.xLabels[i] : String(i + 1 + xIndexOffset);
    return raw.length > 12 ? raw.slice(0, 11) + '…' : raw;
  };
  // 渲染降采样:失控点/选中点/段边界必留,min-max 分桶保形;统计与判异均基于全量。
  // keep 集合自身设上限(双审 P1):趋势/漂移数据可产出十万级失控点,无界必留会把
  // 降采样整体旁路(单图数十万 SVG 节点页面挂死)——超限时对失控点均匀抽样,
  // 首末必留;判异计数与明细仍基于全量,只影响图上红点密度
  const MAX_KEEP_VIOL = 2000;
  const violArr = [...viol].sort((a, b) => a - b); // 按点序:抽样后首末失控点必留、红点沿 x 轴均匀
  const keptViol = violArr.length > MAX_KEEP_VIOL
    ? decimateUniform(violArr.length, MAX_KEEP_VIOL).map((k) => violArr[k])
    : violArr;
  const keep = [...keptViol, ...(cfg.sel != null ? [cfg.sel] : []), ...(cfg.stageBoundaries ?? []).flatMap((b) => [b - 1, b])];
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
  const yTicks: { coordinate: number; value: number; s: string }[] = T.classic
    ? (() => {
        const tks = niceTicks(ymin, ymax, 5);
        const values = tks.map((coordinate) => restoreAxisCoordinate(coordinate, axisScale));
        // 小数位由圆整步长决定。闭环 P1:**不得传 cfg.dec**——它是限值/点提示的显示口径,
        // 传进来会让 EWMA/CUSUM(dec=4)的常规量程轴从「10 | 15」虚增成「10.0000 | 15.0000」,
        // 与 v1.41 已对齐工厂的默认刻度形制冲突。ppm 量级的重复标签由 tickFormatter 自己升位解决。
        const fmt = tickFormatter(values);
        return tks.map((coordinate, index) => ({
          coordinate,
          value: values[index],
          s: fmt(values[index]),
        }));
      })()
    : (() => {
        // 自审 P2:此前只迁了经典分支,现代/高对比主题仍走 chartNum(v),
        // ppm/次正规量程下 5 个刻度全印成「0.000」(导出路径不传 dec 时更落到默认 3)
        const coordinates = Array.from({ length: 5 }, (_, g) => ymax - ((ymax - ymin) * g) / 4);
        const values = coordinates.map((coordinate) => restoreAxisCoordinate(coordinate, axisScale));
        const fmt = tickFormatter(values); // 同上:轴位数不吃 cfg.dec
        return coordinates.map((coordinate, index) => ({
          coordinate,
          value: values[index],
          s: fmt(values[index]),
        }));
      })();
  // 自审 P2:限值/中心线/σ 带/点提示必须与轴刻度共用同一记数法,否则小量程下
  // 轴走指数而 UCL/LCL 走 nf(·,dec) 全塌成「0.000」,同图两种写法且互相矛盾。
  // 限值/中心线/σ 带/点提示与轴刻度**共用同一个格式化器**(记数法一致)。
  // 闭环:不能把 cl/ucl/lcl 混进 dp 推导——它们可能与某个刻度相差 1e-15,
  // 会把自动升位逼到 15 位,让点提示变成「20.000000000000000」。
  // 位数只由刻度序列决定;限值需要更高精度时由 cfg.dec 单独兜底。
  const chartNum = tickFormatter(yTicks.map((t) => t.value).filter(Number.isFinite), dec);

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
  const zoneInsideCoordinate = (value: number) => (
    value > lclCoordinate + (uclCoordinate - lclCoordinate) * 1e-9
    && value < uclCoordinate - (uclCoordinate - lclCoordinate) * 1e-9
  );
  const fixedLabelYs = [Y(cfg.ucl), Y(cfg.cl), Y(cfg.lcl)];
  const zoneLabelOkCoordinate = (value: number) => {
    if (!cfg.zones || cfg.stepSeries || !zoneInsideCoordinate(value)) return false;
    const y = YCoordinate(value);
    return fixedLabelYs.every((fy) => Math.abs(y - fy) >= 11);
  };
  const stagedZoneRanges = cfg.zones && cfg.stepSeries && cfg.clSeries && cfg.uclSeries && cfg.lclSeries
    ? [0, ...(cfg.stageBoundaries ?? []), data.length]
        .slice(0, -1)
        .map((start, index) => ({ start, end: [0, ...(cfg.stageBoundaries ?? []), data.length][index + 1] - 1 }))
        .filter(({ start, end }) => start >= 0 && end >= start && end < data.length)
    : [];

  return (
    <Svg
      w={W}
      h={H}
      label={typeof cfg.clLabel === 'string' && cfg.clLabel.trim() ? `${cfg.clLabel.trim()} 控制图` : '控制图'}
      interactive={typeof cfg.onPoint === 'function'}
    >
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {yTicks.map(({ coordinate, s }, g) => {
        const yy = YCoordinate(coordinate);
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            {T.classic && <Ln x1={m.l - 4} y1={yy} x2={m.l} y2={yy} stroke={T.axis} sw={1} />}
            <Txt x={m.l - 8} y={yy} s={s} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {stagedZoneRanges.flatMap(({ start, end }, stageIndex) => {
        const cl = axisCoordinate(cfg.clSeries![start]);
        const ucl = axisCoordinate(cfg.uclSeries![start]);
        const lcl = axisCoordinate(cfg.lclSeries![start]);
        const stageSigma = (ucl - cl) / 3;
        const left = start === 0 ? X(start) : (X(start - 1) + X(start)) / 2;
        const right = end === data.length - 1 ? X(end) : (X(end) + X(end + 1)) / 2;
        return [1, 2].flatMap((z) => ([1, -1] as const).flatMap((sign) => {
          const value = cl + sign * z * stageSigma;
          if (!(value > lcl + (ucl - lcl) * 1e-9 && value < ucl - (ucl - lcl) * 1e-9)) return [];
          const y = YCoordinate(value);
          // 跨阶段量级悬殊时，小量级阶段的 1σ 像素间距可能不足字体高度；
          // 标签改为在段内按 z 错开横向位置，保留全部数值而不与右侧 UCL/CL/LCL 文本碰撞。
          const labelX = left + (right - left) * (z === 1 ? 0.32 : 0.68);
          return [
            <Fragment key={`sz-${stageIndex}-${sign}-${z}`}>
              <Ln x1={left} y1={y} x2={right} y2={y} stroke={zoneStroke} sw={1} dash="2 4" />
              <Txt
                x={labelX}
                y={y - 3}
                s={`${sign > 0 ? '+' : '-'}${z}SL${lblSep}${chartNum(restoreAxisCoordinate(value, axisScale))}`}
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
        [1, 2].map((z) => {
          const upperCoordinate = clCoordinate + z * sigmaCoordinate;
          const lowerCoordinate = clCoordinate - z * sigmaCoordinate;
          const upperValue = restoreAxisCoordinate(upperCoordinate, axisScale);
          const lowerValue = restoreAxisCoordinate(lowerCoordinate, axisScale);
          return (
          <Fragment key={'z' + z}>
            {zoneInsideCoordinate(upperCoordinate) && YCoordinate(upperCoordinate) > m.t && (
              <>
                <Ln x1={m.l} y1={YCoordinate(upperCoordinate)} x2={m.l + pw} y2={YCoordinate(upperCoordinate)} stroke={zoneStroke} sw={1} dash="2 4" />
                {zoneLabelOkCoordinate(upperCoordinate) && (
                  <Txt x={m.l + pw + 8} y={YCoordinate(upperCoordinate)} s={'+' + z + 'SL' + lblSep + chartNum(upperValue)} fill={zoneLblFill} size={10} weight={600} />
                )}
              </>
            )}
            {zoneInsideCoordinate(lowerCoordinate) && YCoordinate(lowerCoordinate) < m.t + ph && (
              <>
                <Ln x1={m.l} y1={YCoordinate(lowerCoordinate)} x2={m.l + pw} y2={YCoordinate(lowerCoordinate)} stroke={zoneStroke} sw={1} dash="2 4" />
                {zoneLabelOkCoordinate(lowerCoordinate) && (
                  <Txt x={m.l + pw + 8} y={YCoordinate(lowerCoordinate)} s={'-' + z + 'SL' + lblSep + chartNum(lowerValue)} fill={zoneLblFill} size={10} weight={600} />
                )}
              </>
            )}
          </Fragment>
          );
        })}
      {cfg.uclSeries ? (
        <>
          <polyline points={seriesPts(cfg.uclSeries)} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.limitDash} />
          <polyline points={seriesPts(cfg.lclSeries ?? [])} fill="none" stroke={T.limit} strokeWidth={T.sw} strokeDasharray={T.limitDash} />
          <Txt x={m.l + pw + 8} y={Y(cfg.uclSeries[cfg.uclSeries.length - 1])} s={'UCL' + lblSep + chartNum(cfg.uclSeries[cfg.uclSeries.length - 1])} fill={limitLblFill} size={10} weight={600} />
          {cfg.lclSeries && (
            <Txt x={m.l + pw + 8} y={Y(cfg.lclSeries[cfg.lclSeries.length - 1])} s={'LCL' + lblSep + chartNum(cfg.lclSeries[cfg.lclSeries.length - 1])} fill={limitLblFill} size={10} weight={600} />
          )}
        </>
      ) : (
        <>
          <Ln x1={m.l} y1={Y(cfg.ucl)} x2={m.l + pw} y2={Y(cfg.ucl)} stroke={T.limit} sw={T.sw} dash={T.limitDash} />
          <Ln x1={m.l} y1={Y(cfg.lcl)} x2={m.l + pw} y2={Y(cfg.lcl)} stroke={T.limit} sw={T.sw} dash={T.limitDash} />
          <Txt x={m.l + pw + 8} y={Y(cfg.ucl)} s={'UCL' + lblSep + chartNum(cfg.ucl)} fill={limitLblFill} size={10} weight={600} />
          <Txt x={m.l + pw + 8} y={Y(cfg.lcl)} s={'LCL' + lblSep + chartNum(cfg.lcl)} fill={limitLblFill} size={10} weight={600} />
        </>
      )}
      {cfg.clSeries ? (
        <>
          <polyline points={seriesPts(cfg.clSeries)} fill="none" stroke={T.center} strokeWidth={T.sw} />
          <Txt x={m.l + pw + 8} y={Y(cfg.clSeries[cfg.clSeries.length - 1])} s={(cfg.clLabel || 'CL') + lblSep + chartNum(cfg.clSeries[cfg.clSeries.length - 1])} fill={centerLblFill} size={10} weight={600} />
        </>
      ) : (
        <>
          <Ln x1={m.l} y1={Y(cfg.cl)} x2={m.l + pw} y2={Y(cfg.cl)} stroke={T.center} sw={T.sw} />
          <Txt x={m.l + pw + 8} y={Y(cfg.cl)} s={(cfg.clLabel || 'CL') + lblSep + chartNum(cfg.cl)} fill={centerLblFill} size={10} weight={600} />
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
              <title>{label(i) + ' = ' + chartNum(v)}</title>
            </circle>
            {cfg.onPoint && (
              <circle
                cx={X(i)} cy={Y(v)} r={11} fill="transparent" style={{ cursor: 'pointer' }}
                role="button" tabIndex={0} aria-label={`${label(i)}，值 ${chartNum(v)}，查看明细`}
                onClick={() => cfg.onPoint!(i)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    cfg.onPoint!(i);
                  }
                }}
              >
                <title>{label(i) + ' = ' + chartNum(v)}</title>
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
