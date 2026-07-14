/**
 * DOE 2³ 全因子 — 效应/系数/Lenth 检验，从原型 doe 页逻辑逐字迁移（交接文档 §8.5）。
 */
import { median } from './basicMath';
import { tCdf, tInv } from './ttest';

export interface DoeTerm {
  name: string;
  v: number; // 效应
  abs: number;
  coef: number; // 效应/2
  sig: boolean; // |效应| ≥ Lenth ME
}

export interface DoeResult {
  terms: DoeTerm[]; // 按 |效应| 降序
  pse: number;
  me: number; // 显著界限 2.57·PSE
}

/** 2³ 全因子设计矩阵（标准序）：[A, B, C, 响应] */
export const DOE_DESIGN: Array<['-' | '+', '-' | '+', '-' | '+', number]> = [
  ['-', '-', '-', 42],
  ['+', '-', '-', 55],
  ['-', '+', '-', 45],
  ['+', '+', '-', 58],
  ['-', '-', '+', 48],
  ['+', '-', '+', 62],
  ['-', '+', '+', 52],
  ['+', '+', '+', 66],
];

const SG = {
  A: [-1, 1, -1, 1, -1, 1, -1, 1],
  B: [-1, -1, 1, 1, -1, -1, 1, 1],
  C: [-1, -1, -1, -1, 1, 1, 1, 1],
};

export function analyzeDoe(responses: number[] = DOE_DESIGN.map((d) => d[3])): DoeResult {
  const y = responses;
  const mul = (x: number[], z: number[]) => x.map((v, i) => v * z[i]);
  const eff = (s: number[]) => y.reduce((a, v, i) => a + v * s[i], 0) / 4;
  const EA = eff(SG.A);
  const EB = eff(SG.B);
  const EC = eff(SG.C);
  const EAB = eff(mul(SG.A, SG.B));
  const EAC = eff(mul(SG.A, SG.C));
  const EBC = eff(mul(SG.B, SG.C));
  const absAll = [EA, EB, EC, EAB, EAC, EBC].map(Math.abs);
  const s0 = 1.5 * median(absAll);
  const pse = 1.5 * median(absAll.filter((a) => a < 2.5 * s0)) || s0 / 1.5;
  const me = 2.57 * pse;
  const terms = [
    { name: 'A 温度', v: EA },
    { name: 'B 压力', v: EB },
    { name: 'C 时间', v: EC },
    { name: 'A×B', v: EAB },
    { name: 'A×C', v: EAC },
    { name: 'B×C', v: EBC },
  ]
    .map((t) => ({ name: t.name, v: t.v, abs: Math.abs(t.v), coef: t.v / 2, sig: Math.abs(t.v) >= me }))
    .sort((a, b) => b.abs - a.abs);
  return { terms, pse, me };
}

/** 主效应图数据：各因子低/高水平均值 */
export function mainEffectMeans(responses: number[] = DOE_DESIGN.map((d) => d[3])) {
  const mk = (s: number[]) => {
    const lo = responses.filter((_, i) => s[i] < 0);
    const hi = responses.filter((_, i) => s[i] > 0);
    return {
      lo: lo.reduce((a, b) => a + b, 0) / lo.length,
      hi: hi.reduce((a, b) => a + b, 0) / hi.length,
    };
  };
  return [
    { name: 'A 温度', ...mk(SG.A) },
    { name: 'B 压力', ...mk(SG.B) },
    { name: 'C 时间', ...mk(SG.C) },
  ];
}

/** A×B 交互作用图四个单元均值（c00: A低B低, c10: A高B低, c01: A低B高, c11: A高B高） */
export function interactionMeans(responses: number[] = DOE_DESIGN.map((d) => d[3])) {
  const cell = (a: number, b: number) => {
    const vals = responses.filter((_, i) => SG.A[i] === a && SG.B[i] === b);
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  };
  return { c00: cell(-1, -1), c10: cell(1, -1), c01: cell(-1, 1), c11: cell(1, 1) };
}

// ==================== 泛化因子设计(k=2..4 全因子,接真实数据) ====================

