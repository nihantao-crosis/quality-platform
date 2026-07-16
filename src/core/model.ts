/**
 * 变量数据模型 — 保存任意数值矩阵，并在行式子组大小 n=2..10 时计算
 * X̄-R / X̄-S；其他形态仍可用于 I-MR，随后由 SPC 数据角色层转换。
 */
import { CONTROL_CONSTANTS } from './spc';

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
  // X̄-R
  xbarbar: number;
  rbar: number;
  uclX: number;
  lclX: number;
  uclR: number;
  lclR: number;
  // X̄-S
  svals: number[];
  sbar: number;
  uclXs: number;
  lclXs: number;
  uclS: number;
  lclS: number;
  c4: number;
  // σ
  sigmaWithin: number; // n≥2: R̄/d2；n=1: MR̄/1.128
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
  opts?: { indivSeries?: number[]; isDemo?: boolean },
): VarModel {
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
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    range: Math.max(...vals) - Math.min(...vals),
  }));
  const all = rows.flat();
  const oMean = all.reduce((a, b) => a + b, 0) / all.length;
  const oSd = Math.sqrt(all.reduce((a, b) => a + (b - oMean) ** 2, 0) / (all.length - 1));

  const xbarbar = subs.reduce((a, s) => a + s.mean, 0) / k;
  const rbar = subs.reduce((a, s) => a + s.range, 0) / k;

  // 不支持的原始形态绝不借用 n=2 常数伪造子组限值。消费者必须先检查
  // hasSubgroups，或经 SPC 角色层转成真实 n=2..10 矩阵；NaN 使漏用能在测试/调试中立即暴露。
  const C = hasSubgroups ? CONTROL_CONSTANTS[n] : null;
  const uclX = C ? xbarbar + C.A2 * rbar : Number.NaN;
  const lclX = C ? xbarbar - C.A2 * rbar : Number.NaN;
  const uclR = C ? C.D4 * rbar : Number.NaN;
  const lclR = C ? C.D3 * rbar : Number.NaN;

  const svals = subs.map((s) =>
    hasMultipleValues ? Math.sqrt(s.vals.reduce((a, b) => a + (b - s.mean) ** 2, 0) / (n - 1)) : 0,
  );
  const sbar = svals.reduce((a, b) => a + b, 0) / svals.length;
  const uclXs = C ? xbarbar + C.A3 * sbar : Number.NaN;
  const lclXs = C ? xbarbar - C.A3 * sbar : Number.NaN;
  const uclS = C ? C.B4 * sbar : Number.NaN;
  const lclS = C ? C.B3 * sbar : Number.NaN;

  // I-MR：默认用展平序列（导入数据）；演示数据可传原型专用序列
  const indiv = opts?.indivSeries ?? all;
  const mr = indiv.map((v, i) => (i === 0 ? null : Math.abs(v - indiv[i - 1])));
  const mrbar = (mr.slice(1) as number[]).reduce((a, b) => a + b, 0) / Math.max(1, indiv.length - 1);
  const indMean = indiv.reduce((a, b) => a + b, 0) / indiv.length;
  const iSig = mrbar / 1.128;
  const iUcl = indMean + 3 * iSig;
  const iLcl = indMean - 3 * iSig;
  const mrUcl = 3.267 * mrbar;

  const sigmaWithin = C ? rbar / C.d2 : iSig;

  return {
    name, colNames, isDemo: opts?.isDemo ?? false, k, n, hasSubgroups, subs, all,
    xbarbar, rbar, uclX, lclX, uclR, lclR,
    svals, sbar, uclXs, lclXs, uclS, lclS, c4: C?.c4 ?? Number.NaN,
    sigmaWithin, oMean, oSd,
    indiv, mr, mrbar, indMean, iUcl, iLcl, mrUcl, iSig,
  };
}
