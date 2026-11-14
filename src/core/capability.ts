/**
 * 过程能力 — 公式从原型 capability 页逻辑逐字迁移（交接文档 §8.4）。
 * 支持单侧规格：lsl / usl 允许为 null（如平面度只有上限）,
 * Cp/Pp 在单侧时为 null;Cpk/Ppk 取可用侧;Cpm 按 Minitab 单侧式用启用侧距离。
 */
import { phi, invNorm, mean, rootMeanSquare, stdev } from './basicMath';

export interface SpecLimits {
  lsl: number | null;
  tgt: number;
  usl: number | null;
}

export interface CapabilitySpecWarning {
  code: 'distant-spec';
  message: string;
  /** 开启的规格侧中，距样本均值最远的整体标准差倍数。 */
  maxDistanceSigma: number;
}

export interface CapabilityInputOptions {
  /** 只能在用户已对当前“测量/子组角色 + 规格 + 有序观测”显式确认后设为 true。 */
  allowDistantSpec?: boolean;
}

export interface CapabilityResult {
  mean: number;
  n: number;
  sigmaWithin: number;
  sigmaOverall: number;
  cp: number | null; // 双侧才有
  cpk: number; // 至少一侧
  pp: number | null;
  ppk: number;
  cpu: number | null; // 有 USL 才有
  cpl: number | null; // 有 LSL 才有
  cpm: number | null; // min(USL−T, T−LSL)/(3τ)，τ² = Σ(x−T)²/n（Minitab 口径;单侧规格用启用侧距离）
  zBench: number;
  sigmaLevel: number;
  ppm: {
    observed: number;
    within: { belowLsl: number | null; aboveUsl: number | null; total: number };
    overall: { belowLsl: number | null; aboveUsl: number | null; total: number };
  };
  verdict: 'sufficient' | 'marginal' | 'insufficient';
}

/** 将数学上超出 Number 值域的比值饱和到最大有限数，避免报告链传播 Infinity。 */
function finiteRatio(numerator: number, denominator: number, denominatorFactor = 1): number {
  if (numerator === 0) return 0;
  if (!(denominator > 0) || !(denominatorFactor > 0)) {
    return Math.sign(numerator) * Number.MAX_VALUE;
  }
  // 先除以标准差，再除以 3/6，避免先构造 3σ/6σ 而上溢。
  const direct = (numerator / denominator) / denominatorFactor;
  if (Number.isFinite(direct)) return direct;
  // numerator/denominator 可能先上溢，但再除固定因子后的结果仍可表示。
  const reordered = (numerator / denominatorFactor) / denominator;
  return Number.isFinite(reordered) ? reordered : Math.sign(numerator) * Number.MAX_VALUE;
}

/** 稳定计算 (a−b)/(factor·denominator)，包括 a−b 本身上溢的情形。 */
function finiteDifferenceRatio(a: number, b: number, denominator: number, denominatorFactor = 1): number {
  const difference = a - b;
  if (Number.isFinite(difference)) return finiteRatio(difference, denominator, denominatorFactor);
  const coordinateScale = Math.max(Math.abs(a), Math.abs(b), Math.abs(denominator));
  const normalizedNumerator = a / coordinateScale - b / coordinateScale;
  const normalizedDenominator = denominator / coordinateScale;
  return finiteRatio(normalizedNumerator, normalizedDenominator, denominatorFactor);
}

/**
 * 远距离规格是强警告，不是数学上的非法输入。默认调用链仍会在 capabilityInputError
 * 中 fail closed；只有绑定当前 fingerprint 的用户确认才能继续。
 */
export function capabilitySpecDistanceWarning(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
): CapabilitySpecWarning | null {
  if (!Array.isArray(allValues) || allValues.length < 2 || allValues.some((value) => !Number.isFinite(value))) return null;
  if (!Number.isFinite(sigmaWithin) || sigmaWithin <= 0) return null;
  const mu = mean(allValues);
  const sigmaOverall = stdev(allValues);
  if (!Number.isFinite(mu) || !Number.isFinite(sigmaOverall) || sigmaOverall <= 0) return null;
  const distances = [
    spec.lsl != null && Number.isFinite(spec.lsl) ? Math.abs(finiteDifferenceRatio(mu, spec.lsl, sigmaOverall)) : null,
    spec.usl != null && Number.isFinite(spec.usl) ? Math.abs(finiteDifferenceRatio(spec.usl, mu, sigmaOverall)) : null,
  ].filter((value): value is number => value != null);
  const maxDistanceSigma = distances.length ? Math.max(...distances) : 0;
  if (!(maxDistanceSigma > 1000)) return null;
  return {
    code: 'distant-spec',
    maxDistanceSigma,
    message: '启用的规格限与当前数据相距超过 1000 倍标准差（按整体 σ 计），常见原因是切换测量列后沿用了另一量纲的旧规格',
  };
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotateRight = (value: number, shift: number): number => (value >>> shift) | (value << (32 - shift));

/** Small synchronous SHA-256 used only for local acknowledgement tokens. */
function sha256Hex(text: string): string {
  const input = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, '0')).join('');
}