export interface FactorDef { name: string; low: number; high: number }

/** 已编码设计:各因子列取 -1/0/+1,response 对齐 */
export interface CodedDesign {
  factorNames: string[];
  coded: number[][];      // 行 × k,值 ∈ {-1,0,+1}
  response: number[];     // 长度 = 行数
  levels: { low: number; high: number; hasCenter: boolean }[];
}

export interface FactorialTerm {
  name: string;    // 主效应用因子名;交互用「A×B」的因子名连接
  effect: number;  // 高−低效应
  coef: number;    // 效应/2(回归系数)
  sig: boolean;
  p?: number;      // 残差自由度>0 时给出(t 检验)
  tStat?: number;
}

export interface FactorialResult {
  terms: FactorialTerm[];        // 按 |effect| 降序
  method: 'lenth' | 'ttest';
  me?: number; pse?: number;     // Lenth(饱和设计)
  mse?: number; dfResid?: number;
  curvature?: { coef: number; tStat?: number; p?: number; sig: boolean }; // 中心点时的曲率(弯曲)检验
  droppedTerms?: string[];       // 因设计不完整/别名而无法估计的项(如分数因子)
  fits: number[]; residuals: number[];
  stdResiduals?: number[];       // 标准化残差 r/(s·√(1−h)),t 检验路径给出,对标 Minitab 四合一
  grand: number;
  factorNames: string[];
  nRuns: number;
}

/** 把用户的因子列 + 响应识别为编码设计。每个因子须为 2 水平(可含中心点=中值)。 */
export function detectFactorial(
  factors: { name: string; values: number[] }[],
  response: number[],
): { ok: true; design: CodedDesign } | { ok: false; reason: string } {
  if (factors.length < 2) return { ok: false, reason: 'DOE 至少需要 2 个因子列' };
  if (factors.length > 4) return { ok: false, reason: 'DOE 因子最多支持 4 个' };
  const N = response.length;
  if (N < 4) return { ok: false, reason: '至少需要 4 行数据' };
  const levels: CodedDesign['levels'] = [];
  const codedCols: number[][] = [];
  for (const f of factors) {
    if (f.values.length !== N) return { ok: false, reason: `因子「${f.name}」与响应行数不一致` };
    const uniq = [...new Set(f.values)].sort((a, b) => a - b);
    if (uniq.length < 2) return { ok: false, reason: `因子「${f.name}」只有 1 个水平,无法分析效应` };
    const low = uniq[0], high = uniq[uniq.length - 1];
    let hasCenter = false;
    if (uniq.length === 2) {
      // 纯两水平
    } else if (uniq.length === 3) {
      const mid = uniq[1], expect = (low + high) / 2;
      if (Math.abs(mid - expect) > Math.abs(high - low) * 0.02 + 1e-9) {
        return { ok: false, reason: `因子「${f.name}」有 3 个非规整水平(中值应为上下限的中点),不是标准两水平设计` };
      }
      hasCenter = true;
    } else {
      return { ok: false, reason: `因子「${f.name}」检测到 ${uniq.length} 个水平,DOE 因子设计需要恰好 2 个水平(可含中心点)` };
    }
    levels.push({ low, high, hasCenter });
    codedCols.push(f.values.map((v) => (v === low ? -1 : v === high ? 1 : 0)));
  }
  const coded = response.map((_, i) => codedCols.map((c) => c[i]));
  return { ok: true, design: { factorNames: factors.map((f) => f.name), coded, response, levels } };
}

/** 枚举 1..k 阶所有项(位掩码);按阶数升序返回(低阶优先),使别名剔除时保留主效应而非交互。 */
function termSubsets(k: number): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < (1 << k); mask++) {
    const sub: number[] = [];
    for (let j = 0; j < k; j++) if (mask & (1 << j)) sub.push(j);
    out.push(sub);
  }
  // 稳定排序:阶数(主效应<两因子<三因子…)升序;同阶保持位掩码原序。
  // estimableColumns 优先保留靠前列 → 分数/别名设计里保住低阶主效应,丢弃高阶交互。
  return out.sort((a, b) => a.length - b.length);
}

