/**
 * 变量数据模型 — 从任意测量矩阵（k 子组 × n 测量，n=1..10）实时计算
 * X̄-R / X̄-S / I-MR 全套统计量。演示与导入数据共用此模型。
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
  hasSubgroups: boolean; // n ≥ 2 才有 X̄-R / X̄-S
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

export function computeVarModel(
  name: string,
  colNames: string[],
  rows: number[][],
  opts?: { indivSeries?: number[]; isDemo?: boolean },
): VarModel {
  const k = rows.length;
  const n = rows[0]?.length ?? 0;
  if (k < 2) throw new Error('至少需要 2 行数据');
  if (n < 1 || n > 10) throw new Error('子组大小需在 1–10 之间（控制图常数表范围）');
  const hasSubgroups = n >= 2;

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

  const C = hasSubgroups ? CONTROL_CONSTANTS[n] : CONTROL_CONSTANTS[2];
  const uclX = xbarbar + C.A2 * rbar;
  const lclX = xbarbar - C.A2 * rbar;
  const uclR = C.D4 * rbar;
  const lclR = C.D3 * rbar;

  const svals = subs.map((s) =>
    hasSubgroups ? Math.sqrt(s.vals.reduce((a, b) => a + (b - s.mean) ** 2, 0) / (n - 1)) : 0,
  );
  const sbar = svals.reduce((a, b) => a + b, 0) / svals.length;
  const uclXs = xbarbar + C.A3 * sbar;
  const lclXs = xbarbar - C.A3 * sbar;
  const uclS = C.B4 * sbar;
  const lclS = C.B3 * sbar;

  // I-MR：默认用展平序列（导入数据）；演示数据可传原型专用序列
  const indiv = opts?.indivSeries ?? all;
  const mr = indiv.map((v, i) => (i === 0 ? null : Math.abs(v - indiv[i - 1])));
  const mrbar = (mr.slice(1) as number[]).reduce((a, b) => a + b, 0) / Math.max(1, indiv.length - 1);
  const indMean = indiv.reduce((a, b) => a + b, 0) / indiv.length;
  const iSig = mrbar / 1.128;
  const iUcl = indMean + 3 * iSig;
  const iLcl = indMean - 3 * iSig;
  const mrUcl = 3.267 * mrbar;

  const sigmaWithin = hasSubgroups ? rbar / C.d2 : iSig;

  return {
    name, colNames, isDemo: opts?.isDemo ?? false, k, n, hasSubgroups, subs, all,
    xbarbar, rbar, uclX, lclX, uclR, lclR,
    svals, sbar, uclXs, lclXs, uclS, lclS, c4: C.c4,
    sigmaWithin, oMean, oSd,
    indiv, mr, mrbar, indMean, iUcl, iLcl, mrUcl, iSig,
  };
}
