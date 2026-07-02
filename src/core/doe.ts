/**
 * DOE 2³ 全因子 — 效应/系数/Lenth 检验，从原型 doe 页逻辑逐字迁移（交接文档 §8.5）。
 */
import { median } from './basicMath';

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