const termName = (sub: number[], names: string[]): string => sub.map((j) => names[j]).join('×');

/** 满秩方阵求逆(高斯-约当 + 部分主元)。 */
function invertMatrix(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    [a[col], a[piv]] = [a[piv], a[col]];
    const pv = a[col][col];
    for (let c = 0; c < 2 * n; c++) a[col][c] /= pv;
    for (let r = 0; r < n; r++) if (r !== col) { const f = a[r][col]; if (f) for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[col][c]; }
  }
  return a.map((r) => r.slice(n));
}

/** 从对称正定 XᵀX 按自然列序(优先保留低阶项)挑出线性无关列;秩亏(别名)列剔除。带跳过的 LDLᵀ。 */
function estimableColumns(XtX: number[][], tol: number): number[] {
  const p = XtX.length;
  const L: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const d = new Array(p).fill(0);
  const kept: number[] = [];
  for (let j = 0; j < p; j++) {
    let s = XtX[j][j];
    for (const kk of kept) s -= L[j][kk] * L[j][kk] * d[kk];
    if (s > tol) {
      d[j] = s; L[j][j] = 1;
      for (let i = j + 1; i < p; i++) {
        let t = XtX[i][j];
        for (const kk of kept) t -= L[i][kk] * L[j][kk] * d[kk];
        L[i][j] = t / s;
      }
      kept.push(j);
    }
  }
  return kept;
}

/** 普通最小二乘:返回全长系数(秩亏列=0)、(XᵀX)⁻¹ 对角(秩亏列=NaN,用于系数标准误)、秩、拟合与残差。
 * 不假设正交,可正确处理不平衡/非正交设计;别名列自动剔除,支持分数因子。 */
function olsFit(X: number[][], y: number[]): { beta: number[]; invDiag: number[]; rank: number; fits: number[]; residuals: number[]; leverage: number[] } {
  const N = X.length, p = X[0].length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < N; i++) {
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = a; b < p; b++) { const v = xi[a] * xi[b]; XtX[a][b] += v; if (b !== a) XtX[b][a] += v; }
    }
  }
  let scale = 0; for (let dg = 0; dg < p; dg++) scale = Math.max(scale, Math.abs(XtX[dg][dg]));
  const tol = 1e-9 * (scale || 1);
  const kept = estimableColumns(XtX, tol);
  const sub = kept.map((r) => kept.map((c) => XtX[r][c]));
  const subInv = kept.length ? invertMatrix(sub) : [];
  const beta = new Array(p).fill(0);
  const invDiag = new Array(p).fill(NaN);
  kept.forEach((col, a) => {
    let bv = 0; for (let b = 0; b < kept.length; b++) bv += subInv[a][b] * Xty[kept[b]];
    beta[col] = bv;
    invDiag[col] = subInv[a][a];
  });
  const fits = X.map((xi) => xi.reduce((s, v, j) => s + v * beta[j], 0));
  const residuals = y.map((v, i) => v - fits[i]);
  // 杠杆值 h_ii = x_i·(XᵀX)⁻¹·x_iᵀ(仅取可估计列),用于标准化残差
  const leverage = X.map((xi) => {
    const xk = kept.map((c) => xi[c]);
    let h = 0;
    for (let a = 0; a < kept.length; a++) for (let b = 0; b < kept.length; b++) h += xk[a] * subInv[a][b] * xk[b];
    return h;
  });
  return { beta, invDiag, rank: kept.length, fits, residuals, leverage };
}

type ColMeta = { kind: 'intercept' } | { kind: 'term'; name: string } | { kind: 'curv' };

/** 泛化分析:主效应 + 全部交互,普通最小二乘(不要求正交/平衡)。
 * 有中心点时把「曲率(中心点指示)」作为独立模型列纳入,使残差回归为纯误差并给出弯曲检验;
 * 残差自由度>0(重复/中心点)→ t 检验;饱和设计 → Lenth PSE(分数自由度 m/3)。 */
