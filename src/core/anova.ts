/**
 * 单因子方差分析 — F 统计量 + P 值（F 分布 CDF）。
 * 补齐交接文档 core-skeleton/statistics.ts §7 的签名。
 */
import { mean, fCdf } from './basicMath';
import { tInv } from './ttest';
import { isDoeAnalysisColumn } from './doe';

export interface AnovaResult {
  factorDf: number;
  errorDf: number;
  totalDf: number;
  factorSS: number;
  errorSS: number;
  totalSS: number;
  factorMS: number;
  errorMS: number;
  fStat: number;
  pValue: number;
  significant: boolean; // p < 0.05
}

export function oneWayAnova(groups: number[][]): AnovaResult {
  const k = groups.length;
  if (k < 2) throw new Error('单因子 ANOVA 至少需要 2 个组');
  if (groups.some((g) => g.length < 2)) throw new Error('每个组至少需要 2 个观测值');
  if (groups.some((group) => group.some((value) => !Number.isFinite(value)))) {
    throw new Error('ANOVA 观测值必须全部为有限数值');
  }
  const all = groups.flat();
  const N = all.length;
  // F 是无量纲比值。先减去共同原点，再用“离差尺度”归一化后计算平方和。
  // 绝对值尺度会把与 ANOVA 无关的平移基准带入舍入误差，使同一组数据仅因加上
  // 常数就改变 F/P；中心化坐标同时保留小量纲数据和大基准上的组间/组内差异。
  // 最终平方和再还原到输入单位；极端尺度下即使还原值溢出/下溢，F/P 仍可估计。
  let origin = all[0];
  let centered = groups.map((group) => group.map((value) => value - origin));
  let rawScale = centered.reduce(
    (maximum, group) => group.reduce((groupMaximum, value) => Math.max(groupMaximum, Math.abs(value)), maximum),
    0,
  );
  // 首点与另一观测异号且都接近 Number.MAX_VALUE 时，相减可能上溢；仅在该边界
  // 改用安全中点作原点，仍保持所有后续计算在离差坐标内。
  if (!Number.isFinite(rawScale)) {
    const minimum = all.reduce((value, observation) => Math.min(value, observation), Infinity);
    const maximum = all.reduce((value, observation) => Math.max(value, observation), -Infinity);
    origin = minimum / 2 + maximum / 2;
    centered = groups.map((group) => group.map((value) => value - origin));
    rawScale = centered.reduce(
      (value, group) => group.reduce((groupMaximum, observation) => Math.max(groupMaximum, Math.abs(observation)), value),
      0,
    );
  }
  // 2 的整数次幂缩放只调整 IEEE-754 指数位，不额外改变有效数字；任意十进制
  // scale 会在除法时再引入一轮舍入，削弱本应成立的换单位不变量。
  const scale = rawScale === 0 ? 0 : 2 ** Math.min(1023, Math.floor(Math.log2(rawScale)));
  const normalized = scale === 0
    ? groups.map((group) => group.map(() => 0))
    : centered.map((group) => group.map((value) => value / scale));
  const normalizedAll = normalized.flat();
  const normalizedGrand = mean(normalizedAll);
  const normalizedFactorSS = normalized.reduce(
    (sum, group) => sum + group.length * (mean(group) - normalizedGrand) ** 2,
    0,
  );
  const normalizedErrorSS = normalized.reduce((sum, group) => {
    const groupMean = mean(group);
    return sum + group.reduce((groupSum, value) => groupSum + (value - groupMean) ** 2, 0);
  }, 0);
  const scaleSquared = scale * scale;
  // 0 × Infinity 在 JS 中是 NaN；零平方和应保持精确 0，即使原始单位很大。
  const restoreScale = (sumOfSquares: number) => sumOfSquares === 0 ? 0 : sumOfSquares * scaleSquared;
  const factorSS = restoreScale(normalizedFactorSS);
  const errorSS = restoreScale(normalizedErrorSS);
  const factorDf = k - 1;
  const errorDf = N - k;
  const errorMS = errorSS / errorDf;
  const normalizedFactorMS = normalizedFactorSS / factorDf;
  const normalizedErrorMS = normalizedErrorSS / errorDf;
  // 组内零方差(完美一致):组间有差异 → 无穷显著(p=0);组间也无差异 → 无信息(p=1)。
  // 否则会得到 F=∞、p=NaN 而被误判为"不显著"。
  let fStat: number;
  let pValue: number;
  const noWithinVariation = groups.every((group) => group.every((value) => value === group[0]));
  if (noWithinVariation || normalizedErrorMS === 0) {
    const noBetweenVariation = groups.every((group) => group[0] === groups[0][0]);
    fStat = noBetweenVariation ? 0 : Infinity;
    pValue = noBetweenVariation ? 1 : 0;
  } else {
    fStat = normalizedFactorMS / normalizedErrorMS;
    pValue = 1 - fCdf(fStat, factorDf, errorDf);
  }
  return {
    factorDf,
    errorDf,
    totalDf: N - 1,
    factorSS,
    errorSS,
    totalSS: factorSS + errorSS,
    factorMS: factorSS / factorDf,
    errorMS,
    fStat,
    pValue,
    significant: pValue < 0.05,
  };
}

