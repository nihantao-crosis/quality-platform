/**
 * EWMA / CUSUM 设计常数与披露文案的唯一来源。
 *
 * 本平台保持 Montgomery 教材口径(EWMA λ=0.2、L=2.7;CUSUM k=0.5、h=4 子组 / 5 单值),
 * 与 Minitab 默认(EWMA L=3σ、CUSUM h=4)不完全相同。页面图注、统计卡与专项报告
 * (HTML/Word/PPT/Excel)都从这里取常数和文案,避免计算口径与披露文字各写一份后漂移。
 */

export const EWMA_LAMBDA = 0.2;
export const EWMA_L = 2.7;
export const CUSUM_K = 0.5;
/** Minitab 的 EWMA 默认控制限宽度(σ 倍数)与 CUSUM 默认判定限 h。 */
export const MINITAB_DEFAULT_EWMA_L = 3;
export const MINITAB_DEFAULT_CUSUM_H = 4;

/** CUSUM 判定限 h:子组均值序列 4、单值序列 5(Montgomery 口径)。 */
export function cusumH(hasSubgroups: boolean): number {
  return hasSubgroups ? 4 : 5;
}

/** 「λ=0.2 · L=2.7(Montgomery 口径,Minitab 默认 L=3σ)」 */
export function ewmaParamsText(lambda: number = EWMA_LAMBDA, L: number = EWMA_L): string {
  const origin = L === MINITAB_DEFAULT_EWMA_L
    ? '与 Minitab 默认 3σ 一致'
    : `Montgomery 口径,Minitab 默认 L=${MINITAB_DEFAULT_EWMA_L}σ`;
  return `λ=${lambda} · L=${L}(${origin})`;
}

/** 「k=0.5 · h=5(Montgomery 单值口径,Minitab 默认 h=4)」;h=4 时注明与 Minitab 默认一致。 */
export function cusumParamsText(k: number, h: number): string {
  const origin = h === MINITAB_DEFAULT_CUSUM_H
    ? '与 Minitab 默认一致'
    : `Montgomery 口径,Minitab 默认 h=${MINITAB_DEFAULT_CUSUM_H}`;
  return `k=${k} · h=${h}(${origin})`;
}
