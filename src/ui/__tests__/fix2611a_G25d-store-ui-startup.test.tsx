/**
 * fix2611a G25d D1:启动恢复时已通过结构校验、但重建模型失败的本地数据不得静默回落演示。
 * 真实启动路径：写 localStorage → vi.resetModules → 加载真实 store。被测模块(dataStore)不 mock；
 * 只把 core 的重建函数对哨兵名称改为抛错，模拟「校验器放行、计算层拒绝」这一两层口径漂移。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const QUARANTINE = 'qp-quarantine-v1';
const BROKEN_DATASET = '重建失败.csv';
const BROKEN_P = '重建失败P';
const BROKEN_C = '重建失败C';

const nativeSetItem = Storage.prototype.setItem;

function mockCoreRebuildFailures() {
  vi.doMock('../../core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../core')>();
    return {
      ...actual,
      computeVarModel: (...args: Parameters<typeof actual.computeVarModel>) => {
        if (args[0] === BROKEN_DATASET) throw new Error('模拟：变量模型重建失败');
        return actual.computeVarModel(...args);
      },
      computePChart: (...args: Parameters<typeof actual.computePChart>) => {
        if (args[2] === BROKEN_P) throw new Error('模拟：P 图重建失败');
        return actual.computePChart(...args);
      },
      computeCChart: (...args: Parameters<typeof actual.computeCChart>) => {
        if (args[1] === BROKEN_C) throw new Error('模拟：C 图重建失败');
        return actual.computeCChart(...args);
      },
    };
  });
}

async function boot() {
  const data = await import('../../store/dataStore');
  const { useApp } = await import('../../store/appStore');
  const { useSessionLog } = await import('../../store/sessionLog');
  return { useData: data.useData, useApp, logs: () => useSessionLog.getState().entries.join('\n') };
}

function quarantined(key: string): { raw: string; detail: string } | undefined {
  const text = localStorage.getItem(QUARANTINE);
  return text ? (JSON.parse(text) as Record<string, { raw: string; detail: string }>)[key] : undefined;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  mockCoreRebuildFailures();
});

afterEach(() => {
  Storage.prototype.setItem = nativeSetItem;
  vi.doUnmock('../../core');
  vi.resetModules();
});

describe('D1 启动恢复失败不得静默回落演示', () => {
  it('活动数据集重建失败：原文进隔离区、会话日志含原因、提示一次，且文本列/待录入随模型一起回落', async () => {
    const raw = JSON.stringify({
      name: BROKEN_DATASET,
      colNames: ['x'],
      rows: [[1], [2], [3]],
      textCols: [{ name: '批次', values: ['甲', '乙', '丙'] }],
      pendingCells: [{ row: 0, col: 0 }],
      savedAt: '2026-11-01T00:00:00Z',
    });
    localStorage.setItem('qp-dataset-v1', raw);
    const { useData, useApp, logs } = await boot();

    expect(useData.getState().model.isDemo).toBe(true);
    expect(useData.getState().textCols, '演示矩阵不得配上已存表的文本列').toEqual([]);
    expect(useData.getState().pendingCells).toEqual([]);
    expect(quarantined('qp-dataset-v1')?.raw).toBe(raw);
    expect(quarantined('qp-dataset-v1')?.detail).toMatch(/模拟：变量模型重建失败/);
    expect(localStorage.getItem('qp-dataset-v1'), 'live 原文不得被删除').toBe(raw);
    expect(logs()).toMatch(/启动恢复失败：活动数据集「重建失败\.csv」无法重建.*模拟：变量模型重建失败/);
    expect(useApp.getState().toast).toMatch(/损坏的本地数据.*隔离区/);
  });

  it('P 图重建失败：P 回落演示并隔离计数原文，C 图照常恢复', async () => {
    const raw = JSON.stringify({
      p: { name: BROKEN_P, counts: [1, 2, 3], sampleSize: 50 },
      c: { name: '表面缺陷', counts: [4, 5, 6] },
    });
    localStorage.setItem('qp-attr-v1', raw);
    const { useData, useApp, logs } = await boot();

    expect(useData.getState().pModel.isDemo).toBe(true);
    expect(useData.getState().cModel.name).toBe('表面缺陷');
    expect(quarantined('qp-attr-v1')?.raw).toBe(raw);
    expect(logs()).toMatch(/启动恢复失败：P 图数据「重建失败P」无法重建.*模拟：P 图重建失败/);
    expect(useApp.getState().toast).toMatch(/隔离区/);
  });

  it('C 图重建失败：C 回落演示并隔离计数原文，P 图照常恢复', async () => {
    const raw = JSON.stringify({
      p: { name: '装配线', counts: [1, 2, 3], sampleSize: 50 },
      c: { name: BROKEN_C, counts: [4, 5, 6] },
    });
    localStorage.setItem('qp-attr-v1', raw);
    const { useData, logs } = await boot();

    expect(useData.getState().cModel.isDemo).toBe(true);
    expect(useData.getState().pModel.name).toBe('装配线');
    expect(quarantined('qp-attr-v1')?.raw).toBe(raw);
    expect(logs()).toMatch(/启动恢复失败：C 图数据「重建失败C」无法重建.*模拟：C 图重建失败/);
  });

  it('隔离区写不下时保留写保护：后续保存不得覆盖唯一的原文', async () => {
    const raw = JSON.stringify({
      name: BROKEN_DATASET, colNames: ['x'], rows: [[1], [2]], savedAt: '2026-11-01T00:00:00Z',
    });
    localStorage.setItem('qp-dataset-v1', raw);
    Storage.prototype.setItem = function quotaQuarantine(key: string, value: string) {
      if (key === QUARANTINE) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    const { useData, useApp, logs } = await boot();

    expect(useData.getState().model.isDemo).toBe(true);
    expect(logs()).toMatch(/启动恢复失败：.*隔离失败（可能空间不足），已禁止覆盖原值/);
    expect(useApp.getState().toast).toMatch(/暂时无法复制到隔离区/);
    useData.getState().importMatrix('新表.csv', ['y'], [[7], [8]]);
    expect(localStorage.getItem('qp-dataset-v1'), '写保护失效：原文被新表覆盖').toBe(raw);
  });

  it('正常数据启动不进隔离区、不写失败日志(常规路径不变)', async () => {
    localStorage.setItem('qp-dataset-v1', JSON.stringify({
      name: '正常.csv', colNames: ['x'], rows: [[1], [2]], savedAt: '2026-11-01T00:00:00Z',
    }));
    localStorage.setItem('qp-attr-v1', JSON.stringify({
      p: { name: '装配线', counts: [1, 2], sampleSize: 10 }, c: { name: '表面', counts: [3, 4] },
    }));
    const { useData, logs } = await boot();
    expect(useData.getState().model.name).toBe('正常.csv');
    expect(useData.getState().pModel.name).toBe('装配线');
    expect(useData.getState().cModel.name).toBe('表面');
    expect(localStorage.getItem(QUARANTINE)).toBeNull();
    expect(logs()).not.toMatch(/启动恢复失败/);
  });
});