export interface AnovaGroupSummary {
  name: string;
  n: number;
  mean: number;
  stDev: number;
  /** 使用 ANOVA 合并误差 MSE 的均值置信区间，而不是各组各自方差。 */
  ciLow: number;
  ciHigh: number;
}

/** 单因子 ANOVA 的分组描述统计及合并误差置信区间。 */
export function anovaGroupSummaries(
  groups: AnovaGroup[],
  result: AnovaResult,
  confidence = 0.95,
): AnovaGroupSummary[] {
  if (!(confidence > 0 && confidence < 1)) throw new Error('置信水平必须在 0–1 之间');
  const critical = tInv(0.5 + confidence / 2, result.errorDf);
  return groups.map((group) => {
    const m = mean(group.vals);
    const stDev = Math.sqrt(group.vals.reduce((sum, value) => sum + (value - m) ** 2, 0) / (group.vals.length - 1));
    const margin = critical * Math.sqrt(result.errorMS / group.vals.length);
    return {
      name: group.name,
      n: group.vals.length,
      mean: m,
      stDev,
      ciLow: m - margin,
      ciHigh: m + margin,
    };
  });
}

export interface AnovaStructuredReport {
  kind: 'one-way-anova';
  responseName: string;
  factorName: string;
  confidence: number;
  alpha: number;
  sources: Array<{
    source: string;
    df: number;
    ss: number;
    ms: number | null;
    f: number | null;
    p: number | null;
  }>;
  groups: AnovaGroupSummary[];
  diagnostics: { fits: number[]; residuals: number[]; worksheetOrder: boolean };
  significant: boolean;
}

/**
 * 专项导出/历史记录可直接消费的 ANOVA 结构化结果。
 * 该函数不依赖统一 report.ts，也不包含任何演示数据或格式化字符串。
 */
export function buildAnovaStructuredReport(args: {
  responseName: string;
  factorName: string;
  groups: AnovaGroup[];
  confidence?: number;
}): AnovaStructuredReport {
  const confidence = args.confidence ?? 0.95;
  const result = oneWayAnova(args.groups.map((group) => group.vals));
  const hasWorksheetOrder = args.groups.every((group) => group.rowIndices?.length === group.vals.length);
  const diagnostics = anovaResiduals(
    args.groups.map((group) => group.vals),
    hasWorksheetOrder ? args.groups.map((group) => group.rowIndices!) : undefined,
  );
  return {
    kind: 'one-way-anova',
    responseName: args.responseName,
    factorName: args.factorName,
    confidence,
    alpha: 1 - confidence,
    sources: [
      { source: args.factorName, df: result.factorDf, ss: result.factorSS, ms: result.factorMS, f: result.fStat, p: result.pValue },
      { source: '误差', df: result.errorDf, ss: result.errorSS, ms: result.errorMS, f: null, p: null },
      { source: '合计', df: result.totalDf, ss: result.totalSS, ms: null, f: null, p: null },
    ],
    groups: anovaGroupSummaries(args.groups, result, confidence),
    diagnostics: { ...diagnostics, worksheetOrder: hasWorksheetOrder },
    significant: result.pValue < 1 - confidence,
  };
}

