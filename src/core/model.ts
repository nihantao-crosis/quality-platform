/**
 * 变量数据模型 — 保存任意数值矩阵，并在行式子组大小 n=2..10 时计算
 * X̄-R / X̄-S；其他形态仍可用于 I-MR，随后由 SPC 数据角色层转换。
 */
import { CONTROL_CONSTANTS, c4Of } from './spc';
import { expansionSumFrom, mean, rootMeanSquare, stdev } from './basicMath';

/**
 * Only move to a common coordinate system when ordinary arithmetic can approach
 * the Number boundary.  Keeping scale=1 for normal data preserves the existing
 * bit-for-bit calculation path, while the power-of-two extreme scale makes
 * division/multiplication exact exponent shifts.
 */
const EXTREME_COORDINATE_THRESHOLD = Number.MAX_VALUE / 16;

function coordinateScaleForMaximum(maximum: number): number {
  if (!Number.isFinite(maximum) || maximum <= EXTREME_COORDINATE_THRESHOLD) return 1;
  return 2 ** Math.min(1023, Math.floor(Math.log2(maximum)));
}

export function commonCoordinateScale(series: readonly number[][], additional?: readonly number[]): number {
  let maximum = 0;
  for (const values of series) {
    for (const value of values) {
      const magnitude = Math.abs(value);
      if (magnitude > maximum) maximum = magnitude;
    }
  }
  if (additional) {
    for (const value of additional) {
      const magnitude = Math.abs(value);
      if (magnitude > maximum) maximum = magnitude;
    }
  }
  return coordinateScaleForMaximum(maximum);
}

function flatCoordinateScale(values: readonly number[], additional?: readonly number[]): number {
  let maximum = 0;
  // 索引循环:单格编辑热点(20 万行×多列每次扫全部值),比 for…of 快约 4×,取值与次序相同
  for (let index = 0; index < values.length; index++) {
    const magnitude = Math.abs(values[index]);
    if (magnitude > maximum) maximum = magnitude;
  }
  if (additional) {
    for (let index = 0; index < additional.length; index++) {
      const magnitude = Math.abs(additional[index]);
      if (magnitude > maximum) maximum = magnitude;
    }
  }
  return coordinateScaleForMaximum(maximum);
}