const canonicalNumber = (value: number | null): string | null => (
  value == null ? null : Object.is(value, -0) ? '-0' : value.toString()
);

/**
 * Bind an acknowledgement to the exact ordered observations, measurement and
 * subgroup semantics, specifications and within-sigma estimate.  The previous
 * n/mean/SD summary let different orderings (and some different subgroupings)
 * share a token.  A fixed-size SHA-256 digest keeps persisted state bounded
 * while making every bit of every ordered numeric value part of the token.
 *
 * `subgroupSemantics` is deliberately supplied by the role resolver rather
 * than inferred here: this core function sees flattened values and cannot know
 * whether they came from row subgroups, a constant size, or an ID column.
 */
export function capabilityWarningFingerprint(
  measurementKey: string,
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
  subgroupSemantics = '',
): string | null {
  if (!measurementKey || !capabilitySpecDistanceWarning(allValues, sigmaWithin, spec)) return null;
  const canonical = JSON.stringify({
    v: 2,
    measurementKey,
    subgroupSemantics,
    spec: {
      lsl: canonicalNumber(spec.lsl),
      tgt: canonicalNumber(spec.tgt),
      usl: canonicalNumber(spec.usl),
    },
    sigmaWithin: canonicalNumber(sigmaWithin),
    observations: allValues.map(canonicalNumber),
  });
  return `capability-warning:v2:sha256:${sha256Hex(canonical)}`;
}

/** Cpm 只需要“规格侧距离 / 目标 RMS”，不必把两者还原到可能溢出的量纲。 */
function targetCapabilityIndex(allValues: number[], spec: SpecLimits): number {
  const rawDeviations = allValues.map((value) => value - spec.tgt);
  const rawFinite = rawDeviations.every(Number.isFinite);
  let normalizedDeviations: number[];
  let sideRatio: (limit: number, upper: boolean) => number;

  if (rawFinite) {
    const deviationScale = rawDeviations.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
    if (!(deviationScale > 0)) return 0;
    normalizedDeviations = rawDeviations.map((value) => value / deviationScale);
    sideRatio = (limit, upper) => upper
      ? finiteDifferenceRatio(limit, spec.tgt, deviationScale)
      : finiteDifferenceRatio(spec.tgt, limit, deviationScale);
  } else {
    // 只在有限端点之差已上溢时才转入全局坐标归一化；
    // 普通的“大基值+小波动”仍走上面的原始差值路径，不丢低位。
    const coordinateScale = allValues.reduce(
      (maximum, value) => Math.max(maximum, Math.abs(value)),
      Math.abs(spec.tgt),
    );
    const target = spec.tgt / coordinateScale;
    normalizedDeviations = allValues.map((value) => value / coordinateScale - target);
    sideRatio = (limit, upper) => upper
      ? limit / coordinateScale - target
      : target - limit / coordinateScale;
  }

  const tauNormalized = rootMeanSquare(normalizedDeviations);
  if (!(tauNormalized > 0) || !Number.isFinite(tauNormalized)) return 0;
  const sides: number[] = [];
  if (spec.usl != null) sides.push(finiteRatio(sideRatio(spec.usl, true), tauNormalized, 3));
  if (spec.lsl != null) sides.push(finiteRatio(sideRatio(spec.lsl, false), tauNormalized, 3));
  return Math.max(0, Math.min(...sides));
}

/**
 * 能力分析的统一输入契约。页面、摘要与导出可先用它展示“未运行”原因；
 * computeCapability 自身也会再次校验，避免任何调用方绕过保护。
 */
