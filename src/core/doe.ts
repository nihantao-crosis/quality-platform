/**
 * DOE 2³ 全因子 — 效应/系数/Lenth 检验，从原型 doe 页逻辑逐字迁移（交接文档 §8.5）。
 */
import { fCdf, mean, median } from './basicMath';
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

interface NormalizedResponse {
  center: number;
  scale: number;
  values: number[];
}

/**
 * DOE 的显著性检验只应取决于响应的相对变化，而不应取决于用户选用 Pa/MPa
 * 或是否给整列加了一个基准值。先按响应的中程和半极差无量纲化，既避免固定
 * 绝对 epsilon，也减轻带大截距数据在正规方程中的消减误差。
 */
function normalizeResponse(values: number[]): NormalizedResponse {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('DOE 响应必须是非空的有限数值列');
  }
  let low = values[0];
  let high = values[0];
  for (let index = 1; index < values.length; index++) {
    if (values[index] < low) low = values[index];
    if (values[index] > high) high = values[index];
  }
  // 分别除以 2 再相加，避免 high-low 或 high+low 在有限输入下溢出到 Infinity。
  const center = low / 2 + high / 2;
  const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value - center)), 0);
  return {
    center,
    scale,
    values: scale > 0 ? values.map((value) => (value - center) / scale) : values.map(() => 0),
  };
}

/** 无量纲计算中的舍入容差；只与问题规模相关，不带响应单位。 */
function relativeNumericTolerance(rows: number, columns: number): number {
  return Number.EPSILON * 64 * Math.max(1, rows, columns);
}

function lenthScale(absEffects: number[]): { pse: number; me: number } {
  if (!absEffects.length) return { pse: 0, me: 0 };
  const s0 = 1.5 * median(absEffects);
  const trimmed = s0 > 0 ? absEffects.filter((effect) => effect < 2.5 * s0) : [];
  const candidate = trimmed.length ? 1.5 * median(trimmed) : 0;
  const pse = candidate > 0 ? candidate : s0 / 1.5;
  const dLen = Math.max(1, absEffects.length / 3);
  return { pse, me: tInv(0.975, dLen) * pse };
}

const SG = {
  A: [-1, 1, -1, 1, -1, 1, -1, 1],
  B: [-1, -1, 1, 1, -1, -1, 1, 1],
  C: [-1, -1, -1, -1, 1, 1, 1, 1],
};

export function analyzeDoe(responses: number[] = DOE_DESIGN.map((d) => d[3])): DoeResult {
  if (responses.length !== DOE_DESIGN.length) throw new Error('2³ DOE 分析需要恰好 8 个响应');
  const normalized = normalizeResponse(responses);
  const y = normalized.values;
  const mul = (x: number[], z: number[]) => x.map((v, i) => v * z[i]);
  const eff = (s: number[]) => y.reduce((a, v, i) => a + v * s[i], 0) / 4;
  const EA = eff(SG.A);
  const EB = eff(SG.B);
  const EC = eff(SG.C);
  const EAB = eff(mul(SG.A, SG.B));
  const EAC = eff(mul(SG.A, SG.C));
  const EBC = eff(mul(SG.B, SG.C));
  const absAll = [EA, EB, EC, EAB, EAC, EBC].map(Math.abs);
  // 演示页沿用原型的 2.57·PSE 界限，但在无量纲效应上判断，之后再换回原单位。
  const s0 = 1.5 * median(absAll);
  const trimmed = s0 > 0 ? absAll.filter((effect) => effect < 2.5 * s0) : [];
  const candidate = trimmed.length ? 1.5 * median(trimmed) : 0;
  const pseNormalized = candidate > 0 ? candidate : s0 / 1.5;
  const meNormalized = 2.57 * pseNormalized;
  const zeroTolerance = relativeNumericTolerance(responses.length, 7);
  const pse = pseNormalized * normalized.scale;
  const me = meNormalized * normalized.scale;
  const terms = [
    { name: 'A 温度', v: EA },
    { name: 'B 压力', v: EB },
    { name: 'C 时间', v: EC },
    { name: 'A×B', v: EAB },
    { name: 'A×C', v: EAC },
    { name: 'B×C', v: EBC },
  ]
    .map((t) => {
      const v = t.v * normalized.scale;
      const absNormalized = Math.abs(t.v);
      return {
        name: t.name,
        v,
        abs: Math.abs(v),
        coef: v / 2,
        // PSE=0 时零效应不能因“0 >= 0”被标成显著；非零效应仍可识别。
        sig: absNormalized > zeroTolerance && absNormalized + zeroTolerance >= meNormalized,
      };
    })
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
  /** 可选区组标识；分析时作为扰动项先于因子效应入模。 */
  blocks?: Array<string | number>;
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
  aliases?: { term: string; with: string; relation: 'same' | 'opposite' | 'linear-dependent' }[];
  requestedTerms: string[];
  includeCurvature: boolean;
  block?: { levels: string[]; df: number; coefficients: Array<{ level: string; coef: number }> };
  fits: number[]; residuals: number[];
  stdResiduals?: number[];       // 标准化残差 r/(s·√(1−h)),t 检验路径给出,对标 Minitab 四合一
  grand: number;
  factorNames: string[];
  nRuns: number;
}

export interface FactorialModelOptions {
  /** 精确项名；省略时包含所有主效应及交互作用。 */
  terms?: string[];
  /** 有中心点时是否把曲率列纳入模型，默认 true。 */
  includeCurvature?: boolean;
  /** 可覆盖设计自带的区组标识。 */
  blocks?: Array<string | number>;
}

/** 两水平设计(2^(k−p) 分数因子)允许的最大因子数;两水平/一般全因子仍为 4。 */
export const MAX_FRACTIONAL_FACTORS = 7;

/** 把用户的因子列 + 响应识别为编码设计。每个因子须为 2 水平(可含中心点=中值)。 */
export function detectFactorial(
  factors: { name: string; values: number[] }[],
  response: number[],
  metadata: { blocks?: Array<string | number> } = {},
): { ok: true; design: CodedDesign } | { ok: false; reason: string } {
  // 716-R3:逻辑原样抽入 detectTwoLevelCore(仅因子数上限参数化),本函数行为与历史锚点完全一致。
  return detectTwoLevelCore(factors, response, metadata, 4);
}

/** 716-R3:分数因子(2^(k−p),k≤7)的两水平检测——与 detectFactorial 同一套逻辑,仅放宽因子数上限。 */
export function detectFractionalFactorial(
  factors: { name: string; values: number[] }[],
  response: number[],
  metadata: { blocks?: Array<string | number> } = {},
): { ok: true; design: CodedDesign } | { ok: false; reason: string } {
  return detectTwoLevelCore(factors, response, metadata, MAX_FRACTIONAL_FACTORS);
}