export interface AnovaGroup {
  name: string;
  vals: number[];
  /** 每个观测在原工作表中的行号，用于按实际采集顺序绘制残差图。 */
  rowIndices?: number[];
}
export type AnovaMode = 'stacked' | 'wide' | 'numfactor';

export interface AnovaNumericRoles {
  eligibleIdx: number[];
  factorIdx: number;
  respIdx: number;
  /** 因子至少有 2 个水平且每个水平至少 2 个观测。 */
  hasValidFactor: boolean;
}

/**
 * 为 ANOVA 数值因子模式解析变量角色。DOE 标准序/运行序/区组与分析输出列不参与候选；
 * 无显式选择时，响应取最后一个业务数值列，因子取第一个可构成有效重复分组的列。
 */
export function resolveAnovaNumericRoles(
  colNames: string[],
  rows: number[][],
  respName: string | null,
  factorName: string | null,
): AnovaNumericRoles {
  const eligibleIdx = colNames
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => isDoeAnalysisColumn(name))
    .map(({ index }) => index);
  const eligible = new Set(eligibleIdx);
  const namedResp = respName ? colNames.indexOf(respName) : -1;
  const respIdx = eligible.has(namedResp) ? namedResp : (eligibleIdx[eligibleIdx.length - 1] ?? -1);
  const validFactor = (index: number) => {
    if (!eligible.has(index) || index === respIdx) return false;
    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row[index], (counts.get(row[index]) ?? 0) + 1);
    return counts.size >= 2 && [...counts.values()].every((count) => count >= 2);
  };
  const namedFactor = factorName ? colNames.indexOf(factorName) : -1;
  const inferredFactor = eligibleIdx.find(validFactor);
  // 用户显式选了业务列时必须忠实保留：即使它不能构成有效分组，也应给出阻断提示，
  // 不能静默换成另一列后输出与选择不符的报表。只在选择为空/失效时自动推断。
  const namedFactorEligible = eligible.has(namedFactor) && namedFactor !== respIdx;
  const factorIdx = namedFactorEligible
    ? namedFactor
    : (inferredFactor ?? eligibleIdx.find((index) => index !== respIdx) ?? -1);
  return { eligibleIdx, factorIdx, respIdx, hasValidFactor: validFactor(factorIdx) };
}

/** 当持久化模式在新数据上不可用时，页面与项目摘要共用同一自动回落口径。 */
export function resolveAnovaMode(
  preferred: AnovaMode,
  colNames: string[],
  rows: number[][],
  textColumnCount: number,
  respName: string | null,
  factorName: string | null,
): AnovaMode | null {
  const roles = resolveAnovaNumericRoles(colNames, rows, respName, factorName);
  const canStacked = textColumnCount >= 1 && roles.eligibleIdx.length >= 1;
  const canWide = roles.eligibleIdx.length >= 2 && rows.length >= 2;
  const canNumFactor = roles.eligibleIdx.length >= 2;
  const modeOk = (mode: AnovaMode) => mode === 'stacked' ? canStacked : mode === 'wide' ? canWide : canNumFactor;
  if (modeOk(preferred)) return preferred;
  if (canStacked) return 'stacked';
  // 带重复水平的「因子 + 响应」长表优先走数值因子；普通多列连续测量则仍走宽表。
  if (canNumFactor && roles.hasValidFactor) return 'numfactor';
  if (canWide) return 'wide';
  return canNumFactor ? 'numfactor' : null;
}

