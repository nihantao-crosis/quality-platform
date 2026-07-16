/**
 * 效应正态/半正态概率图 — 普通模式:效应 vs 正态分位;半正态:|效应| vs 半正态分位。
 * 显著效应(超 Lenth ME 或 t 临界,由调用方判定后传入 sig)红点 + 项名标签,其余蓝点;
 * 参考线过原点、斜率 = Lenth PSE:无真实效应的项应落在参考线附近,离线远者可疑为显著。
 * 坐标/配色写法与 NormalProbPlot 保持一致(中位秩 Benard 近似 + tokens 主题色)。
 */
import { memo, Fragment } from 'react';
import { nf, invNorm } from '../../core';
import type { ChartTokens } from '../tokens';
import { niceTicks, tickDecimals } from '../tokens';
import { Svg, Ln, Txt } from './primitives';

export interface EffectsNormalPlotTerm {
  name: string;
  effect: number;
  sig: boolean;
}

const FULL_PCT_TICKS = [1, 5, 20, 50, 80, 95, 99];
const HALF_PCT_TICKS = [10, 30, 50, 70, 85, 95, 98];

function EffectsNormalPlotImpl({ T, terms, pse, half = false, h }: {
  T: ChartTokens;
  terms: EffectsNormalPlotTerm[];
  /** Lenth 伪标准误,参考线斜率;≤0 时不画参考线。 */
  pse: number;
  half?: boolean;
  h?: number;
}) {
  const W = 960;
  const H = h ?? 320;
  const m = { t: 22, r: 140, b: 40, l: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const finite = terms.filter((term) => Number.isFinite(term.effect));
  if (!finite.length) {
    return (
      <Svg w={W} h={H}>
        <rect x={0} y={0} width={W} height={H} fill={T.bg} />
        <Txt x={W / 2} y={H / 2} s="无可估计效应,无法绘制效应概率图" fill={T.axis} size={12} anchor="middle" />
      </Svg>
    );
  }
  const n = finite.length;
  const pts = [...finite]
    .map((term) => ({ ...term, x: half ? Math.abs(term.effect) : term.effect }))
    .sort((a, b) => a.x - b.x)
    .map((term, i) => {
      const pp = (i + 1 - 0.375) / (n + 0.25); // 中位秩(Benard),与正态概率图同口径
      return { ...term, z: half ? invNorm(0.5 + pp / 2) : invNorm(pp) };
    });
  const zTop = Math.max(2.2, ...pts.map((p) => Math.abs(p.z))) * 1.1;
  const zlo = half ? 0 : -zTop;
  const zhi = zTop;
  const lineOn = Number.isFinite(pse) && pse > 0;
  const lineXs = lineOn ? [pse * zlo, pse * zhi] : [];
  let xlo = Math.min(0, ...pts.map((p) => p.x), ...lineXs);
  let xhi = Math.max(0, ...pts.map((p) => p.x), ...lineXs);
  if (!(xhi > xlo)) {
    // 效应全为 0(且 PSE=0):给一个有限显示窗口,避免除零产生 NaN 坐标
    const halfSpan = Math.max(1, Math.abs(xlo) * 0.1);
    xlo -= halfSpan;
    xhi += halfSpan;
  } else {
    const pad = (xhi - xlo) * 0.06;
    xlo -= pad;
    xhi += pad;
  }
  const X = (v: number) => m.l + ((v - xlo) / (xhi - xlo)) * pw;
  const Y = (z: number) => m.t + (1 - (z - zlo) / (zhi - zlo)) * ph;
  const pctTicks = (half ? HALF_PCT_TICKS : FULL_PCT_TICKS)
    .map((p) => ({ p, z: half ? invNorm(0.5 + p / 200) : invNorm(p / 100) }))
    .filter(({ z }) => z >= zlo - 1e-9 && z <= zhi + 1e-9);
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {pctTicks.map(({ p, z }) => (
        <Fragment key={p}>
          {/* 百分位定位线是读数依据:经典主题网格透明时改用独立浅灰 + 轴侧刻度短线 */}
          <Ln x1={m.l} y1={Y(z)} x2={m.l + pw} y2={Y(z)} stroke={T.classic ? '#e3e6ea' : T.grid} sw={1} />
          {T.classic && <Ln x1={m.l - 4} y1={Y(z)} x2={m.l} y2={Y(z)} stroke={T.axis} sw={1} />}
          <Txt x={m.l - 8} y={Y(z)} s={p + '%'} fill={T.axis} size={10} anchor="end" />
        </Fragment>
      ))}
      {(() => {
        const tks = niceTicks(xlo, xhi, 6);
        const d = tickDecimals(tks);
        return tks.map((v, i) => <Txt key={'x' + i} x={X(v)} y={H - 12} s={nf(v, d)} fill={T.axis} size={10} anchor="middle" />);
      })()}
      {!half && xlo < 0 && xhi > 0 && (
        <Ln x1={X(0)} y1={m.t} x2={X(0)} y2={m.t + ph} stroke={T.classic ? '#ccd2d9' : T.grid} sw={1} dash="3 3" />
      )}
      {/* 参考线:效应 = PSE·z,过原点 */}
      {lineOn && (
        <Ln x1={X(pse * zlo)} y1={Y(zlo)} x2={X(pse * zhi)} y2={Y(zhi)} stroke={T.center} sw={T.sw + 0.4} />
      )}
      {pts.map((p) => (
        <Fragment key={p.name}>
          <circle cx={X(p.x)} cy={Y(p.z)} r={T.r + (p.sig ? 0.6 : -0.4)}
            fill={p.sig ? T.limit : T.point} stroke={T.bg} strokeWidth={1} opacity={0.9} />
          {p.sig && (
            <Txt x={X(p.x) + 8} y={Y(p.z)} s={p.name} fill={T.limit} size={10.5} weight={600} />
          )}
        </Fragment>
      ))}
      <Txt x={m.l} y={m.t - 8} s={half ? '累积概率(半正态分位) · 横轴 |效应|' : '累积概率(正态分位) · 横轴 效应'} fill={T.text} size={11} weight={600} />
      <Txt x={m.l + pw} y={m.t - 8} s={lineOn ? `参考线过原点,斜率 PSE=${nf(pse, 3)}` : 'PSE=0,参考线不可用'} fill={T.axis} size={10} anchor="end" />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}

export const EffectsNormalPlot = memo(EffectsNormalPlotImpl);