function detectTwoLevelCore(
  factors: { name: string; values: number[] }[],
  response: number[],
  metadata: { blocks?: Array<string | number> },
  maxFactors: number,
): { ok: true; design: CodedDesign } | { ok: false; reason: string } {
  if (factors.length < 2) return { ok: false, reason: 'DOE 至少需要 2 个因子列' };
  if (factors.length > maxFactors) return { ok: false, reason: `DOE 因子最多支持 ${maxFactors} 个` };
  const factorNames = factors.map((factor) => factor.name.trim());
  if (factorNames.some((name) => !name)) return { ok: false, reason: '因子名不能为空' };
  if (new Set(factorNames).size !== factorNames.length) return { ok: false, reason: '因子名不能重复' };
  const N = response.length;
  if (N < 4) return { ok: false, reason: '至少需要 4 行数据' };
  if (response.some((value) => !Number.isFinite(value))) return { ok: false, reason: '响应列包含空值或非有限数值' };
  if (metadata.blocks && metadata.blocks.length !== N) return { ok: false, reason: '区组列与响应行数不一致' };
  if (metadata.blocks?.some((value) => value == null || String(value).trim() === '' || (typeof value === 'number' && !Number.isFinite(value)))) {
    return { ok: false, reason: '区组列包含空值或非有限数值' };
  }
  const levels: CodedDesign['levels'] = [];
  const codedCols: number[][] = [];
  for (const f of factors) {
    if (f.values.length !== N) return { ok: false, reason: `因子「${f.name}」与响应行数不一致` };
    if (f.values.some((value) => !Number.isFinite(value))) return { ok: false, reason: `因子「${f.name}」包含空值或非有限数值` };
    const uniq = [...new Set(f.values)].sort((a, b) => a - b);
    if (uniq.length < 2) return { ok: false, reason: `因子「${f.name}」只有 1 个水平,无法分析效应` };
    const low = uniq[0], high = uniq[uniq.length - 1];
    let hasCenter = false;
    if (uniq.length === 2) {
      // 纯两水平
    } else if (uniq.length === 3) {
      const mid = uniq[1];
      const left = mid - low;
      const right = high - mid;
      const distanceScale = Math.max(left, right);
      // |mid−中点| ≤ 2%·全量程，等价于左右距离相对不平衡 ≤ 4%。先用左右
      // 距离自身归一化，因而平移/换单位都不改变判断，也不会在极大值时求和溢出。
      const imbalance = Math.abs(left / distanceScale - right / distanceScale)
        / (left / distanceScale + right / distanceScale);
      if (imbalance > 0.04 + Number.EPSILON * 32) {
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
  // 中心点是一个「运行」属性：所有因子必须在同一行同时取中值。
  // 若 A 的中值与 B 的中值分散在不同行，那些行实际是三水平边点，
  // 不能用「所有编码都为 0」的曲率项来解释。
  const splitCenterRow = coded.findIndex((row) => row.some((v) => v === 0) && !row.every((v) => v === 0));
  if (splitCenterRow >= 0) {
    return {
      ok: false,
      reason: `第 ${splitCenterRow + 1} 行不是合法中心点:中心点要求所有因子在同一运行中同时取上下限的中值`,
    };
  }
  return { ok: true, design: { factorNames, coded, response, levels, blocks: metadata.blocks ? [...metadata.blocks] : undefined } };
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

/** 可供模型项选择器使用的全部主效应/交互作用项，按低阶优先排序。 */
export function factorialModelTerms(factorNames: string[]): string[] {
  return termSubsets(factorNames.length).map((sub) => termName(sub, factorNames));
}

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

interface OlsFit {
  beta: number[];
  /** 无量纲响应上的系数/残差，专供显著性与标准化残差计算。 */
  normalizedBeta: number[];
  normalizedResiduals: number[];
  responseScale: number;
  invDiag: number[];
  rank: number;
  fits: number[];
  residuals: number[];
  leverage: number[];
}

/** 普通最小二乘:返回全长系数(秩亏列=0)、(XᵀX)⁻¹ 对角(秩亏列=NaN,用于系数标准误)、秩、拟合与残差。
 * 不假设正交,可正确处理不平衡/非正交设计;别名列自动剔除,支持分数因子。
 * 响应先无量纲化，确保单位缩放/平移不会改变秩外的推断结论。 */
function olsFit(X: number[][], y: number[]): OlsFit {
  const N = X.length, p = X[0].length;
  const normalized = normalizeResponse(y);
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < N; i++) {
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * normalized.values[i];
      for (let b = a; b < p; b++) { const v = xi[a] * xi[b]; XtX[a][b] += v; if (b !== a) XtX[b][a] += v; }
    }
  }
  let scale = 0; for (let dg = 0; dg < p; dg++) scale = Math.max(scale, Math.abs(XtX[dg][dg]));
  // X 已编码为 -1/0/+1（含 0/1 区组虚拟列）。秩容差按矩阵范数和规模取
  // 浮点舍入界，不用会把合法弱列直接删除的固定 1e-9 比例。
  const tol = Number.EPSILON * 64 * Math.max(N, p) * scale;
  const kept = estimableColumns(XtX, tol);
  const sub = kept.map((r) => kept.map((c) => XtX[r][c]));
  const subInv = kept.length ? invertMatrix(sub) : [];
  const normalizedBeta = new Array(p).fill(0);
  const invDiag = new Array(p).fill(NaN);
  kept.forEach((col, a) => {
    let bv = 0; for (let b = 0; b < kept.length; b++) bv += subInv[a][b] * Xty[kept[b]];
    normalizedBeta[col] = bv;
    invDiag[col] = subInv[a][a];
  });
  const normalizedFits = X.map((xi) => xi.reduce((sum, value, column) => sum + value * normalizedBeta[column], 0));
  const normalizedResiduals = normalized.values.map((value, row) => value - normalizedFits[row]);
  const beta = normalizedBeta.map((value) => value * normalized.scale);
  // 第一列由调用端保证是截距；响应中心只加回截距，不污染任何效应。
  beta[0] += normalized.center;
  const fits = normalizedFits.map((value) => normalized.center + value * normalized.scale);
  const residuals = normalizedResiduals.map((value) => value * normalized.scale);
  // 杠杆值 h_ii = x_i·(XᵀX)⁻¹·x_iᵀ(仅取可估计列),用于标准化残差
  const leverage = X.map((xi) => {
    const xk = kept.map((c) => xi[c]);
    let h = 0;
    for (let a = 0; a < kept.length; a++) for (let b = 0; b < kept.length; b++) h += xk[a] * subInv[a][b] * xk[b];
    return h;
  });
  return {
    beta, normalizedBeta, normalizedResiduals, responseScale: normalized.scale,
    invDiag, rank: kept.length, fits, residuals, leverage,
  };
}

type ColMeta = { kind: 'intercept' } | { kind: 'block'; name: string } | { kind: 'term'; name: string } | { kind: 'curv' };

/** 泛化分析:主效应 + 全部交互,普通最小二乘(不要求正交/平衡)。
 * 有中心点时把「曲率(中心点指示)」作为独立模型列纳入,使残差回归为纯误差并给出弯曲检验;
 * 残差自由度>0(重复/中心点)→ t 检验;饱和设计 → Lenth PSE(分数自由度 m/3)。 */
export function analyzeFactorial(design: CodedDesign, options: FactorialModelOptions = {}): FactorialResult {
  // 716-R3:逻辑原样抽入 analyzeTwoLevelCore(仅因子数上限参数化),本函数行为与历史锚点完全一致。
  return analyzeTwoLevelCore(design, options, 4);
}

/** 716-R3:分数因子(2^(k−p),k≤7)分析——与 analyzeFactorial 同一 OLS + estimableColumns 引擎,
 * 别名列(如 2^(5-2) 的 D=AB、E=AC 生成的 A×B、A×C)按低阶优先自动剔除并报告混杂关系。 */
export function analyzeFractionalFactorial(design: CodedDesign, options: FactorialModelOptions = {}): FactorialResult {
  return analyzeTwoLevelCore(design, options, MAX_FRACTIONAL_FACTORS);
}

function analyzeTwoLevelCore(design: CodedDesign, options: FactorialModelOptions, maxFactors: number): FactorialResult {
  const { coded, response: y, factorNames } = design;
  const N = y.length;
  const k = factorNames.length;
  if (k < 2 || k > maxFactors || factorNames.length !== design.levels.length) {
    throw new Error(`DOE 编码设计必须包含 2–${maxFactors} 个因子及对应水平定义`);
  }
  const trimmedNames = factorNames.map((name) => name.trim());
  if (trimmedNames.some((name, index) => !name || name !== factorNames[index])
    || new Set(trimmedNames).size !== trimmedNames.length) {
    throw new Error('DOE 因子名必须非空且不能重复');
  }
  if (design.levels.some((level) => !Number.isFinite(level.low) || !Number.isFinite(level.high) || !(level.low < level.high))) {
    throw new Error('DOE 因子水平必须是有限数值且满足低水平 < 高水平');
  }
  if (N < 4 || coded.length !== N || y.some((value) => !Number.isFinite(value))) {
    throw new Error('DOE 编码设计至少需要 4 行且响应必须为有限数值');
  }
  if (coded.some((row) => row.length !== k || row.some((value) => value !== -1 && value !== 0 && value !== 1))) {
    throw new Error('DOE 编码因子只能取 -1、0、+1，且每行必须包含全部因子');
  }
  if (coded.some((row) => row.some((value) => value === 0) && !row.every((value) => value === 0))) {
    throw new Error('DOE 中心点必须在同一运行中让所有因子同时取 0');
  }
  const hasCenterRun = coded.some((row) => row.every((value) => value === 0));
  if (design.levels.some((level) => level.hasCenter !== hasCenterRun)) {
    throw new Error('DOE 编码中心点与因子水平定义不一致');
  }
  if (factorNames.some((_, factor) => !coded.some((row) => row[factor] === -1) || !coded.some((row) => row[factor] === 1))) {
    throw new Error('DOE 每个因子都必须同时包含低水平和高水平运行');
  }
  const allBase = termSubsets(k).map((sub) => ({
    name: termName(sub, factorNames),
    x: coded.map((row) => sub.reduce((p, j) => p * row[j], 1)),
  }));
  const available = new Set(allBase.map((term) => term.name));
  const requestedTerms = options.terms == null
    ? allBase.map((term) => term.name)
    : [...new Set(options.terms)].filter((name) => available.has(name));
  if (!requestedTerms.length) throw new Error('DOE 模型至少需要 1 个合法效应项');
  const requested = new Set(requestedTerms);
  const base = allBase.filter((term) => requested.has(term.name));
  const isCenter = (row: number[]) => row.every((v) => v === 0);
  const hasCenter = hasCenterRun;
  const includeCurvature = (options.includeCurvature ?? true) && hasCenter;
  const rawBlocks = options.blocks ?? design.blocks;
  if (rawBlocks && rawBlocks.length !== N) throw new Error('区组列与响应行数不一致');
  if (rawBlocks?.some((value) => value == null || String(value).trim() === ''
    || (typeof value === 'number' && !Number.isFinite(value)))) {
    throw new Error('区组列包含空值或非有限数值');
  }
  const blockValues = rawBlocks?.map((value) => String(value).trim());
  const blockLevels = blockValues ? [...new Set(blockValues)] : [];
  // b 个区组用 b-1 个处理编码列。它们在因子项之前入模，因此与区组生成元
  // 混杂的交互项会被标记为不可独立估计，而不会把区组差异误报成交互效应。
  const blockColumns = blockLevels.slice(1).map((level) =>
    blockValues!.map((value) => (value === level ? 1 : 0)));

  const colMeta: ColMeta[] = [
    { kind: 'intercept' },
    ...blockLevels.slice(1).map((level) => ({ kind: 'block' as const, name: `区组 ${level}` })),
    ...base.map((t) => ({ kind: 'term' as const, name: t.name })),
    ...(includeCurvature ? [{ kind: 'curv' as const }] : []),
  ];
  const colX: number[][] = [
    y.map(() => 1),
    ...blockColumns,
    ...base.map((t) => t.x),
    ...(includeCurvature ? [coded.map((row) => (isCenter(row) ? 1 : 0))] : []),
  ];
  const X = y.map((_, i) => colX.map((c) => c[i]));
  const {
    beta, normalizedBeta, normalizedResiduals, responseScale,
    invDiag, rank, fits, residuals, leverage,
  } = olsFit(X, y);
  const grand = beta[0];
  const dfResid = N - rank;
  const inferenceTolerance = relativeNumericTolerance(N, colMeta.length);

  const dropped: string[] = [];
  const estTerms: { j: number; name: string; coef: number; effect: number; normalizedEffect: number }[] = [];
  let curvJ = -1;
  colMeta.forEach((meta, j) => {
    if (meta.kind === 'curv' && Number.isFinite(invDiag[j])) curvJ = j;
    if (meta.kind !== 'term') return;
    if (!Number.isFinite(invDiag[j])) { dropped.push(meta.name); return; }
    estTerms.push({
      j, name: meta.name, coef: beta[j], effect: 2 * beta[j],
      normalizedEffect: 2 * normalizedBeta[j],
    });
  });
  const aliases = dropped.map((name) => {
    const j = colMeta.findIndex((meta) => meta.kind === 'term' && meta.name === name);
    const x = colX[j];
    for (let q = 0; q < j; q++) {
      if (!Number.isFinite(invDiag[q])) continue;
      const z = colX[q];
      const same = x.every((value, i) => Math.abs(value - z[i]) <= inferenceTolerance * Math.max(1, Math.abs(value), Math.abs(z[i])));
      const opposite = x.every((value, i) => Math.abs(value + z[i]) <= inferenceTolerance * Math.max(1, Math.abs(value), Math.abs(z[i])));
      if (same || opposite) {
        const meta = colMeta[q];
        const withName = meta.kind === 'intercept' ? '常量' : meta.kind === 'curv' ? '曲率' : meta.name;
        return { term: name, with: withName, relation: same ? 'same' as const : 'opposite' as const };
      }
    }
    return { term: name, with: '已保留模型项的线性组合', relation: 'linear-dependent' as const };
  });

  let method: 'lenth' | 'ttest';
  let me: number | undefined, pse: number | undefined, mse: number | undefined;
  let curvature: FactorialResult['curvature'];
  let stdResiduals: number[] | undefined;
  const terms: FactorialTerm[] = [];

  if (dfResid >= 1) {
    method = 'ttest';
    const mseNormalizedRaw = normalizedResiduals.reduce((sum, residual) => sum + residual * residual, 0) / dfResid;
    const zeroMseThreshold = inferenceTolerance * inferenceTolerance;
    const mseNormalized = mseNormalizedRaw <= zeroMseThreshold ? 0 : mseNormalizedRaw;
    mse = mseNormalizedRaw * responseScale * responseScale;
    if (mseNormalized > 0) {
      const s = Math.sqrt(mseNormalized);
      stdResiduals = normalizedResiduals.map((residual, i) => {
        const denom = s * Math.sqrt(Math.max(inferenceTolerance, 1 - leverage[i]));
        return denom > 0 ? residual / denom : 0;
      });
    } else stdResiduals = normalizedResiduals.map(() => 0);
    for (const t of estTerms) {
      const seEff = 2 * Math.sqrt(mseNormalized * invDiag[t.j]);
      const effectIsZero = Math.abs(t.normalizedEffect) <= inferenceTolerance;
      // 零残差(完美拟合)时:非零效应 → 无穷显著(p→0),而非误判为不显著;零效应 → 无信息(p=1)
      const tStat = seEff > 0 ? t.normalizedEffect / seEff : (effectIsZero ? 0 : Math.sign(t.normalizedEffect) * Infinity);
      const p = seEff > 0 ? 2 * (1 - tCdf(Math.abs(tStat), dfResid)) : (effectIsZero ? 1 : 0);
      terms.push({ name: t.name, effect: t.effect, coef: t.coef, tStat, p, sig: p < 0.05 });
    }
    if (curvJ >= 0) {
      const seCoef = Math.sqrt(mseNormalized * invDiag[curvJ]);
      const cf = beta[curvJ];
      const normalizedCf = normalizedBeta[curvJ];
      const curvatureIsZero = Math.abs(normalizedCf) <= inferenceTolerance;
      const tStat = seCoef > 0 ? normalizedCf / seCoef : (curvatureIsZero ? 0 : Math.sign(normalizedCf) * Infinity);
      const p = seCoef > 0 ? 2 * (1 - tCdf(Math.abs(tStat), dfResid)) : (curvatureIsZero ? 1 : 0);
      curvature = { coef: cf, tStat, p, sig: p < 0.05 };
    }
  } else {
    method = 'lenth';
    const absNormalized = estTerms.map((term) => Math.abs(term.normalizedEffect));
    const lenth = lenthScale(absNormalized);
    pse = lenth.pse * responseScale;
    me = lenth.me * responseScale;
    for (const t of estTerms) {
      const absEffect = Math.abs(t.normalizedEffect);
      terms.push({
        name: t.name, effect: t.effect, coef: t.coef,
        sig: absEffect > inferenceTolerance && absEffect + inferenceTolerance >= lenth.me,
      });
    }
    if (curvJ >= 0) curvature = { coef: beta[curvJ], sig: false }; // 无残差自由度,曲率不可检验
  }
  terms.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return {
    terms, method, me, pse, mse, dfResid, curvature,
    droppedTerms: dropped.length ? dropped : undefined,
    aliases: aliases.length ? aliases : undefined,
    requestedTerms,
    includeCurvature,
    block: blockLevels.length > 1 ? {
      levels: blockLevels,
      df: blockLevels.length - 1,
      coefficients: blockLevels.slice(1).map((level, index) => ({ level, coef: beta[index + 1] })),
    } : undefined,
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

export interface FactorialCornerPrediction {
  coded: number[];
  factorValues: number[];
  /** 在各区组等权平均后的模型预测；没有区组时就是当前拟合模型的角点预测。 */
  predicted: number;
}

export interface FactorialCornerOptimum extends FactorialCornerPrediction {
  /** 在数值容差内达到相同最佳预测值的全部角点。 */
  ties: FactorialCornerPrediction[];
  unique: boolean;
}

export interface FactorialOptimizationDecision {
  status: 'no-significant-effect' | 'significant-curvature' | 'unique' | 'tied';
  optimum?: FactorialCornerOptimum;
  /** 并列最优角点共同固定的因子编码；null 表示该因子在最优集合中没有唯一设置。 */
  fixedCoded?: Array<-1 | 1 | null>;
}

function factorialCornerContrast(result: FactorialResult, design: CodedDesign, coded: number[]): number {
  const subsetByName = new Map(termSubsets(design.factorNames.length)
    .map((subset) => [termName(subset, design.factorNames), subset]));
  return result.terms.reduce((sum, term) => {
    const subset = subsetByName.get(term.name);
    if (!subset) return sum;
    return sum + term.coef * subset.reduce((product, index) => product * coded[index], 1);
  }, 0);
}

/**
 * 枚举当前拟合模型的全部 2^k 角点预测。区组使用等权最小二乘均值（LS mean），
 * 从而不会让非平衡区组的原始边际构成反转主效应/交互图方向。
 */
export function factorialCornerPredictions(
  result: FactorialResult,
  design: CodedDesign,
): FactorialCornerPrediction[] {
  const averageBlockOffset = result.block
    ? result.block.coefficients.reduce((sum, block) => sum + block.coef, 0) / result.block.levels.length
    : 0;
  return Array.from({ length: 1 << design.factorNames.length }, (_, mask) => {
    const coded = design.factorNames.map((_, index) => mask & (1 << index) ? 1 : -1);
    const contrast = factorialCornerContrast(result, design, coded);
    const predicted = result.grand + averageBlockOffset + contrast;
    return {
      coded,
      factorValues: coded.map((level, index) => level > 0 ? design.levels[index].high : design.levels[index].low),
      predicted,
    };
  });
}

/** 当前拟合模型的区组调整主效应均值。 */
export function factorialAdjustedMainMeans(
  result: FactorialResult,
  design: CodedDesign,
): { name: string; lo: number; hi: number }[] {
  const corners = factorialCornerPredictions(result, design);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return design.factorNames.map((name, index) => ({
    name,
    lo: average(corners.filter((corner) => corner.coded[index] < 0).map((corner) => corner.predicted)),
    hi: average(corners.filter((corner) => corner.coded[index] > 0).map((corner) => corner.predicted)),
  }));
}

/** 当前拟合模型的区组调整 i×j 四单元均值。 */
export function factorialAdjustedInteractionMeans(
  result: FactorialResult,
  design: CodedDesign,
  i: number,
  j: number,
) {
  if (i === j || i < 0 || j < 0 || i >= design.factorNames.length || j >= design.factorNames.length) {
    throw new Error('交互作用图需要两个不同的有效因子');
  }
  const corners = factorialCornerPredictions(result, design);
  const cell = (a: number, b: number) => {
    const values = corners.filter((corner) => corner.coded[i] === a && corner.coded[j] === b).map((corner) => corner.predicted);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  return { c00: cell(-1, -1), c10: cell(1, -1), c01: cell(-1, 1), c11: cell(1, 1) };
}

/** 枚举 2^k 角点，用当前拟合主效应+交互项模型找最大/最小响应组合。
 * 这避免在显著交互存在时仍按各主效应符号独立推荐，而导致选到最差组合。 */
export function factorialCornerOptimum(
  result: FactorialResult,
  design: CodedDesign,
  objective: 'maximize' | 'minimize' = 'maximize',
): FactorialCornerOptimum {
  const corners = factorialCornerPredictions(result, design);
  // 截距（以及响应整体平移）对角点排序没有意义。用模型对比项直接比较，避免
  // “响应加了一个大基准值 → 1e-9×基准值把不同角点全判成并列”的单位依赖。
  const scored = corners.map((corner) => ({
    corner,
    score: factorialCornerContrast(result, design, corner.coded),
  }));
  const bestScored = scored.reduce((current, candidate) =>
    objective === 'maximize'
      ? candidate.score > current.score ? candidate : current
      : candidate.score < current.score ? candidate : current);
  const scoreScale = scored.reduce((largest, candidate) => Math.max(largest, Math.abs(candidate.score)), 0);
  const tolerance = 1e-9 * scoreScale;
  const ties = scored
    .filter((candidate) => Math.abs(candidate.score - bestScored.score) <= tolerance)
    .map((candidate) => candidate.corner);
  const best = bestScored.corner;
  return { ...best, ties, unique: ties.length === 1 };
}

/** 页面与专项报告共用的 DOE 优化可解释性判定。 */
export function factorialOptimizationDecision(
  result: FactorialResult,
  design: CodedDesign,
  objective: 'maximize' | 'minimize' = 'maximize',
): FactorialOptimizationDecision {
  if (result.curvature?.sig) return { status: 'significant-curvature' };
  if (!result.terms.some((term) => term.sig)) return { status: 'no-significant-effect' };
  const optimum = factorialCornerOptimum(result, design, objective);
  if (optimum.unique) return { status: 'unique', optimum, fixedCoded: optimum.coded.map((value) => value as -1 | 1) };
  const fixedCoded = design.factorNames.map((_, index) => {
    const first = optimum.ties[0].coded[index];
    return optimum.ties.every((corner) => corner.coded[index] === first) ? first as -1 | 1 : null;
  });
  return { status: 'tied', optimum, fixedCoded };
}

/** 因子 i×j 交互作用四单元均值 */
export function interactionMeansFrom(design: CodedDesign, i: number, j: number) {
  const cell = (a: number, b: number) => {
    const vals = design.response.filter((_, r) => design.coded[r][i] === a && design.coded[r][j] === b);
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
  };
  return { c00: cell(-1, -1), c10: cell(1, -1), c01: cell(-1, 1), c11: cell(1, 1) };
}

// ==================== DOE 增强:未编码回归方程 / Lenth PSE 辅助 / 删后残差 ====================

export interface UncodedEquationTerm {
  label: string; // 「常量」/ 因子名 / 「因子1*因子2」/ 「Ct Pt」
  coef: number;  // 实际单位系数
}

export interface UncodedEquation {
  terms: UncodedEquationTerm[];
  text: string;
}

/** 系数取 4 位有效数字;过大/过小时避免 toPrecision 的科学计数法直接进方程文本。 */
function formatCoef4(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0.000';
  const text = value.toPrecision(4);
  return text.includes('e') ? String(Number(text)) : text;
}

/**
 * 未编码(实际单位)回归方程:由编码系数(β,基于 -1/+1)与各因子低/高水平换算。
 * x_coded = (x − center)/halfRange,center=(低+高)/2,halfRange=(高−低)/2;
 * 两因子交互按乘积展开,常数与一次项吸收展开出的中心平移;Ct Pt(中心点指示,
 * 中心点行=1、角点行=0)系数不做变换。只支持「常数 + 主效应 + 两因子交互 + Ct Pt」:
 * 模型含三因子及以上交互,或项名与因子定义对不上时返回 null,由调用方注明原因。
 * 有区组时把区组系数按等权平均并入常数项(与 factorialCornerPredictions 的 LS 均值同口径)。
 */
export function uncodedEquation(
  fit: FactorialResult,
  factors: FactorDef[],
  responseName?: string,
): UncodedEquation | null {
  if (!factors.length) return null;
  if (factors.some((factor) => !factor.name.trim() || !Number.isFinite(factor.low)
    || !Number.isFinite(factor.high) || !(factor.low < factor.high))) return null;
  if (new Set(factors.map((factor) => factor.name)).size !== factors.length) return null;
  const byName = new Map<string, number[]>();
  factors.forEach((factor, index) => byName.set(factor.name, [index]));
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      byName.set(`${factors[i].name}×${factors[j].name}`, [i, j]);
      byName.set(`${factors[j].name}×${factors[i].name}`, [j, i]);
    }
  }
  const center = factors.map((factor) => factor.low / 2 + factor.high / 2);
  const half = factors.map((factor) => (factor.high - factor.low) / 2);
  const mains = factors.map(() => 0);
  const usedFactors = new Set<number>();
  const pairs: { i: number; j: number; coef: number }[] = [];
  let constant = fit.grand + (fit.block
    ? fit.block.coefficients.reduce((sum, block) => sum + block.coef, 0) / fit.block.levels.length
    : 0);
  for (const term of fit.terms) {
    const subset = byName.get(term.name);
    if (!subset) return null; // 三因子及以上交互或未知项:未编码展开不在本版支持范围
    if (subset.length === 1) {
      const i = subset[0];
      usedFactors.add(i);
      mains[i] += term.coef / half[i];
      constant -= (term.coef * center[i]) / half[i];
    } else {
      const [i, j] = subset;
      usedFactors.add(i);
      usedFactors.add(j);
      const cross = term.coef / (half[i] * half[j]);
      pairs.push({ i: Math.min(i, j), j: Math.max(i, j), coef: cross });
      mains[i] -= cross * center[j];
      mains[j] -= cross * center[i];
      constant += cross * center[i] * center[j];
    }
  }
  pairs.sort((a, b) => (a.i - b.i) || (a.j - b.j));
  const terms: UncodedEquationTerm[] = [{ label: '常量', coef: constant }];
  factors.forEach((factor, index) => {
    if (usedFactors.has(index)) terms.push({ label: factor.name, coef: mains[index] });
  });
  for (const pair of pairs) {
    terms.push({ label: `${factors[pair.i].name}*${factors[pair.j].name}`, coef: pair.coef });
  }
  if (fit.curvature) terms.push({ label: 'Ct Pt', coef: fit.curvature.coef });
  let text = formatCoef4(constant);
  for (const term of terms.slice(1)) {
    text += term.coef < 0
      ? ` - ${formatCoef4(-term.coef)} ${term.label}`
      : ` + ${formatCoef4(term.coef)} ${term.label}`;
  }
  return { terms, text: responseName ? `${responseName} = ${text}` : text };
}

/** 从效应列表计算 Lenth PSE(与效应同单位),供正态/半正态效应图做过原点参考线的斜率。
 * 中位数与 2.5·s0 截尾都是尺度等变的,直接在原单位上算与「先无量纲化再换回」一致。 */
export function lenthPseFromEffects(effects: number[]): number {
  const finite = effects.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return lenthScale(finite.map(Math.abs)).pse;
}

/** 删后(学生化删除)残差:t_i = r_i·√((ν−1)/(ν−r_i²)),r_i 为标准化残差,ν 为残差自由度。
 * 等价于用「删除第 i 个观测后重估的 MSE」学生化,离群运行不会稀释自己的判定尺度。
 * ν≤1(删除一个观测后自由度耗尽)或无标准化残差(饱和设计)时返回 null,调用方应禁用该选项;
 * r_i² = ν 的边界(删除该点后完美拟合)给 ±Infinity,方向信息保留,由调用方决定呈现方式。 */
export function studentizedDeletedResiduals(
  result: Pick<FactorialResult, 'stdResiduals' | 'dfResid'>,
): number[] | null {
  const nu = result.dfResid;
  const std = result.stdResiduals;
  if (nu === undefined || nu <= 1 || !std) return null;
  return std.map((r) => {
    if (!Number.isFinite(r)) return r;
    const slack = nu - r * r;
    if (slack <= 0) return r === 0 ? 0 : Math.sign(r) * Infinity;
    return r * Math.sqrt((nu - 1) / slack);
  });
}

export const DOE_METADATA_COLUMNS = ['标准序', '运行序', '区组', '中心点', '点类型'] as const;
export const DOE_OUTPUT_COLUMNS = ['DOE拟合值', 'DOE残差', 'DOE标准化残差', 'DOE模型项', 'DOE效应', 'DOE系数'] as const;

const normalizeDoeColumnName = (name: string) => name.trim().toLowerCase().replace(/[ _-]/g, '');

/** 导入 Minitab/本平台设计表时识别元数据列，避免误当可控因子。 */
export function isDoeMetadataColumn(name: string): boolean {
  const n = normalizeDoeColumnName(name);
  return new Set([
    '标准序', '标准顺序', 'stdorder', 'standardorder',
    '运行序', '运行顺序', 'runorder',
    '区组', '区块', 'block', 'blocks',
    '中心点', 'centerpoint', 'centerpt', 'ctpt',
    '点类型', 'pointtype', 'pttype',
  ]).has(n);
}

export function isDoeOutputColumn(name: string): boolean {
  const n = normalizeDoeColumnName(name);
  if (DOE_OUTPUT_COLUMNS.some((output) => normalizeDoeColumnName(output) === n)) return true;
  // Minitab 存储列常见默认名：Fits1 / RESI1 / SRES1 / Effects1 / Coefs1。
  return /^(?:fits?|resi(?:d(?:uals?)?)?|sres(?:i(?:d(?:uals?)?)?)?|effects?|coefs?|coefficients?)\d*$/.test(n);
}

export function isDoeAnalysisColumn(name: string): boolean {
  return !isDoeMetadataColumn(name) && !isDoeOutputColumn(name);
}

/** 从工作表解析 DOE 区组标识；同时支持数值元数据列和文本元数据列。 */
export function resolveDoeBlockValues(
  colNames: string[],
  rows: number[][],
  textCols: Array<{ name: string; values: string[] }> = [],
): Array<string | number> | undefined {
  const isBlockName = (name: string) => new Set(['区组', '区块', 'block', 'blocks']).has(normalizeDoeColumnName(name));
  const numericIndex = colNames.findIndex(isBlockName);
  if (numericIndex >= 0) return rows.map((row) => row[numericIndex]);
  const text = textCols.find((column) => isBlockName(column.name));
  return text && text.values.length === rows.length ? [...text.values] : undefined;
}

export interface GeneratedFactorialDesign {
  colNames: string[];
  rows: number[][];
  textCols: { name: string; values: string[] }[];
  responseCol: number;
  blockCount: number;
}

interface GeneratedRun {
  standardOrder: number;
  block: number;
  pointType: '因子点' | '中心点';
  factorValues: number[];
}

/** 生成 2^k 全因子设计并显式保存标准序、运行序、区组及点类型。
 * 区组数须为 2 的幂且不超过 2^(k−1)；区组生成元使用 A×B、A×C…，确保主效应不与区组混杂。
 * centerPoints 表示「每区组」中心点数；末列为待录入响应(占位 0)。 */
export function generateFactorialDesign(
  factors: FactorDef[],
  opts: { centerPoints?: number; replicates?: number; blocks?: number; randomize?: boolean; seed?: number } = {},
): GeneratedFactorialDesign {
  const k = factors.length;
  if (k < 2 || k > 4) throw new Error('两水平全因子设计支持 2–4 个因子');
  const names = factors.map((factor) => factor.name.trim());
  if (names.some((name) => !name)) throw new Error('因子名不能为空');
  if (new Set(names).size !== names.length) throw new Error('因子名不能重复');
  if (factors.some((factor) => !Number.isFinite(factor.low) || !Number.isFinite(factor.high))) {
    throw new Error('因子上下限必须是有限数值');
  }
  if (factors.some((factor) => !(factor.low < factor.high))) throw new Error('每个因子必须满足低水平 < 高水平');
  const integerOption = (value: number | undefined, fallback: number, label: string, minimum: number) => {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < minimum) throw new Error(`${label}必须是不小于 ${minimum} 的整数`);
    return resolved;
  };
  const reps = integerOption(opts.replicates, 1, '重复数', 1);
  const centers = integerOption(opts.centerPoints, 0, '每区组中心点数', 0);
  const blocks = integerOption(opts.blocks, 1, '区组数', 1);
  const maxBlocks = 1 << (k - 1);
  if ((blocks & (blocks - 1)) !== 0 || blocks > maxBlocks) {
    throw new Error(`区组数须为 1、2${maxBlocks >= 4 ? '、4' : ''}${maxBlocks >= 8 ? '、8' : ''}，且不超过 ${maxBlocks}`);
  }

  const blockBits = Math.log2(blocks);
  const blockFor = (combo: number): number => {
    let blockCode = 0;
    for (let bit = 0; bit < blockBits; bit++) {
      // A×B、A×C、A×D… 作为独立区组生成元；每个主效应在各区组内保持平衡。
      const parity = ((combo >> 0) & 1) ^ ((combo >> (bit + 1)) & 1);
      blockCode |= parity << bit;
    }
    return blockCode + 1;
  };

  const generated: GeneratedRun[] = [];
  for (let r = 0; r < reps; r++) {
    for (let combo = 0; combo < (1 << k); combo++) {
      generated.push({
        standardOrder: 0,
        block: blockFor(combo),
        pointType: '因子点',
        factorValues: factors.map((factor, j) => (combo & (1 << j) ? factor.high : factor.low)),
      });
    }
  }
  for (let block = 1; block <= blocks; block++) {
    for (let c = 0; c < centers; c++) {
      generated.push({
        standardOrder: 0,
        block,
        pointType: '中心点',
        factorValues: factors.map((factor) => factor.low / 2 + factor.high / 2),
      });
    }
  }

  const byBlock = Array.from({ length: blocks }, (_, i) => generated.filter((run) => run.block === i + 1));
  // Minitab 的标准序以“各区组的确定性基线”为准：区组连续，中心点位于该区组因子点之后。
  // 随机化只在区组内部打乱运行序，不能改变同一设计点的标准序。
  let standardOrder = 1;
  for (const blockRuns of byBlock) {
    for (const run of blockRuns) run.standardOrder = standardOrder++;
  }
  // 按区组内随机化；同一种子确定性可复现，区组顺序保持 1..b。
  if (opts.randomize) {
    let s = (opts.seed ?? 12345) >>> 0;
    const rnd = () => (s = (1103515245 * s + 12345) >>> 0) / 0x100000000;
    for (const blockRuns of byBlock) {
      for (let i = blockRuns.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [blockRuns[i], blockRuns[j]] = [blockRuns[j], blockRuns[i]];
      }
    }
  }
  const finalRuns = byBlock.flat();
  const colNames = ['标准序', '运行序', '区组', ...names, '响应(待录入)'];
  const rows = finalRuns.map((run, index) => [
    run.standardOrder,
    index + 1,
    run.block,
    ...run.factorValues,
    0,
  ]);
  return {
    colNames,
    rows,
    textCols: [{ name: '点类型', values: finalRuns.map((run) => run.pointType) }],
    responseCol: colNames.length - 1,
    blockCount: blocks,
  };
}

/** 解析 DOE 分析的因子/响应列(页面选择器与项目汇总共用同一份逻辑,保证界面与卡片一致)。
 * factorCols/respCol 为空(或名称在当前数据集中失效)时回落到默认:响应=末列、因子=其余列前 4 个。
 * 因子最多 4 个(detectFactorial 上限),此处统一截断,避免页面与汇总因截断口径不同而分歧。 */
export function resolveDoeColumns(
  colNames: string[],
  factorCols: string[] | null,
  respCol: string | null,
): { factorIdx: number[]; respIdx: number } {
  // 716-R3:逻辑原样抽入 resolveDoeColumnsWide(仅截断上限参数化),本函数行为与历史锚点完全一致。
  return resolveDoeColumnsWide(colNames, factorCols, respCol, 4);
}

/** 716-R3:分数因子分析页使用的列解析——同一回落逻辑,因子截断上限放宽到 maxFactors(默认 7)。 */
export function resolveDoeColumnsWide(
  colNames: string[],
  factorCols: string[] | null,
  respCol: string | null,
  maxFactors: number = MAX_FRACTIONAL_FACTORS,
): { factorIdx: number[]; respIdx: number } {
  const eligible = colNames.map((name, index) => ({ name, index })).filter(({ name }) => isDoeAnalysisColumn(name));
  let respIdx = respCol ? colNames.indexOf(respCol) : -1;
  if (respIdx < 0 || !isDoeAnalysisColumn(colNames[respIdx] ?? '')) respIdx = eligible.length ? eligible[eligible.length - 1].index : -1;
  let factorIdx = (factorCols ?? [])
    .map((n) => colNames.indexOf(n))
    .filter((i) => i >= 0 && i !== respIdx && isDoeAnalysisColumn(colNames[i]));
  if (!factorIdx.length) {
    factorIdx = eligible.map(({ index }) => index).filter((i) => i !== respIdx);
  }
  return { factorIdx: factorIdx.slice(0, maxFactors), respIdx };
}

export interface DoeStructuredReport {
  kind: 'factorial-doe';
  responseName: string;
  factors: Array<{ name: string; low: number; high: number; hasCenter: boolean }>;
  runCount: number;
  method: FactorialResult['method'];
  model: {
    requestedTerms: string[];
    includeCurvature: boolean;
    residualDf?: number;
    mse?: number;
    pse?: number;
    droppedTerms: string[];
    aliases: NonNullable<FactorialResult['aliases']>;
  };
  coefficients: Array<{ term: string; effect: number | null; coefficient: number; t?: number; p?: number; significant: boolean }>;
  runs: Array<{
    row: number;
    standardOrder: number | null;
    runOrder: number;
    block: number | null;
    pointType: string;
    codedLevels: number[];
    factorValues: number[];
    observed: number;
    fitted: number;
    residual: number;
    standardizedResidual: number | null;
  }>;
  curvature: FactorialResult['curvature'] | null;
}

export interface DoeRunMetadata {
  standardOrder?: number;
  runOrder?: number;
  block?: number;
  pointType?: string;
}

/** 专项 DOE 导出的结构化数据；不依赖统一 platform/report.ts。 */
export function buildDoeStructuredReport(
  design: CodedDesign,
  result: FactorialResult,
  responseName: string,
  runMetadata?: DoeRunMetadata[],
): DoeStructuredReport {
  if (runMetadata && runMetadata.length !== design.response.length) {
    throw new Error('DOE 运行元数据行数与设计不一致');
  }
  return {
    kind: 'factorial-doe',
    responseName,
    factors: design.factorNames.map((name, index) => ({ name, ...design.levels[index] })),
    runCount: design.response.length,
    method: result.method,
    model: {
      requestedTerms: [...result.requestedTerms],
      includeCurvature: result.includeCurvature,
      residualDf: result.dfResid,
      mse: result.mse,
      pse: result.pse,
      droppedTerms: result.droppedTerms ? [...result.droppedTerms] : [],
      aliases: result.aliases ? result.aliases.map((alias) => ({ ...alias })) : [],
    },
    coefficients: [
      { term: '常量', effect: null, coefficient: result.grand, significant: false },
      ...(result.block?.coefficients.map((block) => ({
        term: `区组[${block.level}]（参照 ${result.block!.levels[0]}）`,
        effect: null,
        coefficient: block.coef,
        significant: false,
      })) ?? []),
      ...result.terms.map((term) => ({
        term: term.name,
        effect: term.effect,
        coefficient: term.coef,
        t: term.tStat,
        p: term.p,
        significant: term.sig,
      })),
      ...(result.curvature ? [{
        term: '曲率', effect: null, coefficient: result.curvature.coef,
        t: result.curvature.tStat, p: result.curvature.p, significant: result.curvature.sig,
      }] : []),
    ],
    runs: design.response.map((observed, row) => {
      const metadata = runMetadata?.[row];
      const codedLevels = [...design.coded[row]];
      return {
        row: row + 1,
        standardOrder: metadata?.standardOrder ?? null,
        runOrder: metadata?.runOrder ?? row + 1,
        block: metadata?.block ?? null,
        pointType: metadata?.pointType ?? (codedLevels.every((level) => level === 0) ? '中心点' : '因子点'),
        codedLevels,
        factorValues: codedLevels.map((level, factor) => {
          const limits = design.levels[factor];
          return level < 0 ? limits.low : level > 0 ? limits.high : limits.low / 2 + limits.high / 2;
        }),
        observed,
        fitted: result.fits[row],
        residual: result.residuals[row],
        standardizedResidual: result.stdResiduals?.[row] ?? null,
      };
    }),
    curvature: result.curvature ? { ...result.curvature } : null,
  };
}

export interface DoeWorksheetOutput {
  numericColumns: { name: string; values: number[] }[];
  textColumns: { name: string; values: string[] }[];
}

/**
 * 把 DOE 存储项转换为工作表列：拟合值/残差/标准化残差按原运行行严格对齐；
 * 效应与系数按「DOE模型项」行对齐，剩余行留空，避免用 0 冒充缺失值。
 */
export function buildDoeWorksheetOutput(result: FactorialResult): DoeWorksheetOutput {
  const n = result.nRuns;
  const modelRows = [
    { term: '常量', effect: '', coefficient: String(result.grand) },
    ...(result.block?.coefficients.map((block) => ({
      term: `区组[${block.level}]（参照 ${result.block!.levels[0]}）`, effect: '', coefficient: String(block.coef),
    })) ?? []),
    ...result.terms.map((term) => ({ term: term.name, effect: String(term.effect), coefficient: String(term.coef) })),
    ...(result.curvature ? [{ term: '曲率', effect: '', coefficient: String(result.curvature.coef) }] : []),
  ];
  if (modelRows.length > n) throw new Error('可估计模型项数超过工作表行数，无法按行存储');
  const pad = (key: 'term' | 'effect' | 'coefficient') =>
    Array.from({ length: n }, (_, row) => modelRows[row]?.[key] ?? '');
  const numericColumns = [
    { name: 'DOE拟合值', values: [...result.fits] },
    { name: 'DOE残差', values: [...result.residuals] },
    ...(result.stdResiduals ? [{ name: 'DOE标准化残差', values: [...result.stdResiduals] }] : []),
  ];
  const textColumns = [
    { name: 'DOE模型项', values: pad('term') },
    { name: 'DOE效应', values: pad('effect') },
    { name: 'DOE系数', values: pad('coefficient') },
    ...(!result.stdResiduals ? [{ name: 'DOE标准化残差', values: Array(n).fill('不可估计（无残差自由度）') }] : []),
  ];
  return { numericColumns, textColumns };
}

// ==================== 716-R3 ①:一般全因子(每因子 2–5 个手动水平) ====================

/** 一般全因子的因子数上限(与两水平全因子一致);每因子水平数上限。 */
export const GENERAL_MAX_FACTORS = 4;
export const GENERAL_MAX_LEVELS = 5;
export const GENERAL_MIN_LEVELS = 2;

/** 一般全因子的因子定义:名称 + 显式水平值列表(2–5 个,允许不等距)。 */
export interface GeneralFactorLevels { name: string; levels: number[] }

/** 一般全因子设计:levels 为各因子升序去重水平值;levelIndex[r][f] 为第 r 行观测在因子 f 上的水平下标。 */
export interface GeneralFactorialDesign {
  factorNames: string[];
  levels: number[][];
  levelIndex: number[][];
  response: number[];
}

/** 把用户的因子列 + 响应识别为一般全因子设计(每因子 2–5 个数值水平,不要求等距/平衡)。
 * 纯两水平数据同样能通过本检测,但页面约定:两水平检测成功时只走既有两水平引擎,本路径仅接
 * 「存在 ≥3 水平因子(或非规整中值)」的数据,保证两水平行为零回归。 */
export function detectGeneralFactorial(
  factors: { name: string; values: number[] }[],
  response: number[],
): { ok: true; design: GeneralFactorialDesign } | { ok: false; reason: string } {
  if (factors.length < 2) return { ok: false, reason: '一般全因子至少需要 2 个因子列' };
  if (factors.length > GENERAL_MAX_FACTORS) return { ok: false, reason: `一般全因子最多支持 ${GENERAL_MAX_FACTORS} 个因子` };
  const factorNames = factors.map((factor) => factor.name.trim());
  if (factorNames.some((name) => !name)) return { ok: false, reason: '因子名不能为空' };
  if (new Set(factorNames).size !== factorNames.length) return { ok: false, reason: '因子名不能重复' };
  const N = response.length;
  if (N < 4) return { ok: false, reason: '至少需要 4 行数据' };
  if (response.some((value) => !Number.isFinite(value))) return { ok: false, reason: '响应列包含空值或非有限数值' };
  const levels: number[][] = [];
  const levelIndexCols: number[][] = [];
  for (const f of factors) {
    if (f.values.length !== N) return { ok: false, reason: `因子「${f.name}」与响应行数不一致` };
    if (f.values.some((value) => !Number.isFinite(value))) return { ok: false, reason: `因子「${f.name}」包含空值或非有限数值` };
    const uniq = [...new Set(f.values)].sort((a, b) => a - b);
    if (uniq.length < GENERAL_MIN_LEVELS) return { ok: false, reason: `因子「${f.name}」只有 1 个水平,无法分析效应` };
    if (uniq.length > GENERAL_MAX_LEVELS) {
      return { ok: false, reason: `因子「${f.name}」检测到 ${uniq.length} 个水平,一般全因子每因子最多支持 ${GENERAL_MAX_LEVELS} 个水平` };
    }
    const indexOf = new Map(uniq.map((value, index) => [value, index]));
    levels.push(uniq);
    levelIndexCols.push(f.values.map((value) => indexOf.get(value)!));
  }
  const levelIndex = response.map((_, r) => levelIndexCols.map((col) => col[r]));
  return { ok: true, design: { factorNames, levels, levelIndex, response: [...response] } };
}

export interface GeneralAnovaTermRow {
  name: string;                 // 主效应=因子名;交互=「A×B」
  kind: 'main' | 'interaction';
  df: number;
  adjSS: number;
  adjMS: number | null;
  f: number | null;             // 无残差自由度时为 null
  p: number | null;
  sig: boolean;                 // p < 0.05
}

export interface GeneralFactorialResult {
  rows: GeneralAnovaTermRow[];                                  // 因子主效应 + (纳入时)二因子交互
  error: { df: number; adjSS: number; adjMS: number | null };
  total: { df: number; adjSS: number };
  includeInteractions: boolean;
  /** 二因子交互未纳入时的原因说明。 */
  interactionNote?: string;
  /** 因秩亏(缺格等)完全无法估计的项。 */
  inestimableTerms?: string[];
  fits: number[];
  residuals: number[];
  grand: number;
  r2: number;
  r2Adj: number | null;
  factorNames: string[];
  nRuns: number;
  levelMeans: { name: string; levels: number[]; means: number[]; counts: number[] }[];
}

/** 各因子按水平分组的响应均值(主效应图数据,均值按水平算)。 */
export function generalLevelMeans(design: GeneralFactorialDesign): GeneralFactorialResult['levelMeans'] {
  return design.factorNames.map((name, f) => {
    const sums = design.levels[f].map(() => 0);
    const counts = design.levels[f].map(() => 0);
    design.levelIndex.forEach((row, r) => {
      sums[row[f]] += design.response[r];
      counts[row[f]] += 1;
    });
    return {
      name,
      levels: [...design.levels[f]],
      means: sums.map((sum, j) => (counts[j] ? sum / counts[j] : NaN)),
      counts,
    };
  });
}

/** 一般全因子的效应编码(deviation coding)列:水平 j(0..L−2)一列,取值 该水平=+1、末水平=−1、其余=0。 */
function generalEffectColumns(design: GeneralFactorialDesign, factor: number): number[][] {
  const L = design.levels[factor].length;
  return Array.from({ length: L - 1 }, (_, j) =>
    design.levelIndex.map((row) => (row[factor] === j ? 1 : row[factor] === L - 1 ? -1 : 0)));
}

/**
 * 一般全因子多向 ANOVA(≥3 水平因子的分析路径)。
 *
 * 统计口径(注释即规格):
 * - 模型:截距 + 各因子主效应 + (自由度允许时)全部二因子交互,OLS 拟合(效应编码/deviation coding)。
 * - 平方和:每一项的 Adj SS = SSE(去掉该项的模型) − SSE(完整模型),即效应编码下的边际
 *   (Type III)平方和,与 Minitab GLM 默认的 Adj SS 口径一致;平衡设计下退化为经典的
 *   分组均值公式(如主效应 SS = n_level·Σ(水平均值−总均值)²)。不采用序贯(Type I)SS,
 *   以免不平衡数据下结论依赖项的输入顺序。
 * - 二因子交互:仅当纳入后残差自由度 ≥1(即有仿行支撑)才进入模型,否则明确说明无法与
 *   误差分离并把其变异并入误差项;三因子及以上交互本版不纳入。
 * - 检验:F = Adj MS / MSE,P = 1 − F 分布 CDF,α=0.05;残差自由度为 0 时 F/P 置 null。
 * - 缺格导致某项完全别名(秩增量为 0)时,该项记入 inestimableTerms,不冒充 0 显著性。
 */
export function analyzeGeneralFactorial(
  design: GeneralFactorialDesign,
  options: { includeInteractions?: boolean } = {},
): GeneralFactorialResult {
  const { factorNames, levels, levelIndex, response: y } = design;
  const k = factorNames.length;
  const N = y.length;
  if (k < 2 || k > GENERAL_MAX_FACTORS || levels.length !== k) {
    throw new Error(`一般全因子设计必须包含 2–${GENERAL_MAX_FACTORS} 个因子及对应水平定义`);
  }
  const trimmed = factorNames.map((name) => name.trim());
  if (trimmed.some((name, index) => !name || name !== factorNames[index]) || new Set(trimmed).size !== k) {
    throw new Error('一般全因子因子名必须非空且不能重复');
  }
  if (levels.some((ls) => ls.length < GENERAL_MIN_LEVELS || ls.length > GENERAL_MAX_LEVELS
    || ls.some((value) => !Number.isFinite(value)) || new Set(ls).size !== ls.length)) {
    throw new Error(`一般全因子每因子需要 ${GENERAL_MIN_LEVELS}–${GENERAL_MAX_LEVELS} 个互不相同的有限水平值`);
  }
  if (N < 4 || levelIndex.length !== N || y.some((value) => !Number.isFinite(value))) {
    throw new Error('一般全因子设计至少需要 4 行且响应必须为有限数值');
  }
  if (levelIndex.some((row) => row.length !== k
    || row.some((index, f) => !Number.isInteger(index) || index < 0 || index >= levels[f].length))) {
    throw new Error('一般全因子水平下标必须逐行覆盖全部因子且在水平范围内');
  }
  if (factorNames.some((_, f) => new Set(levelIndex.map((row) => row[f])).size !== levels[f].length)) {
    throw new Error('一般全因子每个因子的所有水平都必须至少出现一次');
  }
  if (new Set(y).size < 2) {
    throw new Error('响应所有值相同(零方差),无法进行方差分析;请确认已录入实测响应');
  }

  interface ModelTerm { name: string; kind: 'main' | 'interaction'; cols: number[][] }
  const mains: ModelTerm[] = factorNames.map((name, f) => ({ name, kind: 'main', cols: generalEffectColumns(design, f) }));
  const inters: ModelTerm[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const cols: number[][] = [];
      for (const a of mains[i].cols) for (const b of mains[j].cols) cols.push(a.map((value, r) => value * b[r]));
      inters.push({ name: `${factorNames[i]}×${factorNames[j]}`, kind: 'interaction', cols });
    }
  }
  const buildX = (termList: ModelTerm[]): number[][] =>
    y.map((_, r) => [1, ...termList.flatMap((term) => term.cols.map((col) => col[r]))]);
  const sseOf = (residuals: number[]) => residuals.reduce((sum, value) => sum + value * value, 0);

  // 先试含全部二因子交互的模型,按秩(而非名义参数数)判断是否有残差自由度支撑交互。
  const fitWith = olsFit(buildX([...mains, ...inters]), y);
  const dfWith = N - fitWith.rank;
  const includeInteractions = options.includeInteractions ?? (inters.length > 0 && dfWith >= 1);
  const chosen = includeInteractions ? [...mains, ...inters] : mains;
  const fitFull = includeInteractions ? fitWith : olsFit(buildX(mains), y);
  const interactionNote = !includeInteractions && inters.length
    ? (options.includeInteractions === false
      ? '按设置未纳入二因子交互,其变异并入误差项。'
      : '当前设计无仿行(纳入二因子交互后残差自由度为 0),二因子交互无法与误差分离,未纳入模型;其变异并入误差项。')
    : undefined;

  const grand = mean(y);
  const sst = y.reduce((sum, value) => sum + (value - grand) * (value - grand), 0);
  const sse = sseOf(fitFull.residuals);
  const columnCount = 1 + chosen.reduce((sum, term) => sum + term.cols.length, 0);
  // 平方和的「等效零」阈值:与总平方和同尺度的浮点舍入界,避免把纯舍入残渣当成非零 SS 参与 F=∞ 判定。
  const ssTol = sst * Number.EPSILON * 64 * Math.max(N, columnCount);
  const dfError = N - fitFull.rank;
  const mse = dfError > 0 ? sse / dfError : null;
  const mseIsZero = dfError > 0 && sse <= ssTol;

  const rows: GeneralAnovaTermRow[] = [];
  const inestimable: string[] = [];
  for (const term of chosen) {
    const reduced = chosen.filter((other) => other !== term);
    const fitReduced = olsFit(buildX(reduced), y);
    const df = fitFull.rank - fitReduced.rank;
    if (df <= 0) {
      // 该项的列全部与更低阶已保留列线性相关(缺格/别名),无法单独估计。
      inestimable.push(term.name);
      rows.push({ name: term.name, kind: term.kind, df: 0, adjSS: 0, adjMS: null, f: null, p: null, sig: false });
      continue;
    }
    const adjSS = Math.max(0, sseOf(fitReduced.residuals) - sse);
    const adjMS = adjSS / df;
    let f: number | null = null;
    let p: number | null = null;
    if (dfError > 0) {
      if (mseIsZero) {
        // 完美拟合:非零 SS → 无穷显著(p=0);零 SS → 无信息(p=1)。与 oneWayAnova 口径一致。
        f = adjSS <= ssTol ? 0 : Infinity;
        p = adjSS <= ssTol ? 1 : 0;
      } else {
        f = adjMS / mse!;
        p = 1 - fCdf(f, df, dfError);
      }
    }
    rows.push({ name: term.name, kind: term.kind, df, adjSS, adjMS, f, p, sig: p != null && p < 0.05 });
  }

  return {
    rows,
    error: { df: dfError, adjSS: sse, adjMS: mse },
    total: { df: N - 1, adjSS: sst },
    includeInteractions,
    interactionNote,
    inestimableTerms: inestimable.length ? inestimable : undefined,
    fits: fitFull.fits,
    residuals: fitFull.residuals,
    grand,
    r2: sst > 0 ? 1 - sse / sst : 0,
    r2Adj: dfError > 0 ? 1 - (sse / dfError) / (sst / (N - 1)) : null,
    factorNames: [...factorNames],
    nRuns: N,
    levelMeans: generalLevelMeans(design),
  };
}

/** 新增生成器共用的确定性 LCG 区组内洗牌;常数与 generateFactorialDesign 内联实现一致,种子相同结果可复现。 */
function lcgShuffleByBlock<T>(byBlock: T[][], seed: number | undefined): void {
  let s = (seed ?? 12345) >>> 0;
  const rnd = () => (s = (1103515245 * s + 12345) >>> 0) / 0x100000000;
  for (const blockRuns of byBlock) {
    for (let i = blockRuns.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [blockRuns[i], blockRuns[j]] = [blockRuns[j], blockRuns[i]];
    }
  }
}

const positiveIntegerOption = (value: number | undefined, fallback: number, label: string, minimum: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) throw new Error(`${label}必须是不小于 ${minimum} 的整数`);
  return resolved;
};

