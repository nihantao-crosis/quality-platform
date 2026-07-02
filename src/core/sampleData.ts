/**
 * 演示数据集 — 与原型 buildData() 完全一致的确定性伪随机生成
 * （LCG 种子 20260601 等），保证数值对拍一致。
 * 生产版本应替换为 PlatformAdapter 加载的真实数据源。
 */
import { phi } from './basicMath';
import { CONTROL_CONSTANTS_N5 } from './spc';
import type { SubgroupRow } from './model';

export interface DataModel {
  TGT: number;
  LSL: number;
  USL: number;
  k: number;
  n: number;
  subs: SubgroupRow[];
  all: number[];
  xbarbar: number;
  rbar: number;
  uclX: number;
  lclX: number;
  uclR: number;
  lclR: number;
  sigmaWithin: number;
  oMean: number;
  oSd: number;
  Cp: number;
  Cpk: number;
  Pp: number;
  Ppk: number;
  ppm: number;
  ppmU: number;
  ppmL: number;
  oocX: number[];
  means: number[];
  ranges: number[];
  // X̄-S
  svals: number[];
  sbar: number;
  uclXs: number;
  lclXs: number;
  uclS: number;
  lclS: number;
  // I-MR
  indiv: number[];
  mr: (number | null)[];
  mrbar: number;
  indMean: number;
  iUcl: number;
  iLcl: number;
  mrUcl: number;
  iSig: number;
  // P 图
  pN: number;
  pdef: number[];
  pprop: number[];
  pbar: number;
  pUcl: number;
  pLcl: number;
  // C 图
  cdata: number[];
  cbar: number;
  cUcl: number;
  cLcl: number;
}

export function buildData(): DataModel {
  let seed = 20260601;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const randn = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const TGT = 25.0;
  const LSL = 24.9;
  const USL = 25.1;
  const sigma = 0.026;
  const k = 25;
  const n = 5;
  const subs: SubgroupRow[] = [];
  const all: number[] = [];
  for (let i = 0; i < k; i++) {
    let shift = 0;
    if (i >= 15 && i <= 17) shift = 0.05;
    if (i === 21) shift = -0.048;
    const vals: number[] = [];
    for (let j = 0; j < n; j++) {
      const x = TGT + shift + randn() * sigma;
      vals.push(x);
      all.push(x);
    }
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const range = Math.max(...vals) - Math.min(...vals);
    subs.push({ i: i + 1, vals, mean, range });
  }
  const xbarbar = subs.reduce((a, s) => a + s.mean, 0) / k;
  const rbar = subs.reduce((a, s) => a + s.range, 0) / k;
  const { A2, D4, D3, d2, A3, B3, B4 } = CONTROL_CONSTANTS_N5;
  const uclX = xbarbar + A2 * rbar;
  const lclX = xbarbar - A2 * rbar;
  const uclR = D4 * rbar;
  const lclR = D3 * rbar;
  const sigmaWithin = rbar / d2;
  const oMean = all.reduce((a, b) => a + b, 0) / all.length;
  const oSd = Math.sqrt(all.reduce((a, b) => a + (b - oMean) ** 2, 0) / (all.length - 1));
  const Cp = (USL - LSL) / (6 * sigmaWithin);
  const Cpk = Math.min(USL - oMean, oMean - LSL) / (3 * sigmaWithin);
  const Pp = (USL - LSL) / (6 * oSd);
  const Ppk = Math.min(USL - oMean, oMean - LSL) / (3 * oSd);
  const ppmU = (1 - phi((USL - oMean) / oSd)) * 1e6;
  const ppmL = phi((LSL - oMean) / oSd) * 1e6;
  const ppm = ppmU + ppmL;
  const oocX = subs.filter((s) => s.mean > uclX || s.mean < lclX).map((s) => s.i);
  // X̄-S：子组标准差
  const svals = subs.map((s) => Math.sqrt(s.vals.reduce((a, b) => a + (b - s.mean) ** 2, 0) / (n - 1)));
  const sbar = svals.reduce((a, b) => a + b, 0) / svals.length;
  const uclXs = xbarbar + A3 * sbar;
  const lclXs = xbarbar - A3 * sbar;
  const uclS = B4 * sbar;
  const lclS = B3 * sbar;
  // I-MR：单值序列（独立种子 424242）
  let is2 = 424242;
  const ir = () => {
    is2 = (is2 * 1664525 + 1013904223) >>> 0;
    return is2 / 4294967296;
  };
  const irn = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = ir();
    while (v === 0) v = ir();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const indiv: number[] = [];
  for (let i = 0; i < 25; i++) {
    const sh = i >= 18 && i <= 19 ? 0.085 : 0;
    indiv.push(TGT + sh + irn() * sigma * 1.9);
  }
  const mr = indiv.map((v, i) => (i === 0 ? null : Math.abs(v - indiv[i - 1])));
  const mrbar = (mr.slice(1) as number[]).reduce((a, b) => a + b, 0) / (indiv.length - 1);
  const indMean = indiv.reduce((a, b) => a + b, 0) / indiv.length;
  const iSig = mrbar / 1.128;
  const iUcl = indMean + 3 * iSig;
  const iLcl = indMean - 3 * iSig;
  const mrUcl = 3.267 * mrbar;
  // P 图：n=50（独立种子 8181）
  let ps = 8181;
  const pr = () => {
    ps = (ps * 1664525 + 1013904223) >>> 0;
    return ps / 4294967296;
  };
  const pN = 50;
  const pdef: number[] = [];
  for (let i = 0; i < 25; i++) {
    let b = 0.03;
    if (i >= 10 && i <= 11) b = 0.105;
    pdef.push(Math.max(0, Math.round((b + (pr() - 0.5) * 0.028) * pN)));
  }
  const pprop = pdef.map((d) => d / pN);
  const pbar = pdef.reduce((a, b) => a + b, 0) / (pN * 25);
  const pSig = Math.sqrt((pbar * (1 - pbar)) / pN);
  const pUcl = pbar + 3 * pSig;
  const pLcl = Math.max(0, pbar - 3 * pSig);
  // C 图：单位缺陷数（独立种子 6363）
  let cs = 6363;
  const cr = () => {
    cs = (cs * 1664525 + 1013904223) >>> 0;
    return cs / 4294967296;
  };
  const cdata: number[] = [];
  for (let i = 0; i < 25; i++) {
    let mu = 4;
    if (i === 7) mu = 12;
    cdata.push(Math.max(0, Math.round(mu + (cr() - 0.5) * 4.2)));
  }
  const cbar = cdata.reduce((a, b) => a + b, 0) / cdata.length;
  const cSig = Math.sqrt(cbar);
  const cUcl = cbar + 3 * cSig;
  const cLcl = Math.max(0, cbar - 3 * cSig);
  return {
    TGT, LSL, USL, k, n, subs, all, xbarbar, rbar, uclX, lclX, uclR, lclR, sigmaWithin,
    oMean, oSd, Cp, Cpk, Pp, Ppk, ppm, ppmU, ppmL, oocX,
    means: subs.map((s) => s.mean),
    ranges: subs.map((s) => s.range),
    svals, sbar, uclXs, lclXs, uclS, lclS,
    indiv, mr, mrbar, indMean, iUcl, iLcl, mrUcl, iSig,
    pN, pdef, pprop, pbar, pUcl, pLcl,
    cdata, cbar, cUcl, cLcl,
  };
}

