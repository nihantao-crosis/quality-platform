/**
 * 批次720-A：按 Minitab 公布的 d2/d3 基础常数派生控制限。
 *
 * 人工审核只给出了压入力图和聚合量 X̿=1936.94、R̄=591.2，没有给出原始 10×5
 * 工作表。下方 PRESS_ROWS 只构造相同聚合量，用于锁定控制线公式和显示舍入；它不是工厂
 * 原始点序列，也不得作为十个均值/极差点的黄金夹具。取得原始工作表后需另补逐点对拍。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_CONSTANTS, c4Of, computeVarModel, withSigmaMethod, dataDecimals, nf,
  stagedXbar, stagedRange, type NelsonRules,
} from '..';

const RULES: NelsonRules = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };
const REL = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** 标准正态 Φ（仅用于确认 Minitab 表值落在正确的数值积分舍入范围）。 */
function phiCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

describe('720-A1 Minitab 控制图基础常数与派生公式', () => {
  it('公布的 d2 三位表值与数值积分定义在舍入范围内一致', () => {
    for (const n of [2, 3, 5, 7, 10]) {
      const m = 3600;
      const a = -9;
      const h = 18 / m;
      let s = 0;
      for (let i = 0; i <= m; i++) {
        const P = phiCdf(a + i * h);
        const f = 1 - Math.pow(P, n) - Math.pow(1 - P, n);
        s += f * (i === 0 || i === m ? 1 : i % 2 ? 4 : 2);
      }
      expect(Math.abs(CONTROL_CONSTANTS[n].d2 - (s * h) / 3)).toBeLessThan(5.1e-4);
    }
  });

  it('c4 由 lgamma 计算', () => {
    expect(REL(c4Of(2), Math.sqrt(2 / Math.PI), 1e-12)).toBe(true);
    expect(REL(c4Of(5), 0.9399856029866257, 1e-12)).toBe(true);
    expect(REL(c4Of(41), 0.9937701371246276, 1e-12)).toBe(true);
    expect(Number.isNaN(c4Of(1))).toBe(true);
  });

  it('基础值逐格等于夹具，A2/D4 由基础值按公式派生而非二次舍入', () => {
    const url = new URL('./fixtures/spc-control-constant-bases.tsv', import.meta.url);
    const lines = readFileSync(fileURLToPath(url), 'utf8').split('\n')
      .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('n\t'));
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      const [n, d2, d3, c4] = line.split('\t').map(Number);
      const C = CONTROL_CONSTANTS[n];
      expect(C.d2).toBe(d2);
      expect(C.d3).toBe(d3);
      expect(Math.abs(C.c4 - c4)).toBeLessThan(5e-8);
      expect(REL(C.A2, 3 / (C.d2 * Math.sqrt(n)), 1e-12)).toBe(true);
      expect(REL(C.D4, 1 + (3 * C.d3) / C.d2, 1e-12)).toBe(true);
      expect(C.D3).toBeCloseTo(Math.max(0, 1 - (3 * C.d3) / C.d2), 12);
    }
    expect(CONTROL_CONSTANTS[5].A2).toBeCloseTo(3 / (2.326 * Math.sqrt(5)), 12);
    expect(CONTROL_CONSTANTS[5].D4).toBeCloseTo(1 + (3 * 0.8641) / 2.326, 12);
  });
});

/** 聚合公式夹具：X̿=1936.94、R̄=591.2；并非人工图原始十个点。 */
const PRESS_ROWS: number[][] = [
  ...Array.from({ length: 9 }, () => [1641, 1789, 1937, 2085, 2233]),
  [1644, 1790, 1936, 2084, 2228],
];
const COLS5 = ['测1', '测2', '测3', '测4', '测5'];