/** 生成一般全因子设计(∏水平数 × 仿行数),落表格式与 generateFactorialDesign 完全一致:
 * 标准序/运行序/区组/因子列/末列「响应(待录入)」+ 点类型文本列。
 * - 区组:本版一般全因子不支持多区组(两水平的 2 的幂区组生成元不适用于混合水平),区组列恒为 1。
 * - 点类型:一般全因子没有「角点/中心点」二分——多水平因子的弯曲信息由 ≥3 水平主效应 ANOVA 本身
 *   承载,无需单独曲率项,故所有运行统一记为「因子点」;保留该列使元数据识别管道口径一致。
 * - 标准序:因子 1 变化最快(混合进制 Yates 序);随机化沿用确定性 LCG,同种子完全可复现。 */
export function generateGeneralFactorialDesign(
  factors: GeneralFactorLevels[],
  opts: { replicates?: number; randomize?: boolean; seed?: number } = {},
): GeneratedFactorialDesign {
  const k = factors.length;
  if (k < 2 || k > GENERAL_MAX_FACTORS) throw new Error(`一般全因子设计支持 2–${GENERAL_MAX_FACTORS} 个因子`);
  const names = factors.map((factor) => factor.name.trim());
  if (names.some((name) => !name)) throw new Error('因子名不能为空');
  if (new Set(names).size !== names.length) throw new Error('因子名不能重复');
  for (const factor of factors) {
    if (factor.levels.length < GENERAL_MIN_LEVELS || factor.levels.length > GENERAL_MAX_LEVELS) {
      throw new Error(`因子「${factor.name}」的水平数必须在 ${GENERAL_MIN_LEVELS}–${GENERAL_MAX_LEVELS} 之间`);
    }
    if (factor.levels.some((value) => !Number.isFinite(value))) throw new Error(`因子「${factor.name}」的水平值必须是有限数值`);
    if (new Set(factor.levels).size !== factor.levels.length) throw new Error(`因子「${factor.name}」的水平值不能重复`);
  }
  const reps = positiveIntegerOption(opts.replicates, 1, '仿行数', 1);
  const counts = factors.map((factor) => factor.levels.length);
  const runsPerRep = counts.reduce((product, count) => product * count, 1);
  const generated: GeneratedRun[] = [];
  let standardOrder = 1;
  for (let r = 0; r < reps; r++) {
    for (let combo = 0; combo < runsPerRep; combo++) {
      // 混合进制展开:因子 1 变化最快,与两水平生成器的 Yates 序习惯一致。
      let rest = combo;
      const values = factors.map((factor, j) => {
        const idx = rest % counts[j];
        rest = Math.floor(rest / counts[j]);
        return factor.levels[idx];
      });
      generated.push({ standardOrder: standardOrder++, block: 1, pointType: '因子点', factorValues: values });
    }
  }
  if (opts.randomize) lcgShuffleByBlock([generated], opts.seed);
  const colNames = ['标准序', '运行序', '区组', ...names, '响应(待录入)'];
  const rows = generated.map((run, index) => [run.standardOrder, index + 1, run.block, ...run.factorValues, 0]);
  return {
    colNames,
    rows,
    textCols: [{ name: '点类型', values: generated.map((run) => run.pointType) }],
    responseCol: colNames.length - 1,
    blockCount: 1,
  };
}