/**
 * ANOVA 演示组（Park-Miller LCG）。
 * 种子 3927 使 oneWayAnova 计算出 P≈0.012 且设备 B 均值最高 —
 * 与交接文档校验值和告警叙事一致（原型表格为硬编码，此处改为实算自洽）。
 */
export function anovaGroups(): { name: string; vals: number[] }[] {
  let seed = 3927;
  const r = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const rn = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const mk = (mu: number) => Array.from({ length: 12 }, () => mu + rn() * 0.03);
  return [
    { name: '设备 A', vals: mk(25.0) },
    { name: '设备 B', vals: mk(25.035) },
    { name: '设备 C', vals: mk(24.995) },
  ];
}

/** 缺陷帕累托演示数据（颜色由图表主题注入） */
export const DEFECTS = [
  { name: '尺寸超差', count: 46 },
  { name: '表面划伤', count: 29 },
  { name: '毛刺', count: 18 },
  { name: '装配不良', count: 11 },
  { name: '材料缺陷', count: 6 },
  { name: '其他', count: 4 },
];

/**
 * Gage R&R 演示研究 — 3 操作员 × 10 部件 × 2 次（交叉设计），确定性生成。
 * 方差设定使 %GRR 落在 <10%（可接受）区间，与原型叙事一致。
 */
import type { GageObservation } from './gage';

export const GAGE_TOLERANCE = 0.2; // 公差 = USL − LSL = 25.10 − 24.90

export function gageStudyData(): GageObservation[] {
  let seed = 9090;
  const r = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const rn = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const parts = Array.from({ length: 10 }, () => 25 + rn() * 0.03); // 部件真值
  const opers = Array.from({ length: 3 }, () => rn() * 0.0008); // 操作员偏倚
  const out: GageObservation[] = [];
  for (let p = 0; p < 10; p++)
    for (let o = 0; o < 3; o++)
      for (let t = 0; t < 2; t++)
        out.push({ part: p, operator: o, trial: t, value: parts[p] + opers[o] + rn() * 0.0016 });
  return out;
}
