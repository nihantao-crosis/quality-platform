/**
 * 过程能力 — 公式从原型 capability 页逻辑逐字迁移（交接文档 §8.4）。
 * 支持单侧规格：lsl / usl 允许为 null（如平面度只有上限）,
 * 双侧指标（Cp/Pp/Cpm）在单侧时为 null,Cpk/Ppk 取可用侧。
 */
import { phi, invNorm } from './basicMath';

export interface SpecLimits {
  lsl: number | null;
  tgt: number;
  usl: number | null;
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
  cpm: number | null; // 双侧才有：(USL−LSL)/(6τ)，τ² = Σ(x−T)²/n
  zBench: number;
  sigmaLevel: number;
  ppm: {
    observed: number;
    within: { belowLsl: number | null; aboveUsl: number | null; total: number };
    overall: { belowLsl: number | null; aboveUsl: number | null; total: number };
  };
  verdict: 'sufficient' | 'marginal' | 'insufficient';
}

/**
 * 能力分析的统一输入契约。页面、摘要与导出可先用它展示“未运行”原因；
 * computeCapability 自身也会再次校验，避免任何调用方绕过保护。
 */
export function capabilityInputError(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
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
  const mu = allValues.reduce((sum, value) => sum + value, 0) / allValues.length;
  const sigmaOverall = Math.sqrt(allValues.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (allValues.length - 1));
  if (!Number.isFinite(sigmaOverall) || sigmaOverall <= 0) {
    return '过程整体标准差为 0 或不可估计，无法计算能力指数';
  }
  if (!Number.isFinite(sigmaWithin) || sigmaWithin <= 0) {
    return '过程组内标准差为 0 或不可估计，无法计算 Cp/Cpk';
  }
  // 量纲哨兵(批次716-R2 P0):启用的规格限与数据均值相距超过 1000σ,几乎必然是规格
  // 不属于当前测量特性(典型场景:能力页切换测量列后沿用了另一量纲的旧规格,会产出
  // |Cpk| 数千的虚假结论)。真实过程哪怕极端糟糕/极端优秀也只在几十~几百 σ 量级。
  const sanity = 1000 * sigmaOverall;
  if ((spec.lsl != null && Math.abs(mu - spec.lsl) > sanity) || (spec.usl != null && Math.abs(mu - spec.usl) > sanity)) {
    return '启用的规格限与当前数据相距超过 1000 倍标准差，规格几乎可以肯定不属于本测量特性（常见于切换测量列后沿用旧规格）；请确认或复位 LSL/Target/USL 后再计算';
  }
  return null;
}

export function computeCapability(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
): CapabilityResult {
  const inputError = capabilityInputError(allValues, sigmaWithin, spec);
  if (inputError) throw new Error(inputError);
  const { lsl, usl } = spec;
  const mu = allValues.reduce((a, b) => a + b, 0) / allValues.length;
  const so = Math.sqrt(allValues.reduce((a, b) => a + (b - mu) ** 2, 0) / (allValues.length - 1));
  const sw = sigmaWithin;
  const both = lsl != null && usl != null;

  const cpu = usl != null ? (usl - mu) / (3 * sw) : null;
  const cpl = lsl != null ? (mu - lsl) / (3 * sw) : null;
  const cp = both ? (usl - lsl) / (6 * sw) : null;
  const cpk = Math.min(cpu ?? Infinity, cpl ?? Infinity);
  const pp = both ? (usl - lsl) / (6 * so) : null;
  const ppk = Math.min(
    usl != null ? (usl - mu) / (3 * so) : Infinity,
    lsl != null ? (mu - lsl) / (3 * so) : Infinity,
  );
  const tau = Math.sqrt(allValues.reduce((a, b) => a + (b - spec.tgt) ** 2, 0) / allValues.length);
  const cpm = both ? (usl - lsl) / (6 * tau) : null;

  const ppmUw = usl != null ? (1 - phi((usl - mu) / sw)) * 1e6 : null;
  const ppmLw = lsl != null ? phi((lsl - mu) / sw) * 1e6 : null;
  const ppmUo = usl != null ? (1 - phi((usl - mu) / so)) * 1e6 : null;
  const ppmLo = lsl != null ? phi((lsl - mu) / so) * 1e6 : null;
  const obs = allValues.filter((v) => (lsl != null && v < lsl) || (usl != null && v > usl)).length;
  const ppmObs = (obs / allValues.length) * 1e6;
  const totalOverall = (ppmUo ?? 0) + (ppmLo ?? 0);
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
      within: { belowLsl: ppmLw, aboveUsl: ppmUw, total: (ppmLw ?? 0) + (ppmUw ?? 0) },
      overall: { belowLsl: ppmLo, aboveUsl: ppmUo, total: totalOverall },
    },
    verdict: cpk >= 1.33 ? 'sufficient' : cpk >= 1.0 ? 'marginal' : 'insufficient',
  };
}

/** 展示辅助：null → '—' */
export function fmtCap(v: number | null, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits);
}
