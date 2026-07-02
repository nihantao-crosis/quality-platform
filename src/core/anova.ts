/**
 * 单因子方差分析 — F 统计量 + P 值（F 分布 CDF）。
 * 补齐交接文档 core-skeleton/statistics.ts §7 的签名。
 */
import { mean, fCdf } from './basicMath';

export interface AnovaResult {
  factorDf: number;
  errorDf: number;
  totalDf: number;
  factorSS: number;
  errorSS: number;
  totalSS: number;
  fStat: number;
  pValue: number;
  significant: boolean; // p < 0.05
}

export function oneWayAnova(groups: number[][]): AnovaResult {
  const k = groups.length;
  const all = groups.flat();
  const N = all.length;
  const grand = mean(all);
  const factorSS = groups.reduce((a, g) => a + g.length * (mean(g) - grand) ** 2, 0);
  const errorSS = groups.reduce((a, g) => {
    const m = mean(g);
    return a + g.reduce((x, v) => x + (v - m) ** 2, 0);
  }, 0);
  const factorDf = k - 1;
  const errorDf = N - k;
  const fStat = factorSS / factorDf / (errorSS / errorDf);
  const pValue = 1 - fCdf(fStat, factorDf, errorDf);
  return {
    factorDf,
    errorDf,
    totalDf: N - 1,
    factorSS,
    errorSS,
    totalSS: factorSS + errorSS,
    fStat,
    pValue,
    significant: pValue < 0.05,
  };
}
