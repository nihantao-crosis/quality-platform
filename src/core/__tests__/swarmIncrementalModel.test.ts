import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  computeVarModel,
  updateVarModelCell,
  type SpcSigmaMethod,
  type VarModel,
} from '../model';

function editedRows(model: VarModel, row: number, col: number, value: number): number[][] {
  const rows = model.subs.map((subgroup) => subgroup.vals);
  rows[row] = [...rows[row]];
  rows[row][col] = value;
  return rows;
}

function expectSameAsFullRebuild(
  model: VarModel,
  row: number,
  col: number,
  value: number,
  indivSeries?: number[],
): VarModel {
  const incremental = updateVarModelCell(model, row, col, value);
  const rebuilt = computeVarModel(model.name, model.colNames, editedRows(model, row, col, value), {
    isDemo: model.isDemo,
    sigmaMethod: model.sigmaMethod,
    indivSeries,
  });
  expect(incremental).toEqual(rebuilt);
  return incremental;
}

describe('VarModel 单格 copy-on-write 增量更新', () => {
  it.each([
    { n: 1, method: 'classic' as const },
    { n: 2, method: 'classic' as const },
    { n: 5, method: 'pooled' as const },
    { n: 10, method: 'classic' as const },
    { n: 11, method: 'pooled' as const },
  ])('n=$n / $method 的全部字段与完整重建一致', ({ n, method }) => {
    const rows = Array.from({ length: 12 }, (_, row) => (
      Array.from({ length: n }, (_, col) => row * 2.25 - col * 0.7 + (row % 3) * 0.01)
    ));
    const model = computeVarModel(
      `${n}.csv`,
      Array.from({ length: n }, (_, index) => `x${index + 1}`),
      rows,
      { sigmaMethod: method },
    );
    const incremental = expectSameAsFullRebuild(model, 5, Math.min(1, n - 1), -17.125);

    expect(incremental).not.toBe(model);
    expect(incremental.all).not.toBe(model.all);
    expect(incremental.indiv).toBe(incremental.all);
    expect(incremental.subs[5]).not.toBe(model.subs[5]);
    expect(incremental.subs[5].vals).not.toBe(model.subs[5].vals);
    for (let row = 0; row < model.k; row++) {
      if (row === 5) continue;
      expect(incremental.subs[row]).toBe(model.subs[row]);
      expect(incremental.subs[row].vals).toBe(model.subs[row].vals);
    }
  });

  it('classic/pooled 连续多次编辑不使用漂移的增量总和', () => {
    const rows = Array.from({ length: 40 }, (_, row) => [
      1e12 + row * 0.001,
      1e12 + row * 0.001 + 0.0005,
      1e12 + row * 0.001 - 0.00025,
    ]);
    for (const sigmaMethod of ['classic', 'pooled'] satisfies SpcSigmaMethod[]) {
      let incremental = computeVarModel('stable.csv', ['a', 'b', 'c'], rows, { sigmaMethod });
      let currentRows = rows;
      for (let edit = 0; edit < 30; edit++) {
        const row = edit % currentRows.length;
        const col = edit % 3;
        const value = 1e12 + edit * 0.002 + (edit % 5) * 0.00025;
        incremental = updateVarModelCell(incremental, row, col, value);
        currentRows = editedRows(
          computeVarModel('stable.csv', ['a', 'b', 'c'], currentRows, { sigmaMethod }),
          row,
          col,
          value,
        );
      }
      const rebuilt = computeVarModel('stable.csv', ['a', 'b', 'c'], currentRows, { sigmaMethod });
      expect(incremental).toEqual(rebuilt);
    }
  });

  it('确定性随机编辑覆盖 n=1/2..10/超界子组与 classic/pooled', () => {
    let seed = 0x51a7c0de;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (const n of [1, 2, 3, 7, 10, 11]) {
      for (const sigmaMethod of ['classic', 'pooled'] satisfies SpcSigmaMethod[]) {
        const names = Array.from({ length: n }, (_, index) => `c${index + 1}`);
        let rows = Array.from({ length: 23 }, () => (
          Array.from({ length: n }, () => (random() - 0.5) * 1e6)
        ));
        let incremental = computeVarModel('random.csv', names, rows, { sigmaMethod });
        for (let edit = 0; edit < 25; edit++) {
          const row = Math.floor(random() * rows.length);
          const col = Math.floor(random() * n);
          const value = (random() - 0.5) * 1e8;
          incremental = updateVarModelCell(incremental, row, col, value);
          rows = rows.slice();
          rows[row] = [...rows[row]];
          rows[row][col] = value;
          expect(incremental).toEqual(computeVarModel('random.csv', names, rows, { sigmaMethod }));
        }
      }
    }
  });

  it('专用 indivSeries 默认保留，显式 null 则回到编辑后 all', () => {
    const rows = [[1], [2], [3], [4]];
    const custom = [10, 30, 20, 40];
    const model = computeVarModel('custom.csv', ['x'], rows, { indivSeries: custom, isDemo: true });
    const preserved = updateVarModelCell(model, 1, 0, 99);
    expect(preserved.indiv).toBe(model.indiv);
    expect(preserved.mr).toBe(model.mr);
    expect(preserved.indMean).toBe(model.indMean);
    expect(preserved).toEqual(computeVarModel('custom.csv', ['x'], [[1], [99], [3], [4]], {
      indivSeries: custom,
      isDemo: true,
    }));

    const reset = updateVarModelCell(model, 1, 0, 99, {
      name: 'custom (副本).csv',
      isDemo: false,
      indivSeries: null,
    });
    expect(reset.indiv).toBe(reset.all);
    expect(reset).toEqual(computeVarModel('custom (副本).csv', ['x'], [[1], [99], [3], [4]]));
  });

  it('±MAX 极值路径与完整重建同源，且所有对外派生量保持有限', () => {
    const maximum = Number.MAX_VALUE;
    const rows = [[-maximum, maximum], ...Array.from({ length: 7 }, () => [0, 0])];
    const model = computeVarModel('max.csv', ['a', 'b'], rows, { sigmaMethod: 'pooled' });
    const incremental = updateVarModelCell(model, 7, 1, maximum / 16);
    const rebuilt = computeVarModel('max.csv', ['a', 'b'], editedRows(model, 7, 1, maximum / 16), {
      sigmaMethod: 'pooled',
    });
    expect(incremental).toEqual(rebuilt);
    expect([
      incremental.rbar,
      incremental.sbar,
      incremental.sigmaChart,
      incremental.sigmaChartS,
      incremental.sigmaPooled,
      incremental.sigmaWithin,
      incremental.uclX,
      incremental.lclX,
      incremental.uclR,
      incremental.lclR,
      incremental.uclXs,
      incremental.lclXs,
      incremental.uclS,
      incremental.lclS,
      incremental.mrbar,
      incremental.iSig,
      incremental.iUcl,
      incremental.iLcl,
      incremental.mrUcl,
    ].every(Number.isFinite)).toBe(true);
  });

  it('n=1 跨入/离开极值坐标域两个方向都与完整重建一致', () => {
    const maximum = Number.MAX_VALUE;
    const normalRows = [[-3], [-1], [0], [2], [4]];
    const normal = computeVarModel('transition.csv', ['x'], normalRows);
    const entered = updateVarModelCell(normal, 2, 0, maximum);
    const enteredRows = [[-3], [-1], [maximum], [2], [4]];
    expect(entered).toEqual(computeVarModel('transition.csv', ['x'], enteredRows));

    const left = updateVarModelCell(entered, 2, 0, 0);
    expect(left).toEqual(computeVarModel('transition.csv', ['x'], normalRows));
    expect([
      entered.oMean, entered.oSd, entered.mrbar, entered.indMean,
      entered.iSig, entered.iUcl, entered.iLcl, entered.mrUcl,
      ...entered.mr.filter((value): value is number => value != null),
    ].every(Number.isFinite)).toBe(true);
  });

  it('200k×1 连续更新相对完整重建保持明显性能收益', () => {
    const rows = Array.from({ length: 200_000 }, (_, row) => [row % 997]);
    const initial = computeVarModel('200k.csv', ['x'], rows);
    // 预热 JIT，不把首次函数编译算算入对比。绝对墙钟阈值会因
    // Vitest 并发 worker/CI 负载误报；同一进程、同一输入的相对基准才能
    // 真正抓住“退回每次 computeVarModel 完整重建”的性能回归。
    updateVarModelCell(initial, 0, 0, -1);
    computeVarModel('200k.csv', ['x'], editedRows(initial, 0, 0, -1));

    let incremental = initial;
    let rebuilt = initial;
    let incrementalMs = 0;
    let rebuildMs = 0;
    for (let edit = 0; edit < 10; edit++) {
      const value = edit + 0.25;
      let started = performance.now();
      incremental = updateVarModelCell(incremental, 0, 0, value);
      incrementalMs += performance.now() - started;

      const nextRows = editedRows(rebuilt, 0, 0, value);
      started = performance.now();
      rebuilt = computeVarModel('200k.csv', ['x'], nextRows);
      rebuildMs += performance.now() - started;
    }
    expect(incremental).toEqual(rebuilt);
    expect(incremental.subs[0].vals[0]).toBe(9.25);
    expect(
      incrementalMs,
      `200k×1 增量 ${incrementalMs.toFixed(1)}ms / 完整重建 ${rebuildMs.toFixed(1)}ms`,
    ).toBeLessThan(rebuildMs * 0.75);
  });
});
