/**
 * fix2609 TESTS-01:「在 journal 保护下先释放目标缺失的大键」必须在正常应用状态下验证。
 *
 * 该用例原在 v143DataIntegrityRound2.test.ts 中，只因前序某条成功导入触发
 * appStore.afterSuccessfulMutation → 模块级 prefsPersistenceSuspended=true（生产里只在
 * 导入成功、900ms 后必然刷新的窗口内成立），此后整份文件不再写 qp-prefs-v1，512 字节余量才够用；
 * 单跑 / 乱序时 prefs 的 1139 字节把初始占用顶破配额，导入在 beforeMutation 预写 AQL 账本处被拒。
 *
 * 本文件只放这一条用例：vitest 按文件隔离模块注册表，appStore 的模块级持久化标志在此必为初值。
 * 用例开头显式断言「prefs 与 AQL 账本都已真实落盘」这一前置条件——将来若有人在本文件追加一条
 * 成功导入的用例并排在前面，前置断言会直接报出泄漏，而不是悄悄换成另一个场景继续变绿。
 * 配额按「导入前的全部真实业务占用 + 512」设定，并断言「先写目标、后释放旧键」装不下，
 * 以保证测到的仍是释放顺序本身。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../platform/adapter';
import { applyProjectText } from '../../platform/project';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { AQL_STATE_STORAGE_KEY, useApp } from '../../store/appStore';

const nativeSetItem = Storage.prototype.setItem;

const BUSINESS_KEYS = [
  'qp-dataset-v1', 'qp-recents-v1', 'qp-attr-v1', 'qp-specs-v1', 'qp-fishbone-v1',
  'qp-analyses-v1', 'qp-analysis-data-v1', 'qp-pareto-v1', 'qp-copy-sequences-v1',
  'qp-quarantine-v1', 'qp-prefs-v1', AQL_STATE_STORAGE_KEY, 'qp-active-ref-v1',
] as const;

function businessOccupancy(): number {
  return BUSINESS_KEYS.reduce((sum, key) => sum + (localStorage.getItem(key)?.length ?? 0), 0);
}

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useAnalyses.setState({ saved: [], lastError: null });
});

afterEach(async () => {
  Storage.prototype.setItem = nativeSetItem;
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('Web stores staging journal 与配额安全顺序（正常应用状态）', () => {
  it('在 journal 保护下先释放目标缺失的大键，最终可容纳的项目不因瞬时配额失败', async () => {
    // 正常应用里 AQL 账本在模块加载时即已落盘；beforeEach 的 localStorage.clear() 把它抹掉了，
    // 这里走生产订阅器（setAqlSwitch → savePersistedAqlState）重新写出，而不是手编账本 JSON。
    useApp.getState().setAqlSwitch(useApp.getState().aqlSwitch);
    const prefs = localStorage.getItem('qp-prefs-v1');
    const ledger = localStorage.getItem(AQL_STATE_STORAGE_KEY);
    expect(prefs, '前置条件失效:qp-prefs-v1 未落盘(prefsPersistenceSuspended 被前序成功导入泄漏?)')
      .not.toBeNull();
    expect(ledger, '前置条件失效:AQL 责任账本未落盘').not.toBeNull();

    const oldSpecs = JSON.stringify(Object.fromEntries(Array.from({ length: 180 }, (_, index) => [
      `旧规格${index}`, { lsl: index, tgt: index + 1, usl: index + 2 },
    ])));
    const targetAnalysisData = JSON.stringify({
      target: {
        name: 'target', colNames: ['x'], rows: [[1], [2]],
        textCols: [{ name: 'note', values: ['新'.repeat(3_000), 'ok'] }],
      },
    });
    const targetAnalyses = JSON.stringify([{
      id: 'target-analysis', kind: 'summary', title: '目标摘要', datasetName: 'target', metric: 'N=2', status: '已完成',
      statusColor: '#000', statusBg: '#fff', createdAt: 1, snapshot: { sourceDataKey: 'target' },
    }]);
    localStorage.setItem('qp-specs-v1', oldSpecs);
    const occupiedBefore = businessOccupancy();
    expect(occupiedBefore).toBeGreaterThanOrEqual(oldSpecs.length + prefs!.length + ledger!.length);
    const targetBytes = targetAnalysisData.length + targetAnalyses.length;
    // 配额 = 导入前真实占用(旧规格 + prefs + AQL 账本 + 其余) + 512 字节余量
    const capacity = occupiedBefore + 512;
    // 场景自检:若实现先写目标再释放旧规格，必然超配额——测的是释放顺序，不是「空间本来就够」。
    expect(occupiedBefore + targetBytes).toBeGreaterThan(capacity);
    // 释放旧规格后目标可容纳(否则用例在断言一个不可能成功的导入)。
    expect(occupiedBefore - oldSpecs.length + targetBytes).toBeLessThanOrEqual(capacity);

    const businessKeys = new Set<string>(BUSINESS_KEYS);
    Storage.prototype.setItem = function capacityStorage(key: string, value: string) {
      // 模拟生产的 IndexedDB 全量 journal + localStorage 小 marker，marker 不占业务配额。
      if (!businessKeys.has(key)) return nativeSetItem.call(this, key, value);
      const projected = [...businessKeys].reduce((sum, item) => {
        if (item === key) return sum + value.length;
        return sum + (localStorage.getItem(item)?.length ?? 0);
      }, 0);
      if (projected > capacity) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    const imported = await applyProjectText(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-analyses-v1': targetAnalyses, 'qp-analysis-data-v1': targetAnalysisData },
    }));
    expect(imported.error).toBeNull();
    expect(localStorage.getItem('qp-specs-v1')).toBeNull();
    expect(localStorage.getItem('qp-analyses-v1')).toBe(targetAnalyses);
    expect(localStorage.getItem('qp-analysis-data-v1')).toBe(targetAnalysisData);
  });
});