export function analyzeFactorial(design: CodedDesign): FactorialResult {
  const { coded, response: y, factorNames } = design;
  const N = y.length;
  const k = factorNames.length;
  const base = termSubsets(k).map((sub) => ({
    name: termName(sub, factorNames),
    x: coded.map((row) => sub.reduce((p, j) => p * row[j], 1)),
  }));
  const isCenter = (row: number[]) => row.every((v) => v === 0);
  const hasCenter = coded.some(isCenter);

  const colMeta: ColMeta[] = [
    { kind: 'intercept' },
    ...base.map((t) => ({ kind: 'term' as const, name: t.name })),
    ...(hasCenter ? [{ kind: 'curv' as const }] : []),
  ];
  const colX: number[][] = [
    y.map(() => 1),
    ...base.map((t) => t.x),
    ...(hasCenter ? [coded.map((row) => (isCenter(row) ? 1 : 0))] : []),
  ];
  const X = y.map((_, i) => colX.map((c) => c[i]));
  const { beta, invDiag, rank, fits, residuals, leverage } = olsFit(X, y);
  const grand = beta[0];
  const dfResid = N - rank;

  const dropped: string[] = [];
  const estTerms: { j: number; name: string; coef: number; effect: number }[] = [];
  let curvJ = -1;
  colMeta.forEach((meta, j) => {
    if (meta.kind === 'curv' && Number.isFinite(invDiag[j])) curvJ = j;
    if (meta.kind !== 'term') return;
    if (!Number.isFinite(invDiag[j])) { dropped.push(meta.name); return; }
    estTerms.push({ j, name: meta.name, coef: beta[j], effect: 2 * beta[j] });
  });

  let method: 'lenth' | 'ttest';
  let me: number | undefined, pse: number | undefined, mse: number | undefined;
  let curvature: FactorialResult['curvature'];
  let stdResiduals: number[] | undefined;
  const terms: FactorialTerm[] = [];

  if (dfResid >= 1) {
    method = 'ttest';
    mse = residuals.reduce((a, r) => a + r * r, 0) / dfResid;
    if (mse > 1e-12) {
      const s = Math.sqrt(mse);
      stdResiduals = residuals.map((r, i) => {
        const denom = s * Math.sqrt(Math.max(1e-9, 1 - leverage[i]));
        return denom > 0 ? r / denom : 0;
      });
    }
    for (const t of estTerms) {
      const seEff = 2 * Math.sqrt(mse * invDiag[t.j]);
      // 零残差(完美拟合)时:非零效应 → 无穷显著(p→0),而非误判为不显著;零效应 → 无信息(p=1)
      const tStat = seEff > 0 ? t.effect / seEff : (t.effect === 0 ? 0 : Math.sign(t.effect) * Infinity);
      const p = seEff > 0 ? 2 * (1 - tCdf(Math.abs(tStat), dfResid)) : (t.effect === 0 ? 1 : 0);
      terms.push({ name: t.name, effect: t.effect, coef: t.coef, tStat, p, sig: p < 0.05 });
    }
    if (curvJ >= 0) {
      const seCoef = Math.sqrt(mse * invDiag[curvJ]);
      const cf = beta[curvJ];
      const tStat = seCoef > 0 ? cf / seCoef : (cf === 0 ? 0 : Math.sign(cf) * Infinity);
      const p = seCoef > 0 ? 2 * (1 - tCdf(Math.abs(tStat), dfResid)) : (cf === 0 ? 1 : 0);
      curvature = { coef: cf, tStat, p, sig: p < 0.05 };
    }
  } else {
    method = 'lenth';
    const absAll = estTerms.map((t) => Math.abs(t.effect));
    const s0 = 1.5 * median(absAll);
    pse = 1.5 * median(absAll.filter((a) => a < 2.5 * s0)) || s0 / 1.5 || 1e-9;
    const dLen = Math.max(1, absAll.length / 3); // Lenth 用分数自由度 m/3(不取整)
    me = tInv(0.975, dLen) * pse;
    for (const t of estTerms) terms.push({ name: t.name, effect: t.effect, coef: t.coef, sig: Math.abs(t.effect) >= me });
    if (curvJ >= 0) curvature = { coef: beta[curvJ], sig: false }; // 无残差自由度,曲率不可检验
  }
  terms.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return {
    terms, method, me, pse, mse, dfResid, curvature,
    droppedTerms: dropped.length ? dropped : undefined,
    fits, residuals, stdResiduals, grand, factorNames, nRuns: N,
  };
}

