/**
 * 变量数据模型 — 保存任意数值矩阵，并在行式子组大小 n=2..10 时计算
 * X̄-R / X̄-S；其他形态仍可用于 I-MR，随后由 SPC 数据角色层转换。
 */
import { CONTROL_CONSTANTS, c4Of } from './spc';
import { mean, rootMeanSquare, stdev } from './basicMath';

/** SPC 图 σ 估计方法（批次720-A1）：
 * 'classic' = R̄/d2（X̄-R）/ S̄/c4（X̄-S），是 Minitab 标准控制图的默认口径；
 * 'pooled' = 合并标准差 Sp/c4(d+1)，作为用户显式选择的备选估计方法。 */
export type SpcSigmaMethod = 'pooled' | 'classic';

export interface SubgroupRow {
  i: number; // 1-based
  vals: number[];
  mean: number;
  range: number;
}

export interface VarModel {
  name: string; // 工作表名（文件名）
  colNames: string[]; // 测量列名
  isDemo: boolean;
  k: number; // 子组数
  n: number; // 子组大小（1 = 单值数据）
  hasSubgroups: boolean; // n=2..10 才可直接作为行式子组用于 X̄-R / X̄-S
  subs: SubgroupRow[];
  all: number[]; // 全部观测（行优先展平）
  // X̄-R（限值按 sigmaMethod 估计的 σ̂ 计算；classic 时与 A2R̄/D3D4R̄ 逐位一致）
  xbarbar: number;
  rbar: number;
  rCl: number; // R 图中心线：classic=R̄；pooled=d2·σ̂
  uclX: number;
  lclX: number;
  uclR: number;
  lclR: number;
  // X̄-S
  svals: number[];
  sbar: number;
  sCl: number; // S 图中心线：classic=S̄；pooled=c4·σ̂
  uclXs: number;
  lclXs: number;
  uclS: number;
  lclS: number;
  c4: number;
  // σ
  sigmaMethod: SpcSigmaMethod; // 本模型图表限值实际使用的估计方法
  sigmaChart: number; // X̄-R/R 图口径 σ̂（随 sigmaMethod）；n=1 时 = iSig
  sigmaChartS: number; // X̄-S/S 图口径 σ̂（pooled 同 sigmaChart；classic = S̄/c4）
  sigmaPooled: number; // Sp/c4(d+1)（n≥2；n=1 为 NaN）
  sigmaWithin: number; // 能力链路沿用口径——n≥2: R̄/d2；n=1: MR̄/d2(2)。图表请用 sigmaChart
  oMean: number;
  oSd: number;
  // I-MR（n≥2 时为展平序列；演示数据可覆写为原型专用序列）
  indiv: number[];
  mr: (number | null)[];
  mrbar: number;
  indMean: number;
  iUcl: number;
  iLcl: number;
  mrUcl: number;
  iSig: number;
}

export interface NumericColumnSelection {
  index: number;
  name: string;
  values: number[];
}

/**
 * Resolve a user-facing numeric column by its stable worksheet name.
 *
 * `VarModel.all` is intentionally not used here: flattening a matrix is valid for
 * repeated measurements of one characteristic, but is dangerously wrong for a
 * normal worksheet containing unrelated variables (temperature, pressure, etc.).
 */
export function resolveNumericColumn(model: VarModel, requestedName: string | null | undefined): NumericColumnSelection {
  const requestedIndex = requestedName ? model.colNames.indexOf(requestedName) : -1;
  const index = requestedIndex >= 0 ? requestedIndex : 0;
  const name = model.colNames[index];
  if (name == null) throw new Error('当前工作表没有数值列');
  return {
    index,
    name,
    values: model.subs.map((row) => row.vals[index]),
  };
}

