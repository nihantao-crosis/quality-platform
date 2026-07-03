/**
 * 过程能力 — 公式从原型 capability 页逻辑逐字迁移（交接文档 §8.4）。
 */
import { phi, invNorm } from './basicMath';

export interface SpecLimits {
  lsl: number;
  tgt: number;
  usl: number;
}

export interface CapabilityResult {
  mean: number;
  n: number;
  sigmaWithin: number;
  sigmaOverall: number;
  cp: number;
  cpk: number;
  pp: number;
  ppk: number;
  cpu: number;
  cpl: number;
  cpm: number; // 望目能力 (USL−LSL)/(6τ)，τ² = Σ(x−T)²/n
  zBench: number;
  sigmaLevel: number;
  ppm: {
    observed: number;
    within: { belowLsl: number; aboveUsl: number; total: number };
    overall: { belowLsl: number; aboveUsl: number; total: number };
  };
  verdict: 'sufficient' | 'marginal' | 'insufficient';
}

export function computeCapability(
  allValues: number[],
  sigmaWithin: number,
  spec: SpecLimits,
): CapabilityResult {
  const { lsl, usl } = spec;
  const mu = allValues.reduce((a, b) => a + b, 0) / allValues.length;
  const so = Math.sqrt(allValues.reduce((a, b) => a + (b - mu) ** 2, 0) / (allValues.length - 1));
  const sw = sigmaWithin;
  const cp = (usl - lsl) / (6 * sw);
  const cpk = Math.min(usl - mu, mu - lsl) / (3 * sw);
  const pp = (usl - lsl) / (6 * so);
  const ppk = Math.min(usl - mu, mu - lsl) / (3 * so);
  const cpu = (usl - mu) / (3 * sw);
  const cpl = (mu - lsl) / (3 * sw);
  const tau = Math.sqrt(allValues.reduce((a, b) => a + (b - spec.tgt) ** 2, 0) / allValues.length);
  const cpm = (usl - lsl) / (6 * tau);
  const ppmUw = (1 - phi((usl - mu) / sw)) * 1e6;
  const ppmLw = phi((lsl - mu) / sw) * 1e6;
  const ppmUo = (1 - phi((usl - mu) / so)) * 1e6;
  const ppmLo = phi((lsl - mu) / so) * 1e6;
  const obs = allValues.filter((v) => v < lsl || v > usl).length;
  const ppmObs = (obs / allValues.length) * 1e6;
  const zBench = invNorm(1 - Math.min(0.999999, (ppmUo + ppmLo) / 1e6));
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
      within: { belowLsl: ppmLw, aboveUsl: ppmUw, total: ppmLw + ppmUw },
      overall: { belowLsl: ppmLo, aboveUsl: ppmUo, total: ppmLo + ppmUo },
    },
    verdict: cpk >= 1.33 ? 'sufficient' : cpk >= 1.0 ? 'marginal' : 'insufficient',
  };
}