/** 主效应图数据(各因子低/高水平均值),基于编码设计的真实响应 */
export function mainEffectMeansFrom(design: CodedDesign): { name: string; lo: number; hi: number }[] {
  return design.factorNames.map((name, j) => {
    const lo = design.response.filter((_, i) => design.coded[i][j] < 0);
    const hi = design.response.filter((_, i) => design.coded[i][j] > 0);
    return {
      name,
      lo: lo.length ? lo.reduce((a, b) => a + b, 0) / lo.length : 0,
      hi: hi.length ? hi.reduce((a, b) => a + b, 0) / hi.length : 0,
    };
  });
}

/** 因子 i×j 交互作用四单元均值 */
export function interactionMeansFrom(design: CodedDesign, i: number, j: number) {
  const cell = (a: number, b: number) => {
    const vals = design.response.filter((_, r) => design.coded[r][i] === a && design.coded[r][j] === b);
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
  };
  return { c00: cell(-1, -1), c10: cell(1, -1), c01: cell(-1, 1), c11: cell(1, 1) };
}

/** 生成 2^k 全因子设计(标准序 + 可选中心点/重复 + 随机运行序),返回可直接 importMatrix 的矩阵。
 * 末列为待录入的空响应列(占位 0)。 */
export function generateFactorialDesign(
  factors: FactorDef[],
  opts: { centerPoints?: number; replicates?: number; randomize?: boolean; seed?: number } = {},
): { colNames: string[]; rows: number[][] } {
  const k = factors.length;
  const reps = Math.max(1, opts.replicates ?? 1);
  const centers = Math.max(0, opts.centerPoints ?? 0);
  const rows: number[][] = [];
  for (let r = 0; r < reps; r++) {
    for (let combo = 0; combo < (1 << k); combo++) {
      rows.push(factors.map((f, j) => (combo & (1 << j) ? f.high : f.low)).concat(0));
    }
  }
  for (let c = 0; c < centers; c++) {
    rows.push(factors.map((f) => (f.low + f.high) / 2).concat(0));
  }
  // 随机运行序(种子 LCG,确定性可复现)
  if (opts.randomize) {
    let s = (opts.seed ?? 12345) >>> 0;
    const rnd = () => (s = (1103515245 * s + 12345) >>> 0) / 0x100000000;
    for (let i = rows.length - 1; i > 0; i--) {
      const jj = Math.floor(rnd() * (i + 1));
      [rows[i], rows[jj]] = [rows[jj], rows[i]];
    }
  }
  return { colNames: [...factors.map((f) => f.name), '响应(待录入)'], rows };
}

/** 解析 DOE 分析的因子/响应列(页面选择器与项目汇总共用同一份逻辑,保证界面与卡片一致)。
 * factorCols/respCol 为空(或名称在当前数据集中失效)时回落到默认:响应=末列、因子=其余列前 4 个。
 * 因子最多 4 个(detectFactorial 上限),此处统一截断,避免页面与汇总因截断口径不同而分歧。 */
export function resolveDoeColumns(
  colNames: string[],
  factorCols: string[] | null,
  respCol: string | null,
): { factorIdx: number[]; respIdx: number } {
  const nc = colNames.length;
  let respIdx = respCol ? colNames.indexOf(respCol) : -1;
  if (respIdx < 0) respIdx = nc - 1;
  let factorIdx = (factorCols ?? [])
    .map((n) => colNames.indexOf(n))
    .filter((i) => i >= 0 && i !== respIdx);
  if (!factorIdx.length) {
    factorIdx = colNames.map((_, i) => i).filter((i) => i !== respIdx);
  }
  return { factorIdx: factorIdx.slice(0, 4), respIdx };
}
