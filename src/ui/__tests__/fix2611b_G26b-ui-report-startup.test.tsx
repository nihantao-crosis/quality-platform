/**
 * fix2611b G26b-ui-report B6:P 图与 C 图同时重建失败时,隔离区只隔离一次、detail 合并两条原因。
 * 真实启动路径(写 localStorage → vi.resetModules → 加载真实 store);只把 core 的重建函数对哨兵名称改为抛错。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const QUARANTINE = 'qp-quarantine-v1';
const ATTR = 'qp-attr-v1';
const BROKEN_P = '重建失败P';
const BROKEN_C = '重建失败C';

function mockCoreRebuildFailures() {
  vi.doMock('../../core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../core')>();
    return {
      ...actual,
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
  const { useSessionLog } = await import('../../store/sessionLog');
  return { useData: data.useData, logs: () => useSessionLog.getState().entries.join('\n') };
}

function quarantined(key: string): { raw: string; detail: string; latestRaw?: string } | undefined {
  const text = localStorage.getItem(QUARANTINE);
  return text ? (JSON.parse(text) as Record<string, { raw: string; detail: string; latestRaw?: string }>)[key] : undefined;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  mockCoreRebuildFailures();
});

afterEach(() => {
  vi.doUnmock('../../core');
  vi.resetModules();
});

describe('B6 P/C 同时重建失败的隔离原因合并', () => {
  it('两者都失败:只隔离一次,detail 同时含 P 与 C 的原因;两者均回落演示', async () => {
    const raw = JSON.stringify({
      p: { name: BROKEN_P, counts: [1, 2, 3], sampleSize: 50 },
      c: { name: BROKEN_C, counts: [4, 5, 6] },
    });
    localStorage.setItem(ATTR, raw);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { useData, logs } = await boot();
    const quarantineWrites = setItem.mock.calls.filter(([key]) => key === QUARANTINE).length;
    setItem.mockRestore();

    expect(useData.getState().pModel.isDemo).toBe(true);
    expect(useData.getState().cModel.isDemo).toBe(true);
    const entry = quarantined(ATTR);
    expect(entry?.raw).toBe(raw);
    expect(entry?.detail).toMatch(/P 图数据「重建失败P」无法重建.*模拟：P 图重建失败/);
    expect(entry?.detail).toMatch(/C 图数据「重建失败C」无法重建.*模拟：C 图重建失败/);
    expect(quarantineWrites, '同一 key 被隔离了两次').toBe(1);
    expect(logs()).toMatch(/启动恢复失败：.*模拟：P 图重建失败.*模拟：C 图重建失败/);
  });

  it('只有 C 失败时 detail 与此前一致(单条原因,不带 P)', async () => {
    localStorage.setItem(ATTR, JSON.stringify({
      p: { name: '装配线', counts: [1, 2, 3], sampleSize: 50 },
      c: { name: BROKEN_C, counts: [4, 5, 6] },
    }));
    const { useData } = await boot();
    expect(useData.getState().pModel.name).toBe('装配线');
    expect(quarantined(ATTR)?.detail).toBe('C 图数据「重建失败C」无法重建，已回退为演示数据：模拟：C 图重建失败');
  });
});