/** Restore a derived coordinate to the source unit without emitting infinity. */
export function restoreCoordinate(value: number, scale: number): number {
  if (Number.isNaN(value)) return Number.NaN;
  if (value === 0) return value;
  const restored = value * scale;
  if (Number.isFinite(restored)) return restored;
  return value < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

function coordinateRange(values: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return hi - lo;
}

/** mean(xs.slice(start)) 的无中间数组版；与 basicMath.mean 共用同一展开求和内核,逐位一致。 */
function finiteTailMean(values: readonly number[], start: number): number {
  const count = values.length - start;
  if (count <= 0) return Number.NaN;
  const unscaled = expansionSumFrom(values, start);
  if (Number.isFinite(unscaled)) return unscaled / count;
  let maximum = 0;
  for (let index = start; index < values.length; index++) {
    const magnitude = Math.abs(values[index]);
    if (magnitude > maximum) maximum = magnitude;
  }
  if (maximum === 0) return 0;
  const normalized = expansionSumFrom(values, start, maximum);
  const restored = normalized * maximum;
  return Number.isFinite(restored) ? restored / count : (normalized / count) * maximum;
}

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

  const all = rows.flat();
  // I-MR 的专用序列也必须参与同一坐标尺度；否则 rows 很小而
  // indivSeries 含 ±MAX 时，移动极差仍会在求差的第一步溢出。
  const indiv = opts?.indivSeries ?? all;
  const coordinateScale = commonCoordinateScale(rows, indiv === all ? undefined : indiv);
  const coordinateRows = coordinateScale === 1
    ? rows
    : rows.map((vals) => vals.map((value) => value / coordinateScale));
  const coordinateAll = coordinateScale === 1
    ? all
    : all.map((value) => value / coordinateScale);
  const coordinateIndiv = coordinateScale === 1
    ? indiv
    : indiv.map((value) => value / coordinateScale);
  const subgroupMeans = coordinateRows.map((vals) => mean(vals));
  const subgroupRanges = coordinateRows.map((vals) => coordinateRange(vals));

  const subs: SubgroupRow[] = rows.map((vals, i) => ({
    i: i + 1,
    vals,
    mean: restoreCoordinate(subgroupMeans[i], coordinateScale),
    // 单个子组的真实极差可能超出 Number，对外字段可饱和；
    // R̄ 必须在未饱和的缩放域极差上求平均。
    range: restoreCoordinate(subgroupRanges[i], coordinateScale),
  }));
  const oMeanCoordinate = mean(coordinateAll);
  const oSdCoordinate = stdev(coordinateAll);
  const oMean = restoreCoordinate(oMeanCoordinate, coordinateScale);
  const oSd = restoreCoordinate(oSdCoordinate, coordinateScale);

  const xbarbarCoordinate = mean(subgroupMeans);
  const rbarCoordinate = mean(subgroupRanges);
  const xbarbar = restoreCoordinate(xbarbarCoordinate, coordinateScale);
  const rbar = restoreCoordinate(rbarCoordinate, coordinateScale);

  // 不支持的原始形态绝不借用 n=2 常数伪造子组限值。消费者必须先检查
  // hasSubgroups，或经 SPC 角色层转成真实 n=2..10 矩阵；NaN 使漏用能在测试/调试中立即暴露。
  const C = hasSubgroups ? CONTROL_CONSTANTS[n] : null;

  const svalsCoordinate = coordinateRows.map((vals) => hasMultipleValues ? stdev(vals) : 0);
  const svals = svalsCoordinate.map((value) => restoreCoordinate(value, coordinateScale));
  const sbarCoordinate = mean(svalsCoordinate);
  const sbar = restoreCoordinate(sbarCoordinate, coordinateScale);

  // 合并标准差 σ̂ = Sp/c4(d+1)，Sp²=Σ(nᵢ−1)sᵢ²/d，d=k(n−1)（显式可选口径，含 c4 无偏化）
  const dfPooled = hasSubgroups ? k * (n - 1) : 0;
  const sigmaPooledCoordinate = C
    ? rootMeanSquare(svalsCoordinate) / c4Of(dfPooled + 1)
    : Number.NaN;
  const sigmaPooled = C
    ? restoreCoordinate(sigmaPooledCoordinate, coordinateScale)
    : Number.NaN;

  // 图表口径 σ̂：pooled 统一用合并标准差；classic 分别为 R̄/d2（X̄-R 对）与 S̄/c4（X̄-S 对）。
  // classic 分支代回公式后与 A2R̄ / D3·D4·R̄ / A3S̄ / B3·B4·S̄ 恒等。
  const sigmaChartSubCoordinate = C
    ? (sigmaMethod === 'pooled' ? sigmaPooledCoordinate : rbarCoordinate / C.d2)
    : Number.NaN;
  const sigmaChartSCoordinate = C
    ? (sigmaMethod === 'pooled' ? sigmaPooledCoordinate : sbarCoordinate / C.c4)
    : Number.NaN;
  const sigmaChartSub = C ? restoreCoordinate(sigmaChartSubCoordinate, coordinateScale) : Number.NaN;
  const sigmaChartS = C ? restoreCoordinate(sigmaChartSCoordinate, coordinateScale) : Number.NaN;

  const uclX = C
    ? restoreCoordinate(xbarbarCoordinate + (3 * sigmaChartSubCoordinate) / Math.sqrt(n), coordinateScale)
    : Number.NaN;
  const lclX = C
    ? restoreCoordinate(xbarbarCoordinate - (3 * sigmaChartSubCoordinate) / Math.sqrt(n), coordinateScale)
    : Number.NaN;
  // R 图：CL=d2σ̂（classic 时 = R̄），UCL/LCL = CL ± 3d3σ̂（LCL 截 0）
  const rClCoordinate = C
    ? (sigmaMethod === 'pooled' ? C.d2 * sigmaChartSubCoordinate : rbarCoordinate)
    : Number.NaN;
  const rCl = C ? restoreCoordinate(rClCoordinate, coordinateScale) : Number.NaN;
  const uclR = C
    ? restoreCoordinate(rClCoordinate + 3 * C.d3 * sigmaChartSubCoordinate, coordinateScale)
    : Number.NaN;
  const lclR = C
    ? restoreCoordinate(Math.max(0, rClCoordinate - 3 * C.d3 * sigmaChartSubCoordinate), coordinateScale)
    : Number.NaN;

  const uclXs = C
    ? restoreCoordinate(xbarbarCoordinate + (3 * sigmaChartSCoordinate) / Math.sqrt(n), coordinateScale)
    : Number.NaN;
  const lclXs = C
    ? restoreCoordinate(xbarbarCoordinate - (3 * sigmaChartSCoordinate) / Math.sqrt(n), coordinateScale)
    : Number.NaN;
  // S 图：CL=c4σ̂（classic 时 = S̄），UCL/LCL = CL ± 3σ̂√(1−c4²)（LCL 截 0）
  const sClCoordinate = C
    ? (sigmaMethod === 'pooled' ? C.c4 * sigmaChartSCoordinate : sbarCoordinate)
    : Number.NaN;
  const sCl = C ? restoreCoordinate(sClCoordinate, coordinateScale) : Number.NaN;
  const uclS = C
    ? restoreCoordinate(sClCoordinate + 3 * sigmaChartSCoordinate * Math.sqrt(1 - C.c4 * C.c4), coordinateScale)
    : Number.NaN;
  const lclS = C
    ? restoreCoordinate(
        Math.max(0, sClCoordinate - 3 * sigmaChartSCoordinate * Math.sqrt(1 - C.c4 * C.c4)),
        coordinateScale,
      )
    : Number.NaN;

  // I-MR：默认用展平序列（导入数据）；演示数据可传原型专用序列。
  // 与 Minitab 公布的基础常数一致：d2(2)=1.128、d3(2)=0.8525；D4 由基础常数按公式派生。
  const C2 = CONTROL_CONSTANTS[2];
  const mrCoordinate = coordinateIndiv.map((v, i) => (
    i === 0 ? null : Math.abs(v - coordinateIndiv[i - 1])
  ));
  const mr = mrCoordinate.map((value) => (
    value == null ? null : restoreCoordinate(value, coordinateScale)
  ));
  const mrbarCoordinate = mean(mrCoordinate.slice(1) as number[]);
  const indMeanCoordinate = mean(coordinateIndiv);
  const iSigCoordinate = mrbarCoordinate / C2.d2;
  const mrbar = restoreCoordinate(mrbarCoordinate, coordinateScale);
  const indMean = restoreCoordinate(indMeanCoordinate, coordinateScale);
  const iSig = restoreCoordinate(iSigCoordinate, coordinateScale);
  const iUcl = restoreCoordinate(indMeanCoordinate + 3 * iSigCoordinate, coordinateScale);
  const iLcl = restoreCoordinate(indMeanCoordinate - 3 * iSigCoordinate, coordinateScale);
  const mrUcl = restoreCoordinate(C2.D4 * mrbarCoordinate, coordinateScale);

  const sigmaWithin = C
    ? restoreCoordinate(rbarCoordinate / C.d2, coordinateScale)
    : iSig;
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

export interface VarModelCellUpdateOptions {
  /** 编辑演示表另存副本时，由 store 传入新名称。 */
  name?: string;
  /** 省略时保留原模型标记；传 false 可把演示副本转为真实数据。 */
  isDemo?: boolean;
  /**
   * 省略：保留原模型的 I-MR 语义（普通模型仍与 all 共享，专用序列则不变）；
   * null：改用编辑后的行优先 all；数组：改用该专用序列。
   */
  indivSeries?: number[] | null;
}

interface IndividualFields {
  indiv: number[];
  mr: (number | null)[];
  mrbar: number;
  indMean: number;
  iUcl: number;
  iLcl: number;
  mrUcl: number;
  iSig: number;
}

function resolveUpdatedIndividuals(
  model: VarModel,
  all: number[],
  flatIndex: number,
  options: VarModelCellUpdateOptions | undefined,
  allMean: number,
): { fields: IndividualFields; explicitSeries: boolean } {
  const explicitSeries = options != null
    && Object.prototype.hasOwnProperty.call(options, 'indivSeries');
  let indiv: number[];
  let mayPatchMovingRanges = false;
  let unchangedDistinctSeries = false;
  if (explicitSeries) {
    const requested = options!.indivSeries;
    if (requested == null) {
      indiv = all;
      mayPatchMovingRanges = model.indiv === model.all;
    } else {
      if (requested.length < 2 || requested.some((value) => !Number.isFinite(value))) {
        throw new RangeError('I-MR 专用序列必须是至少 2 项的有限数组');
      }
      indiv = [...requested];
    }
  } else if (model.indiv === model.all) {
    indiv = all;
    mayPatchMovingRanges = true;
  } else {
    indiv = model.indiv;
    unchangedDistinctSeries = true;
  }

  if (unchangedDistinctSeries) {
    return {
      explicitSeries,
      fields: {
        indiv,
        mr: model.mr,
        mrbar: model.mrbar,
        indMean: model.indMean,
        iUcl: model.iUcl,
        iLcl: model.iLcl,
        mrUcl: model.mrUcl,
        iSig: model.iSig,
      },
    };
  }

  let mr: (number | null)[];
  if (mayPatchMovingRanges && model.mr.length === indiv.length) {
    mr = model.mr.slice();
    for (const index of [flatIndex, flatIndex + 1]) {
      if (index > 0 && index < indiv.length) mr[index] = Math.abs(indiv[index] - indiv[index - 1]);
    }
  } else {
    mr = indiv.map((value, index) => (
      index === 0 ? null : Math.abs(value - indiv[index - 1])
    ));
  }
  const C2 = CONTROL_CONSTANTS[2];
  const mrbar = finiteTailMean(mr as number[], 1);
  const indMean = indiv === all ? allMean : mean(indiv);
  const iSig = mrbar / C2.d2;
  return {
    explicitSeries,
    fields: {
      indiv,
      mr,
      mrbar,
      indMean,
      iUcl: indMean + 3 * iSig,
      iLcl: indMean - 3 * iSig,
      mrUcl: C2.D4 * mrbar,
      iSig,
    },
  };
}

/**
 * Copy-on-write 更新 VarModel 的一个单元格。
 *
 * 常规数据只重建被改子组，其他 `SubgroupRow`/`vals` 保持引用；`all`
 * 以及与它同源的 `indiv` 只拷贝一次。稳定均值/标准差/R̄/MR̄ 仍从更新后
 * 全序列聚合，不使用会累积漂移的「旧总和 ± 单点」。跨入极值坐标域时回落
 * `computeVarModel`，保证 ±MAX 缩放与有限饱和契约完全同源。
 */
export function updateVarModelCell(
  model: VarModel,
  row: number,
  col: number,
  value: number,
  options?: VarModelCellUpdateOptions,
): VarModel {
  if (!Number.isFinite(value)) throw new RangeError('单元格值必须是有限数');
  if (!Number.isInteger(row) || row < 0 || row >= model.k) throw new RangeError('单元格行索引越界');
  if (!Number.isInteger(col) || col < 0 || col >= model.n) throw new RangeError('单元格列索引越界');

  const name = options?.name ?? model.name;
  const isDemo = options?.isDemo ?? model.isDemo;
  const explicitSeries = options != null
    && Object.prototype.hasOwnProperty.call(options, 'indivSeries');
  if (
    Object.is(value, model.subs[row].vals[col])
    && name === model.name
    && isDemo === model.isDemo
    && !explicitSeries
  ) return model;

  const flatIndex = row * model.n + col;
  const all = model.all.slice();
  all[flatIndex] = value;
  const oMean = mean(all);
  const individual = resolveUpdatedIndividuals(model, all, flatIndex, options, oMean);

  // 坐标尺度只取决于全部值的最大绝对值。all 就是编辑后按行展平的全部单元格,
  // 与 rows 同一值集合,故对任意 n 都直接扫扁平 all(GAP-10-24:多列不再为
  // 20 万个子组重建 rows 引用数组与被改行副本)。
  const scale = flatCoordinateScale(
    all,
    individual.fields.indiv === all ? undefined : individual.fields.indiv,
  );

  if (scale !== 1) {
    const rows = model.subs.map((subgroup) => subgroup.vals);
    rows[row] = [...rows[row]];
    rows[row][col] = value;
    const rebuilt = computeVarModel(name, model.colNames, rows, {
      isDemo,
      sigmaMethod: model.sigmaMethod,
      indivSeries: individual.fields.indiv === all ? undefined : individual.fields.indiv,
    });
    // 缩放域可能因本次编辑改变；仅在派生值仍逐位一致时复用未变子组。
    for (let index = 0; index < rebuilt.subs.length; index++) {
      if (index === row) continue;
      const before = model.subs[index];
      const after = rebuilt.subs[index];
      if (before.mean === after.mean && before.range === after.range && before.vals === after.vals) {
        rebuilt.subs[index] = before;
      }
    }
    return rebuilt;
  }

  const subs = model.subs.slice();
  const vals = [...subs[row].vals];
  vals[col] = value;
  subs[row] = {
    i: row + 1,
    vals,
    mean: mean(vals),
    range: coordinateRange(vals),
  };
  const oSd = stdev(all);

  if (model.n === 1) {
    const fields = individual.fields.indiv === all
      ? { ...individual.fields, indMean: oMean }
      : individual.fields;
    return {
      ...model,
      name,
      isDemo,
      subs,
      all,
      xbarbar: oMean,
      rbar: 0,
      rCl: Number.NaN,
      uclX: Number.NaN,
      lclX: Number.NaN,
      uclR: Number.NaN,
      lclR: Number.NaN,
      svals: model.svals,
      sbar: 0,
      sCl: Number.NaN,
      uclXs: Number.NaN,
      lclXs: Number.NaN,
      uclS: Number.NaN,
      lclS: Number.NaN,
      sigmaChart: fields.iSig,
      sigmaChartS: Number.NaN,
      sigmaPooled: Number.NaN,
      sigmaWithin: fields.iSig,
      oMean,
      oSd,
      ...fields,
    };
  }

  const subgroupMeans = subs.map((subgroup) => subgroup.mean);
  const subgroupRanges = subs.map((subgroup) => subgroup.range);
  const svals = model.svals.slice();
  svals[row] = stdev(vals);
  const xbarbar = mean(subgroupMeans);
  const rbar = mean(subgroupRanges);
  const sbar = mean(svals);
  const C = model.hasSubgroups ? CONTROL_CONSTANTS[model.n] : null;
  const dfPooled = model.hasSubgroups ? model.k * (model.n - 1) : 0;
  const sigmaPooled = C
    ? rootMeanSquare(svals) / c4Of(dfPooled + 1)
    : Number.NaN;
  const sigmaChart = C
    ? (model.sigmaMethod === 'pooled' ? sigmaPooled : rbar / C.d2)
    : individual.fields.iSig;
  const sigmaChartS = C
    ? (model.sigmaMethod === 'pooled' ? sigmaPooled : sbar / C.c4)
    : Number.NaN;
  const rCl = C
    ? (model.sigmaMethod === 'pooled' ? C.d2 * sigmaChart : rbar)
    : Number.NaN;
  const sCl = C
    ? (model.sigmaMethod === 'pooled' ? C.c4 * sigmaChartS : sbar)
    : Number.NaN;
  const sSpread = C ? 3 * sigmaChartS * Math.sqrt(1 - C.c4 * C.c4) : Number.NaN;

  return {
    ...model,
    name,
    isDemo,
    subs,
    all,
    xbarbar,
    rbar,
    rCl,
    uclX: C ? xbarbar + (3 * sigmaChart) / Math.sqrt(model.n) : Number.NaN,
    lclX: C ? xbarbar - (3 * sigmaChart) / Math.sqrt(model.n) : Number.NaN,
    uclR: C ? rCl + 3 * C.d3 * sigmaChart : Number.NaN,
    lclR: C ? Math.max(0, rCl - 3 * C.d3 * sigmaChart) : Number.NaN,
    svals,
    sbar,
    sCl,
    uclXs: C ? xbarbar + (3 * sigmaChartS) / Math.sqrt(model.n) : Number.NaN,
    lclXs: C ? xbarbar - (3 * sigmaChartS) / Math.sqrt(model.n) : Number.NaN,
    uclS: C ? sCl + sSpread : Number.NaN,
    lclS: C ? Math.max(0, sCl - sSpread) : Number.NaN,
    sigmaChart,
    sigmaChartS,
    sigmaPooled,
    sigmaWithin: C ? rbar / C.d2 : individual.fields.iSig,
    oMean,
    oSd,
    ...individual.fields,
  };
}

/** 用另一种 σ 估计方法重派生图表限值（不重算数据层字段）。
 * SPC 页/历史回放切换方法时使用——模型构建点分布在数据层各处，
 * 方法是分析选项而非数据属性，不应穿透所有构建点。 */
export function withSigmaMethod(m: VarModel, method: SpcSigmaMethod | undefined): VarModel {
  const target: SpcSigmaMethod = method ?? 'classic';
  if (!m.hasSubgroups || target === m.sigmaMethod) return m;
  const C = CONTROL_CONSTANTS[m.n];

  // 极值模型的单个 range/s 字段可能已经按对外契约饱和，不能拿它们
  // 反推另一种 σ 口径。此时从原始子组在同一坐标尺度上重聚合；
  // 常规数据仍保留原来的逐位路径。
  const coordinateScale = commonCoordinateScale([...m.subs.map((subgroup) => subgroup.vals), m.indiv]);
  if (coordinateScale !== 1) {
    const rows = m.subs.map((subgroup) => subgroup.vals.map((value) => value / coordinateScale));
    const subgroupMeans = rows.map((values) => mean(values));
    const subgroupRanges = rows.map((values) => coordinateRange(values));
    const subgroupS = rows.map((values) => stdev(values));
    const xbarbarCoordinate = mean(subgroupMeans);
    const rbarCoordinate = mean(subgroupRanges);
    const sbarCoordinate = mean(subgroupS);
    const sigmaPooledCoordinate = rootMeanSquare(subgroupS) / c4Of(m.k * (m.n - 1) + 1);
    const sigmaChartCoordinate = target === 'pooled'
      ? sigmaPooledCoordinate
      : rbarCoordinate / C.d2;
    const sigmaChartSCoordinate = target === 'pooled'
      ? sigmaPooledCoordinate
      : sbarCoordinate / C.c4;
    const rClCoordinate = target === 'pooled' ? C.d2 * sigmaChartCoordinate : rbarCoordinate;
    const sClCoordinate = target === 'pooled' ? C.c4 * sigmaChartSCoordinate : sbarCoordinate;
    const sSpreadCoordinate = 3 * sigmaChartSCoordinate * Math.sqrt(1 - C.c4 * C.c4);
    return {
      ...m,
      sigmaMethod: target,
      sigmaChart: restoreCoordinate(sigmaChartCoordinate, coordinateScale),
      sigmaChartS: restoreCoordinate(sigmaChartSCoordinate, coordinateScale),
      uclX: restoreCoordinate(
        xbarbarCoordinate + (3 * sigmaChartCoordinate) / Math.sqrt(m.n),
        coordinateScale,
      ),
      lclX: restoreCoordinate(
        xbarbarCoordinate - (3 * sigmaChartCoordinate) / Math.sqrt(m.n),
        coordinateScale,
      ),
      rCl: restoreCoordinate(rClCoordinate, coordinateScale),
      uclR: restoreCoordinate(rClCoordinate + 3 * C.d3 * sigmaChartCoordinate, coordinateScale),
      lclR: restoreCoordinate(
        Math.max(0, rClCoordinate - 3 * C.d3 * sigmaChartCoordinate),
        coordinateScale,
      ),
      uclXs: restoreCoordinate(
        xbarbarCoordinate + (3 * sigmaChartSCoordinate) / Math.sqrt(m.n),
        coordinateScale,
      ),
      lclXs: restoreCoordinate(
        xbarbarCoordinate - (3 * sigmaChartSCoordinate) / Math.sqrt(m.n),
        coordinateScale,
      ),
      sCl: restoreCoordinate(sClCoordinate, coordinateScale),
      uclS: restoreCoordinate(sClCoordinate + sSpreadCoordinate, coordinateScale),
      lclS: restoreCoordinate(Math.max(0, sClCoordinate - sSpreadCoordinate), coordinateScale),
    };
  }
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