describe('720-A1 压入力聚合控制线对拍（Minitab 标准 X̄-R）', () => {
  const M = computeVarModel('压入力', COLS5, PRESS_ROWS);

  it('默认方法是 R̄/d2，R 图中心线就是 R̄', () => {
    expect(M.sigmaMethod).toBe('classic');
    expect(M.xbarbar).toBeCloseTo(1936.94, 9);
    expect(M.rbar).toBeCloseTo(591.2, 9);
    expect(M.rCl).toBe(M.rbar);
    expect(withSigmaMethod(M, undefined)).toBe(M);
  });

  it('原始控制限使用 d2=2.326、d3=0.8641', () => {
    const sigma = 591.2 / 2.326;
    expect(M.uclX).toBeCloseTo(1936.94 + (3 * sigma) / Math.sqrt(5), 9);
    expect(M.lclX).toBeCloseTo(1936.94 - (3 * sigma) / Math.sqrt(5), 9);
    expect(M.uclR).toBeCloseTo(591.2 * (1 + (3 * 0.8641) / 2.326), 9);
    expect(M.lclR).toBe(0);
  });

  it('控制线与 ±1/±2SL 显示逐项命中人工审核720', () => {
    expect(nf(M.uclX, 1)).toBe('2277.9');
    expect(nf(M.lclX, 1)).toBe('1595.9');
    expect(nf(M.xbarbar, 1)).toBe('1936.9');
    expect(nf(M.uclR, 0)).toBe('1250');
    expect(nf(M.rCl, 0)).toBe('591');
    const sx = (M.uclX - M.xbarbar) / 3;
    expect([1, 2, -1, -2].map((k) => nf(M.xbarbar + k * sx, 1))).toEqual(['2050.6', '2164.3', '1823.3', '1709.6']);
    const sr = (M.uclR - M.rCl) / 3;
    expect([1, 2, -1, -2].map((k) => nf(M.rCl + k * sr, 0))).toEqual(['811', '1030', '372', '152']);
  });

  it('整数数据的图表显示位数为均值一位、极差零位', () => {
    expect(dataDecimals(M.all)).toBe(0);
    expect(nf(M.uclX, dataDecimals(M.all) + 1)).toBe('2277.9');
    expect(nf(M.uclR, dataDecimals(M.all))).toBe('1250');
  });
});

describe('720-A1 合并标准差是显式可选方法', () => {
  it('只有显式 pooled 才改变图表 sigma 与 R/S 中心线', () => {
    const classic = computeVarModel('压入力', COLS5, PRESS_ROWS);
    const pooled = computeVarModel('压入力', COLS5, PRESS_ROWS, { sigmaMethod: 'pooled' });
    expect(pooled.sigmaMethod).toBe('pooled');
    expect(pooled.sigmaChart).toBe(pooled.sigmaPooled);
    expect(pooled.rCl).toBeCloseTo(CONTROL_CONSTANTS[5].d2 * pooled.sigmaPooled, 12);
    expect(pooled.rCl).not.toBeCloseTo(pooled.rbar, 3);
    expect(withSigmaMethod(classic, 'pooled').uclX).toBeCloseTo(pooled.uclX, 12);
    expect(withSigmaMethod(pooled, 'classic').uclX).toBeCloseTo(classic.uclX, 12);
    expect(pooled.sigmaWithin).toBeCloseTo(591.2 / 2.326, 12);
  });
});

describe('720-A1 I-MR 与分阶段默认口径', () => {
  it('I-MR 使用 Minitab d2(2)=1.128、由 d3 派生 D4', () => {
    const M = computeVarModel('单值', ['x'], [[10], [12], [11], [15], [13]]);
    const mrbar = 9 / 4;
    expect(M.mrUcl).toBeCloseTo((1 + (3 * 0.8525) / 1.128) * mrbar, 12);
    expect(M.iSig).toBeCloseTo(mrbar / 1.128, 12);
  });

  it('分阶段省略方法时等于 classic，pooled 仍可显式选择', () => {
    const labels = [...Array.from({ length: 5 }, () => '甲'), ...Array.from({ length: 5 }, () => '乙')];
    const xd = stagedXbar(PRESS_ROWS, labels, RULES);
    const rd = stagedRange(PRESS_ROWS, labels, RULES);
    const xc = stagedXbar(PRESS_ROWS, labels, RULES, 'classic');
    const rc = stagedRange(PRESS_ROWS, labels, RULES, 'classic');
    expect(xd.uclSeries).toEqual(xc.uclSeries);
    expect(rd.clSeries).toEqual(rc.clSeries);
    expect(rd.clSeries[0]).toBeCloseTo(computeVarModel('A', COLS5, PRESS_ROWS.slice(0, 5)).rbar, 12);
    expect(stagedRange(PRESS_ROWS, labels, RULES, 'pooled').clSeries[0]).not.toBeCloseTo(rd.clSeries[0], 3);
  });
});

describe('720-A3 dataDecimals', () => {
  it('整数/小数/上限/非有限值', () => {
    expect(dataDecimals([1, 2, 30])).toBe(0);
    expect(dataDecimals([1.5, 2, 3.25])).toBe(2);
    expect(dataDecimals([24.994, 25.006])).toBe(3);
    expect(dataDecimals([1.123456])).toBe(3);
    expect(dataDecimals([1.123456], 4)).toBe(4);
    expect(dataDecimals([Number.NaN, 2.5])).toBe(1);
    expect(dataDecimals([1e-9])).toBe(3);
  });
});