/** 统计当前 ANOVA 实际使用列中的待录入单元格，避免把占位 0 当作观测计算 F/P。 */
export function countAnovaPendingCells(
  mode: AnovaMode,
  colNames: string[],
  rows: number[][],
  respName: string | null,
  factorName: string | null,
  pendingCells: Array<{ row: number; col: number }>,
): number {
  const roles = resolveAnovaNumericRoles(colNames, rows, respName, factorName);
  const relevant = mode === 'wide'
    ? new Set(roles.eligibleIdx)
    : mode === 'numfactor'
      ? new Set([roles.factorIdx, roles.respIdx])
      : new Set([roles.respIdx]);
  return pendingCells.filter((cell) => cell.row >= 0 && cell.row < rows.length && relevant.has(cell.col)).length;
}

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
  const roles = resolveAnovaNumericRoles(colNames, rows, respName, factorName);
  const nCol = roles.eligibleIdx.length;
  const idxOf = (name: string | null, fallback: number) => {
    const i = name ? colNames.indexOf(name) : -1;
    return i >= 0 ? i : fallback;
  };
  if (mode === 'wide') {
    if (nCol < 2) return null;
    return roles.eligibleIdx.map((j) => ({
      name: colNames[j],
      vals: rows.map((r) => r[j]),
      rowIndices: rows.map((_, i) => i),
    }));
  }
  if (mode === 'stacked') {
    const eligibleTextCols = textCols.filter((column) => isDoeAnalysisColumn(column.name));
    const tc = (factorName ? eligibleTextCols.find((t) => t.name === factorName) : eligibleTextCols[0]) ?? eligibleTextCols[0];
    if (!tc || nCol < 1) return null;
    const rIdx = roles.respIdx >= 0 ? roles.respIdx : idxOf(respName, 0);
    const byLabel = new Map<string, { vals: number[]; rowIndices: number[] }>();
    tc.values.forEach((l, i) => {
      if (!byLabel.has(l)) byLabel.set(l, { vals: [], rowIndices: [] });
      if (rows[i]) {
        byLabel.get(l)!.vals.push(rows[i][rIdx]);
        byLabel.get(l)!.rowIndices.push(i);
      }
    });
    const gs = [...byLabel.entries()].map(([name, data]) => ({ name, ...data }));
    return gs.length >= 2 && gs.every((g) => g.vals.length >= 2) ? gs : null;
  }
  // numfactor
  if (nCol < 2) return null;
  const fIdx = roles.factorIdx;
  const rIdx = roles.respIdx;
  if (fIdx === rIdx) return null;
  const byLevel = new Map<number, { vals: number[]; rowIndices: number[] }>();
  rows.forEach((r, i) => {
    const lv = r[fIdx];
    if (!byLevel.has(lv)) byLevel.set(lv, { vals: [], rowIndices: [] });
    byLevel.get(lv)!.vals.push(r[rIdx]);
    byLevel.get(lv)!.rowIndices.push(i);
  });
  const gs = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lv, data]) => ({ name: `${colNames[fIdx]}=${lv}`, ...data }));
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

/** 残差诊断数据:fits = 各观测所属组的均值,residuals = 观测 − 组均值。
 * 传入 rowIndices 时会恢复原工作表行序；未传时保持旧的按组展平语义。 */
export function anovaResiduals(
  groups: number[][],
  rowIndices?: number[][],
): { fits: number[]; residuals: number[] } {
  const observations: { fit: number; residual: number; row: number; serial: number }[] = [];
  let serial = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const m = mean(g);
    for (let i = 0; i < g.length; i++) {
      observations.push({
        fit: m,
        residual: g[i] - m,
        row: rowIndices?.[gi]?.[i] ?? serial,
        serial: serial++,
      });
    }
  }
  if (rowIndices) observations.sort((a, b) => a.row - b.row || a.serial - b.serial);
  return {
    fits: observations.map((o) => o.fit),
    residuals: observations.map((o) => o.residual),
  };
}
