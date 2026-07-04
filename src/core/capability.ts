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

export function computeCapability(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
): CapabilityResult {
  const { lsl, usl } = spec;
  if (lsl == null && usl == null) throw new Error('至少需要一侧规格限');
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