export function capabilityInputError(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
  options: CapabilityInputOptions = {},
): string | null {
  if (!Array.isArray(allValues) || allValues.length < 2) return '过程能力分析至少需要 2 个观测值';
  if (allValues.some((value) => !Number.isFinite(value))) return '过程能力观测值必须全部为有限数值';
  if (!Number.isFinite(spec.tgt)) return '目标值 Target 必须是有限数值';
  if (spec.lsl != null && !Number.isFinite(spec.lsl)) return '规格下限 LSL 必须是有限数值';
  if (spec.usl != null && !Number.isFinite(spec.usl)) return '规格上限 USL 必须是有限数值';
  if (spec.lsl == null && spec.usl == null) return '至少需要启用一侧规格限';
  if (spec.lsl != null && spec.usl != null && spec.lsl >= spec.usl) {
    return '双侧规格必须满足 LSL < USL';
  }
  const sigmaOverall = stdev(allValues);
  if (!Number.isFinite(sigmaOverall) || sigmaOverall <= 0) {
    return '过程整体标准差为 0 或不可估计，无法计算能力指数';
  }
  if (!Number.isFinite(sigmaWithin) || sigmaWithin <= 0) {
    return '过程组内标准差为 0 或不可估计，无法计算 Cp/Cpk';
  }
  const warning = capabilitySpecDistanceWarning(allValues, sigmaWithin, spec);
  if (warning && !options.allowDistantSpec) return `${warning.message}；请复位规格，或在能力页核对测量角色与 LSL/Target/USL 后显式确认继续`;
  return null;
}

export function computeCapability(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
  options: CapabilityInputOptions = {},
): CapabilityResult {
  const inputError = capabilityInputError(allValues, sigmaWithin, spec, options);
  if (inputError) throw new Error(inputError);
  const { lsl, usl } = spec;
  const mu = mean(allValues);
  const so = stdev(allValues);
  const sw = sigmaWithin;
  const both = lsl != null && usl != null;

  const cpu = usl != null ? finiteDifferenceRatio(usl, mu, sw, 3) : null;
  const cpl = lsl != null ? finiteDifferenceRatio(mu, lsl, sw, 3) : null;
  const cp = both ? finiteDifferenceRatio(usl, lsl, sw, 6) : null;
  const cpk = Math.min(cpu ?? Number.MAX_VALUE, cpl ?? Number.MAX_VALUE);
  const pp = both ? finiteDifferenceRatio(usl, lsl, so, 6) : null;
  const ppk = Math.min(
    usl != null ? finiteDifferenceRatio(usl, mu, so, 3) : Number.MAX_VALUE,
    lsl != null ? finiteDifferenceRatio(mu, lsl, so, 3) : Number.MAX_VALUE,
  );
  // Cpm(Minitab 口径,双审 P1 整改):目标不在规格中点时必须用最近侧距离 min(USL−T, T−LSL)/(3τ),
  // 对称式 (USL−LSL)/(6τ) 会在偏置目标下虚高数倍并与同屏 Cpk/PPM 矛盾;目标居中时两式相等,
  // 既有对中夹具不受影响。τ² = Σ(x−T)²/n(分母 n 与 Minitab 一致;曾被审计误判应为 n−1)。
  // 目标越出规格时最近侧距离为负,截为 0(无望目能力)。
  // 单侧规格也计算(Minitab methods-and-formulas:USL+T → (USL−T)/3τ;LSL+T → (T−LSL)/3τ)。
  const cpm = targetCapabilityIndex(allValues, spec);

  const probability = (value: number) => Math.max(0, Math.min(1, value));
  const ppmUw = usl != null ? probability(1 - phi(finiteDifferenceRatio(usl, mu, sw))) * 1e6 : null;
  const ppmLw = lsl != null ? probability(phi(finiteDifferenceRatio(lsl, mu, sw))) * 1e6 : null;
  const ppmUo = usl != null ? probability(1 - phi(finiteDifferenceRatio(usl, mu, so))) * 1e6 : null;
  const ppmLo = lsl != null ? probability(phi(finiteDifferenceRatio(lsl, mu, so))) * 1e6 : null;
  const obs = allValues.filter((v) => (lsl != null && v < lsl) || (usl != null && v > usl)).length;
  const ppmObs = (obs / allValues.length) * 1e6;
  const totalWithin = Math.min(1e6, (ppmUw ?? 0) + (ppmLw ?? 0));
  const totalOverall = Math.min(1e6, (ppmUo ?? 0) + (ppmLo ?? 0));
  const zBench = invNorm(1 - Math.min(0.999999, totalOverall / 1e6));
  const sigmaLevel = zBench + 1.5;
  return {
    mean: mu,
    n: allValues.length,
    sigmaWithin: sw,
    sigmaOverall: so,
    cp,
    cpk,
    pp,
    ppk,
    cpu,
    cpl,
    cpm,
    zBench,
    sigmaLevel,
    ppm: {
      observed: ppmObs,
      within: { belowLsl: ppmLw, aboveUsl: ppmUw, total: totalWithin },
      overall: { belowLsl: ppmLo, aboveUsl: ppmUo, total: totalOverall },
    },
    verdict: cpk >= 1.33 ? 'sufficient' : cpk >= 1.0 ? 'marginal' : 'insufficient',
  };
}

/** 展示辅助：null → '—' */
export function fmtCap(v: number | null, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits);
}