export function computeVarModel(
  name: string,
  colNames: string[],
  rows: number[][],
  opts?: { indivSeries?: number[]; isDemo?: boolean; sigmaMethod?: SpcSigmaMethod },
): VarModel {
  const sigmaMethod: SpcSigmaMethod = opts?.sigmaMethod ?? 'classic';
  const k = rows.length;
  const n = rows[0]?.length ?? 0;
  if (k < 2) throw new Error('至少需要 2 行数据');
  if (n < 1) throw new Error('至少需要 1 个数值列');
  // 超过 10 列时仍须允许导入：这些列可能代表“列式子组”，SPC 页面会先转置，
  // 不能在数据入口把合法的 20 个子组列误当作 n=20 的行式子组而拒绝。
  const hasMultipleValues = n >= 2;
  const hasSubgroups = hasMultipleValues && n <= 10;

  const subs: SubgroupRow[] = rows.map((vals, i) => ({
    i: i + 1,
    vals,
    mean: mean(vals),
    range: Math.max(...vals) - Math.min(...vals),
  }));
  const all = rows.flat();
  const oMean = mean(all);
  const oSd = stdev(all);

  const xbarbar = mean(subs.map((subgroup) => subgroup.mean));
  const rbar = mean(subs.map((subgroup) => subgroup.range));

  // 不支持的原始形态绝不借用 n=2 常数伪造子组限值。消费者必须先检查
  // hasSubgroups，或经 SPC 角色层转成真实 n=2..10 矩阵；NaN 使漏用能在测试/调试中立即暴露。
  const C = hasSubgroups ? CONTROL_CONSTANTS[n] : null;

  const svals = subs.map((s) => hasMultipleValues ? stdev(s.vals) : 0);
  const sbar = mean(svals);

  // 合并标准差 σ̂ = Sp/c4(d+1)，Sp²=Σ(nᵢ−1)sᵢ²/d，d=k(n−1)（显式可选口径，含 c4 无偏化）
  const dfPooled = hasSubgroups ? k * (n - 1) : 0;
  const sigmaPooled = C
    ? rootMeanSquare(svals) / c4Of(dfPooled + 1)
    : Number.NaN;

  // 图表口径 σ̂：pooled 统一用合并标准差；classic 分别为 R̄/d2（X̄-R 对）与 S̄/c4（X̄-S 对）。
  // classic 分支代回公式后与 A2R̄ / D3·D4·R̄ / A3S̄ / B3·B4·S̄ 恒等。
  const sigmaChartSub = C ? (sigmaMethod === 'pooled' ? sigmaPooled : rbar / C.d2) : Number.NaN;
  const sigmaChartS = C ? (sigmaMethod === 'pooled' ? sigmaPooled : sbar / C.c4) : Number.NaN;

  const uclX = C ? xbarbar + (3 * sigmaChartSub) / Math.sqrt(n) : Number.NaN;
  const lclX = C ? xbarbar - (3 * sigmaChartSub) / Math.sqrt(n) : Number.NaN;
  // R 图：CL=d2σ̂（classic 时 = R̄），UCL/LCL = CL ± 3d3σ̂（LCL 截 0）
  const rCl = C ? (sigmaMethod === 'pooled' ? C.d2 * sigmaChartSub : rbar) : Number.NaN;
  const uclR = C ? rCl + 3 * C.d3 * sigmaChartSub : Number.NaN;
  const lclR = C ? Math.max(0, rCl - 3 * C.d3 * sigmaChartSub) : Number.NaN;

  const uclXs = C ? xbarbar + (3 * sigmaChartS) / Math.sqrt(n) : Number.NaN;
  const lclXs = C ? xbarbar - (3 * sigmaChartS) / Math.sqrt(n) : Number.NaN;
  // S 图：CL=c4σ̂（classic 时 = S̄），UCL/LCL = CL ± 3σ̂√(1−c4²)（LCL 截 0）
  const sCl = C ? (sigmaMethod === 'pooled' ? C.c4 * sigmaChartS : sbar) : Number.NaN;
  const uclS = C ? sCl + 3 * sigmaChartS * Math.sqrt(1 - C.c4 * C.c4) : Number.NaN;
  const lclS = C ? Math.max(0, sCl - 3 * sigmaChartS * Math.sqrt(1 - C.c4 * C.c4)) : Number.NaN;

  // I-MR：默认用展平序列（导入数据）；演示数据可传原型专用序列。
  // 与 Minitab 公布的基础常数一致：d2(2)=1.128、d3(2)=0.8525；D4 由基础常数按公式派生。
  const C2 = CONTROL_CONSTANTS[2];
  const indiv = opts?.indivSeries ?? all;
  const mr = indiv.map((v, i) => (i === 0 ? null : Math.abs(v - indiv[i - 1])));
  const mrbar = mean(mr.slice(1) as number[]);
  const indMean = mean(indiv);
  const iSig = mrbar / C2.d2;
  const iUcl = indMean + 3 * iSig;
  const iLcl = indMean - 3 * iSig;
  const mrUcl = C2.D4 * mrbar;

  const sigmaWithin = C ? rbar / C.d2 : iSig;
  const sigmaChart = C ? sigmaChartSub : iSig;

  return {
    name, colNames, isDemo: opts?.isDemo ?? false, k, n, hasSubgroups, subs, all,
    xbarbar, rbar, rCl, uclX, lclX, uclR, lclR,
    svals, sbar, sCl, uclXs, lclXs, uclS, lclS, c4: C?.c4 ?? Number.NaN,
    sigmaMethod, sigmaChart, sigmaChartS, sigmaPooled,
    sigmaWithin, oMean, oSd,
    indiv, mr, mrbar, indMean, iUcl, iLcl, mrUcl, iSig,
  };
}

/** 用另一种 σ 估计方法重派生图表限值（不重算数据层字段）。
 * SPC 页/历史回放切换方法时使用——模型构建点分布在数据层各处，
 * 方法是分析选项而非数据属性，不应穿透所有构建点。 */
export function withSigmaMethod(m: VarModel, method: SpcSigmaMethod | undefined): VarModel {
  const target: SpcSigmaMethod = method ?? 'classic';
  if (!m.hasSubgroups || target === m.sigmaMethod) return m;
  const C = CONTROL_CONSTANTS[m.n];
  const sigmaChart = target === 'pooled' ? m.sigmaPooled : m.rbar / C.d2;
  const sigmaChartS = target === 'pooled' ? m.sigmaPooled : m.sbar / C.c4;
  const rCl = target === 'pooled' ? C.d2 * sigmaChart : m.rbar;
  const sCl = target === 'pooled' ? C.c4 * sigmaChartS : m.sbar;
  return {
    ...m,
    sigmaMethod: target,
    sigmaChart,
    sigmaChartS,
    uclX: m.xbarbar + (3 * sigmaChart) / Math.sqrt(m.n),
    lclX: m.xbarbar - (3 * sigmaChart) / Math.sqrt(m.n),
    rCl,
    uclR: rCl + 3 * C.d3 * sigmaChart,
    lclR: Math.max(0, rCl - 3 * C.d3 * sigmaChart),
    uclXs: m.xbarbar + (3 * sigmaChartS) / Math.sqrt(m.n),
    lclXs: m.xbarbar - (3 * sigmaChartS) / Math.sqrt(m.n),
    sCl,
    uclS: sCl + 3 * sigmaChartS * Math.sqrt(1 - C.c4 * C.c4),
    lclS: Math.max(0, sCl - 3 * sigmaChartS * Math.sqrt(1 - C.c4 * C.c4)),
  };
}
