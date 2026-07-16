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

/** 把用户的因子列 + 响应识别为编码设计。每个因子须为 2 水平(可含中心点=中值)。 */
export function detectFactorial(
  factors: { name: string; values: number[] }[],
  response: number[],
  metadata: { blocks?: Array<string | number> } = {},
): { ok: true; design: CodedDesign } | { ok: false; reason: string } {
  if (factors.length < 2) return { ok: false, reason: 'DOE 至少需要 2 个因子列' };
  if (factors.length > 4) return { ok: false, reason: 'DOE 因子最多支持 4 个' };
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
  const { coded, response: y, factorNames } = design;
  const N = y.length;
  const k = factorNames.length;
  if (k < 2 || k > 4 || factorNames.length !== design.levels.length) {
    throw new Error('DOE 编码设计必须包含 2–4 个因子及对应水平定义');
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
  let standardOrder = 1;
  for (let r = 0; r < reps; r++) {
    for (let combo = 0; combo < (1 << k); combo++) {
      generated.push({
        standardOrder: standardOrder++,
        block: blockFor(combo),
        pointType: '因子点',
        factorValues: factors.map((factor, j) => (combo & (1 << j) ? factor.high : factor.low)),
      });
    }
  }
  for (let block = 1; block <= blocks; block++) {
    for (let c = 0; c < centers; c++) {
      generated.push({
        standardOrder: standardOrder++,
        block,
        pointType: '中心点',
        factorValues: factors.map((factor) => factor.low / 2 + factor.high / 2),
      });
    }
  }

  const byBlock = Array.from({ length: blocks }, (_, i) => generated.filter((run) => run.block === i + 1));
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
  const eligible = colNames.map((name, index) => ({ name, index })).filter(({ name }) => isDoeAnalysisColumn(name));
  let respIdx = respCol ? colNames.indexOf(respCol) : -1;
  if (respIdx < 0 || !isDoeAnalysisColumn(colNames[respIdx] ?? '')) respIdx = eligible.length ? eligible[eligible.length - 1].index : -1;
  let factorIdx = (factorCols ?? [])
    .map((n) => colNames.indexOf(n))
    .filter((i) => i >= 0 && i !== respIdx && isDoeAnalysisColumn(colNames[i]));
  if (!factorIdx.length) {
    factorIdx = eligible.map(({ index }) => index).filter((i) => i !== respIdx);
  }
  return { factorIdx: factorIdx.slice(0, 4), respIdx };
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