// ==================== 716-R3 ②:分数因子 2^(k−p) 设计与折叠 ====================

const FACTOR_LETTERS = 'ABCDEFG';
const RESOLUTION_ROMAN: Record<number, string> = { 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII' };

/**
 * 标准最小失真 2^(k−p) 生成元表(k=3..7)。
 * 生成元与分辨率取自公认的教科书标准设计表(Box–Hunter–Hunter《Statistics for
 * Experimenters》表 6.22 / Montgomery《Design and Analysis of Experiments》附录,
 * 与 Minitab「创建因子设计」的默认设计一致):
 *   3-1: C=AB(III)          4-1: D=ABC(IV)          5-1: E=ABCD(V)
 *   5-2: D=AB,E=AC(III)     6-1: F=ABCDE(VI)        6-2: E=ABC,F=BCD(IV)
 *   6-3: D=AB,E=AC,F=BC(III) 7-1: G=ABCDEF(VII)     7-2: F=ABCD,G=ABDE(IV)
 *   7-3: E=ABC,F=BCD,G=ACD(IV) 7-4: D=AB,E=AC,F=BC,G=ABC(III)
 * subsets 是各生成因子(位置 k−p..k−1)对应的基础因子下标(A=0)。
 */
const FRACTIONAL_GENERATORS: Record<string, { resolution: number; subsets: number[][] }> = {
  '3-1': { resolution: 3, subsets: [[0, 1]] },
  '4-1': { resolution: 4, subsets: [[0, 1, 2]] },
  '5-1': { resolution: 5, subsets: [[0, 1, 2, 3]] },
  '5-2': { resolution: 3, subsets: [[0, 1], [0, 2]] },
  '6-1': { resolution: 6, subsets: [[0, 1, 2, 3, 4]] },
  '6-2': { resolution: 4, subsets: [[0, 1, 2], [1, 2, 3]] },
  '6-3': { resolution: 3, subsets: [[0, 1], [0, 2], [1, 2]] },
  '7-1': { resolution: 7, subsets: [[0, 1, 2, 3, 4, 5]] },
  '7-2': { resolution: 4, subsets: [[0, 1, 2, 3], [0, 1, 3, 4]] },
  '7-3': { resolution: 4, subsets: [[0, 1, 2], [1, 2, 3], [0, 2, 3]] },
  '7-4': { resolution: 3, subsets: [[0, 1], [0, 2], [1, 2], [0, 1, 2]] },
};

export interface FractionalDesignSpec {
  k: number;
  p: number;                       // 0 = 全因子
  runs: number;                    // 2^(k−p),单仿行、未折叠
  resolution: number | null;       // null = 全因子(无混杂)
  resolutionLabel: string;         // 罗马数字;全因子为「完全」
  generators: string[];            // 如 ['D=ABC'];全因子为空数组
  label: string;                   // 如 '2^(5-2)' / '2^5'
}

const fractionalSpec = (k: number, p: number): FractionalDesignSpec => {
  if (p === 0) {
    return { k, p, runs: 1 << k, resolution: null, resolutionLabel: '完全', generators: [], label: `2^${k}` };
  }
  const entry = FRACTIONAL_GENERATORS[`${k}-${p}`];
  if (!entry) throw new Error(`不支持 2^(${k}-${p}) 设计;k=3..7 的标准分数因子见设计选择表`);
  const base = k - p;
  return {
    k,
    p,
    runs: 1 << base,
    resolution: entry.resolution,
    resolutionLabel: RESOLUTION_ROMAN[entry.resolution],
    generators: entry.subsets.map((subset, index) =>
      `${FACTOR_LETTERS[base + index]}=${subset.map((j) => FACTOR_LETTERS[j]).join('')}`),
    label: `2^(${k}-${p})`,
  };
};

/** 设计选择表:给定因子数 k(3..7),返回可选设计(全因子 + 各标准分数)及次数/分辨率。 */
export function fractionalDesignOptions(k: number): FractionalDesignSpec[] {
  if (!Number.isInteger(k) || k < 3 || k > MAX_FRACTIONAL_FACTORS) {
    throw new Error(`分数因子设计支持 3–${MAX_FRACTIONAL_FACTORS} 个因子`);
  }
  const options: FractionalDesignSpec[] = [fractionalSpec(k, 0)];
  for (let p = 1; p < k; p++) {
    if (FRACTIONAL_GENERATORS[`${k}-${p}`]) options.push(fractionalSpec(k, p));
  }
  return options;
}

export type FractionalFold = 'none' | 'full' | number; // number = 指定折叠因子的下标(0-based)

export interface GeneratedFractionalDesign extends GeneratedFactorialDesign {
  resolutionLabel: string;
  generators: string[];
  folded: boolean;
  /** 选中的分部（1-based）；共有 2^p 个互补分部。 */
  fraction: number;
}

function validateFraction(k: number, p: number, fraction: number): void {
  fractionalSpec(k, p);
  const count = 1 << p;
  if (!Number.isInteger(fraction) || fraction < 1 || fraction > count) {
    throw new Error(`分部必须是 1–${count} 的整数`);
  }
}

function fractionMultipliers(p: number, fraction: number): number[] {
  const bits = fraction - 1;
  return Array.from({ length: p }, (_, index) => (bits & (1 << index) ? -1 : 1));
}

function fractionGenerators(k: number, p: number, fraction: number): string[] {
  if (p === 0) return [];
  const base = k - p;
  const subsets = FRACTIONAL_GENERATORS[`${k}-${p}`].subsets;
  const multipliers = fractionMultipliers(p, fraction);
  return subsets.map((subset, index) => {
    const rhs = subset.map((j) => FACTOR_LETTERS[j]).join('');
    return `${FACTOR_LETTERS[base + index]}=${multipliers[index] < 0 ? '−' : ''}${rhs}`;
  });
}

function fractionSignRows(k: number, p: number, fraction: number): number[][] {
  validateFraction(k, p, fraction);
  const base = k - p;
  const subsets = p === 0 ? [] : FRACTIONAL_GENERATORS[`${k}-${p}`].subsets;
  const multipliers = fractionMultipliers(p, fraction);
  return Array.from({ length: 1 << base }, (_, combo) => {
    const signs = new Array<number>(k);
    for (let j = 0; j < base; j++) signs[j] = combo & (1 << j) ? 1 : -1;
    subsets.forEach((subset, index) => {
      signs[base + index] = multipliers[index] * subset.reduce((product, j) => product * signs[j], 1);
    });
    return signs;
  });
}

function foldSignRow(signs: number[], fold: FractionalFold): number[] {
  if (fold === 'none') return [...signs];
  return fold === 'full'
    ? signs.map((value) => -value)
    : signs.map((value, index) => (index === fold ? -value : value));
}

const signKey = (signs: number[]) => signs.map((value) => (value > 0 ? '+' : '-')).join('');

function exactResolution(signRows: number[][]): number | null {
  const k = signRows[0]?.length ?? 0;
  for (let order = 1; order <= k; order++) {
    for (let mask = 1; mask < (1 << k); mask++) {
      let bits = 0;
      for (let work = mask; work > 0; work &= work - 1) bits++;
      if (bits !== order) continue;
      const products = signRows.map((row) => row.reduce(
        (product, value, index) => (mask & (1 << index) ? product * value : product), 1,
      ));
      if (products.every((value) => value === products[0])) return order;
    }
  }
  return null;
}

export interface FractionalFoldPreview {
  baseRuns: number;
  addedRuns: number;
  totalRuns: number;
  effective: boolean;
  resolution: number | null;
  resolutionLabel: string;
  generators: string[];
  fraction: number;
  fractionCount: number;
}

/** 在写入工作表前预检分部与折叠：无效折叠的镜像会与原分部完全重合，addedRuns=0。 */
export function fractionalFoldPreview(
  k: number,
  p: number,
  fold: FractionalFold = 'none',
  fraction = 1,
): FractionalFoldPreview {
  if (!Number.isInteger(k) || k < 3 || k > MAX_FRACTIONAL_FACTORS) {
    throw new Error(`分数因子设计支持 3–${MAX_FRACTIONAL_FACTORS} 个因子`);
  }
  validateFraction(k, p, fraction);
  if (fold !== 'none' && p === 0) throw new Error('全因子设计无别名,无需折叠');
  if (typeof fold === 'number' && (!Number.isInteger(fold) || fold < 0 || fold >= k)) {
    throw new Error('折叠因子下标必须在 0..k-1 之间');
  }
  const baseRows = fractionSignRows(k, p, fraction);
  const baseKeys = new Set(baseRows.map(signKey));
  const foldedRows = fold === 'none' ? [] : baseRows.map((row) => foldSignRow(row, fold));
  const addedRows = foldedRows.filter((row) => !baseKeys.has(signKey(row)));
  const combined = [...baseRows, ...addedRows];
  const resolution = exactResolution(combined);
  return {
    baseRuns: baseRows.length,
    addedRuns: addedRows.length,
    totalRuns: combined.length,
    effective: fold === 'none' || addedRows.length === baseRows.length,
    resolution,
    resolutionLabel: resolution == null ? '完全' : RESOLUTION_ROMAN[resolution] ?? String(resolution),
    generators: fractionGenerators(k, p, fraction),
    fraction,
    fractionCount: 1 << p,
  };
}

/** 生成 2^(k−p) 分数因子设计(p=0 时为 2^k 全因子),支持选择分部与折叠:
 * - 不折叠:2^(k−p)×仿行 次,区组恒为 1;
 * - 全折叠:仅当全部因子取反确实落入互补分部时才追加；若镜像与原分部重合则拒绝生成；
 * - 指定因子折叠:仅该因子符号取反追加(解除该因子与二因子交互的混杂)。
 * 折叠追加的运行记为区组 2(折叠块可作区组进入分析,吸收两批试验间的批次差),标准序在原设计之后
 * 顺延;随机化按区组内 LCG 洗牌,同种子完全可复现。生成的工作表可直接被两水平分析引擎
 * (OLS + estimableColumns)读取,别名项按低阶优先自动剔除并报告混杂关系。 */
export function generateFractionalFactorialDesign(
  factors: FactorDef[],
  p: number,
  opts: { fold?: FractionalFold; fraction?: number; replicates?: number; randomize?: boolean; seed?: number } = {},
): GeneratedFractionalDesign {
  const k = factors.length;
  if (k < 3 || k > MAX_FRACTIONAL_FACTORS) throw new Error(`分数因子设计支持 3–${MAX_FRACTIONAL_FACTORS} 个因子`);
  const names = factors.map((factor) => factor.name.trim());
  if (names.some((name) => !name)) throw new Error('因子名不能为空');
  if (new Set(names).size !== names.length) throw new Error('因子名不能重复');
  if (factors.some((factor) => !Number.isFinite(factor.low) || !Number.isFinite(factor.high))) {
    throw new Error('因子上下限必须是有限数值');
  }
  if (factors.some((factor) => !(factor.low < factor.high))) throw new Error('每个因子必须满足低水平 < 高水平');
  if (!Number.isInteger(p) || p < 0) throw new Error('分数 p 必须是非负整数');
  const fold: FractionalFold = opts.fold ?? 'none';
  const fraction = opts.fraction ?? 1;
  const preview = fractionalFoldPreview(k, p, fold, fraction);
  if (fold !== 'none' && !preview.effective) {
    throw new Error('所选折叠不会增加新的设计点（镜像与原分部完全重复）；请选择指定因子折叠或其他设计');
  }
  const reps = positiveIntegerOption(opts.replicates, 1, '仿行数', 1);
  const signRows = fractionSignRows(k, p, fraction);

  const generated: GeneratedRun[] = [];
  let standardOrder = 1;
  const pushRuns = (block: number, transform: (signs: number[]) => number[]) => {
    for (let r = 0; r < reps; r++) {
      for (const signs of signRows) {
        const finalSigns = transform(signs);
        generated.push({
          standardOrder: standardOrder++,
          block,
          pointType: '因子点',
          factorValues: factors.map((factor, j) => (finalSigns[j] > 0 ? factor.high : factor.low)),
        });
      }
    }
  };
  pushRuns(1, (signs) => signs);
  if (fold !== 'none') pushRuns(2, (signs) => foldSignRow(signs, fold));

  const blockCount = fold !== 'none' ? 2 : 1;
  const byBlock = Array.from({ length: blockCount }, (_, i) => generated.filter((run) => run.block === i + 1));
  if (opts.randomize) lcgShuffleByBlock(byBlock, opts.seed);
  const finalRuns = byBlock.flat();
  const colNames = ['标准序', '运行序', '区组', ...names, '响应(待录入)'];
  const rows = finalRuns.map((run, index) => [run.standardOrder, index + 1, run.block, ...run.factorValues, 0]);
  return {
    colNames,
    rows,
    textCols: [{ name: '点类型', values: finalRuns.map((run) => run.pointType) }],
    responseCol: colNames.length - 1,
    blockCount,
    resolutionLabel: preview.resolutionLabel,
    generators: preview.generators,
    folded: fold !== 'none',
    fraction,
  };
}
