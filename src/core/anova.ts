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
  if (k < 2) throw new Error('单因子 ANOVA 至少需要 2 个组');
  if (groups.some((g) => g.length < 2)) throw new Error('每个组至少需要 2 个观测值');
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
  const errorMS = errorSS / errorDf;
  // 组内零方差(完美一致):组间有差异 → 无穷显著(p=0);组间也无差异 → 无信息(p=1)。
  // 否则会得到 F=∞、p=NaN 而被误判为"不显著"。
  let fStat: number;
  let pValue: number;
  if (errorMS <= 1e-12) {
    fStat = factorSS > 1e-12 ? Infinity : 0;
    pValue = factorSS > 1e-12 ? 0 : 1;
  } else {
    fStat = (factorSS / factorDf) / errorMS;
    pValue = 1 - fCdf(fStat, factorDf, errorDf);
  }
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

export interface AnovaGroup { name: string; vals: number[] }
export type AnovaMode = 'stacked' | 'wide' | 'numfactor';

/** 按模式从数据集构造 ANOVA 分组——页面与项目汇总共用同一逻辑,保证界面与卡片一致。
 *  - stacked  : factorName 为文本分组列,respName 为数值响应列;按标签分组。
 *  - numfactor: factorName 为数值因子列(按其取值分组),respName 为数值响应列。
 *  - wide     : 各数值列各成一组(Minitab unstacked)。
 *  返回 null 表示当前形态无法构成有效分组(需 ≥2 组、每组 ≥2 观测)。 */
export function buildAnovaGroups(
  mode: AnovaMode,
  colNames: string[],
  rows: number[][],
  textCols: { name: string; values: string[] }[],
  respName: string | null,
  factorName: string | null,
): AnovaGroup[] | null {
  const nCol = colNames.length;
  const idxOf = (name: string | null, fallback: number) => {
    const i = name ? colNames.indexOf(name) : -1;
    return i >= 0 ? i : fallback;
  };
  if (mode === 'wide') {
    if (nCol < 2) return null;
    return colNames.map((name, j) => ({ name, vals: rows.map((r) => r[j]) }));
  }
  if (mode === 'stacked') {
    const tc = (factorName ? textCols.find((t) => t.name === factorName) : textCols[0]) ?? textCols[0];
    if (!tc || nCol < 1) return null;
    const rIdx = idxOf(respName, 0);
    const byLabel = new Map<string, number[]>();
    tc.values.forEach((l, i) => {
      if (!byLabel.has(l)) byLabel.set(l, []);
      if (rows[i]) byLabel.get(l)!.push(rows[i][rIdx]);
    });
    const gs = [...byLabel.entries()].map(([name, vals]) => ({ name, vals }));
    return gs.length >= 2 && gs.every((g) => g.vals.length >= 2) ? gs : null;
  }
  // numfactor
  if (nCol < 2) return null;
  const fIdx = idxOf(factorName, 0);
  const rIdx = idxOf(respName, fIdx === 0 ? 1 : 0);
  if (fIdx === rIdx) return null;
  const byLevel = new Map<number, number[]>();
  rows.forEach((r) => {
    const lv = r[fIdx];
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(r[rIdx]);
  });
  const gs = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lv, vals]) => ({ name: `${colNames[fIdx]}=${lv}`, vals }));
  return gs.length >= 2 && gs.every((g) => g.vals.length >= 2) ? gs : null;
}

/** 宽表各列均值量纲是否悬殊(最大/最小均值幅度 > 100 倍)——多半不是同一响应量,横比无统计意义。 */
export function wideScaleDisparate(groups: AnovaGroup[]): boolean {
  const centers = groups
    .map((g) => Math.abs(g.vals.reduce((a, b) => a + b, 0) / (g.vals.length || 1)))
    .filter((c) => c > 1e-12);
  if (centers.length < 2) return false;
  const maxC = centers.reduce((a, b) => Math.max(a, b), -Infinity);
  const minC = centers.reduce((a, b) => Math.min(a, b), Infinity);
  return maxC / minC > 100;
}

/** 残差诊断数据:fits = 各观测所属组的均值,residuals = 观测 − 组均值(按组序展平)。 */
export function anovaResiduals(groups: number[][]): { fits: number[]; residuals: number[] } {
  const fits: number[] = [];
  const residuals: number[] = [];
  for (const g of groups) {
    const m = mean(g);
    for (const v of g) {
      fits.push(m);
      residuals.push(v - m);
    }
  }
  return { fits, residuals };
}
