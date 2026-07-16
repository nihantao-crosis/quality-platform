/**
 * 批次J 回归:P0-5 持久化失败不得伪装成功;P1-6 删除失败不谎报;
 * P1-3 statusColor 注入被校验与转义双重阻断。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { platform } from '../../platform/adapter';
import { projectStoreValidationError } from '../../platform/project';
import { buildProjectSummary } from '../../platform/projectSummary';
import type { SavedAnalysis } from '../../store/analyses';

const LS_DATASET = 'qp-dataset-v1';
const LS_ANALYSES = 'qp-analyses-v1';

let origSetItem: typeof Storage.prototype.setItem;
let blockedKeys: Set<string>;

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null; // Web 端场景
  blockedKeys = new Set();
  origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    if (blockedKeys.has(key)) throw new DOMException('quota', 'QuotaExceededError');
    return origSetItem.call(this, key, value);
  };
  useData.getState().resetDemo();
});

afterEach(() => {
  Storage.prototype.setItem = origSetItem;
});

describe('P0-5:导入返回持久化结果,Web 配额满不得伪装成功', () => {
  it('落盘成功 → persisted=true,activeUnpersisted=false', () => {
    const r = useData.getState().importMatrix('小集', ['x'], [[1], [2], [3]]);
    expect(r.persisted).toBe(true);
    expect(r.archiving).toBe(false);
    expect(useData.getState().activeUnpersisted).toBe(false);
    expect(localStorage.getItem(LS_DATASET)).toBeTruthy();
  });

  it('Web 配额满 → persisted=false + activeUnpersisted=true(内存导入成功,数据未落盘)', () => {
    blockedKeys.add(LS_DATASET);
    const r = useData.getState().importMatrix('满集', ['x'], [[1], [2], [3]]);
    expect(r.persisted).toBe(false);
    expect(r.archiving).toBe(false);
    expect(useData.getState().activeUnpersisted).toBe(true);
    expect(useData.getState().model.name).toBe('满集'); // 内存导入本身成功
    expect(localStorage.getItem(LS_DATASET)).toBeNull(); // 但确实没落盘
  });

  it('下一次成功落盘会清除未持久化标记', () => {
    blockedKeys.add(LS_DATASET);
    useData.getState().importMatrix('满集', ['x'], [[1], [2], [3]]);
    expect(useData.getState().activeUnpersisted).toBe(true);
    blockedKeys.delete(LS_DATASET);
    const r2 = useData.getState().importMatrix('回复集', ['x'], [[4], [5], [6]]);
    expect(r2.persisted).toBe(true);
    expect(useData.getState().activeUnpersisted).toBe(false);
  });

  it('帕累托/计数导入同样报告持久化结果', () => {
    const ok = useData.getState().importPareto('帕', [{ name: '划伤', count: 5 }, { name: '毛刺', count: 3 }]);
    expect(ok.persisted).toBe(true);
    blockedKeys.add('qp-pareto-v1');
    const fail = useData.getState().importPareto('帕2', [{ name: 'a', count: 1 }, { name: 'b', count: 2 }]);
    expect(fail.persisted).toBe(false);
  });
});

describe('P1-6:删除分析失败不得谎报「已删除」', () => {
  it('持久化成功 → remove 返回 true 且记录消失', () => {
    useApp.setState({ page: 'capability' });
    const entry = useAnalyses.getState().saveCurrent();
    expect(entry).toBeTruthy();
    const ok = useAnalyses.getState().remove(entry!.id);
    expect(ok).toBe(true);
    expect(useAnalyses.getState().saved.find((a) => a.id === entry!.id)).toBeUndefined();
  });

  it('持久化失败 → remove 返回 false 且记录保留', () => {
    useApp.setState({ page: 'capability' });
    const entry = useAnalyses.getState().saveCurrent();
    expect(entry).toBeTruthy();
    blockedKeys.add(LS_ANALYSES);
    const ok = useAnalyses.getState().remove(entry!.id);
    expect(ok).toBe(false);
    expect(useAnalyses.getState().saved.find((a) => a.id === entry!.id)).toBeTruthy();
  });
});

describe('P1-3:statusColor 注入的双重阻断', () => {
  const evil = 'red" onmouseover="alert(1)';
  const entry = (over: Partial<SavedAnalysis>): SavedAnalysis => ({
    id: 'a1', kind: 'capability', title: '能力<b>', datasetName: 'ds"q', metric: 'Cpk 1.00',
    status: '能力充足', statusColor: '#2c8a45', statusBg: '#e8f4ea', createdAt: 1720000000000,
    snapshot: {}, ...over,
  });

  it('导入校验:非 hex 颜色被拒绝', () => {
    const bad = [entry({ statusColor: evil })];
    expect(projectStoreValidationError(LS_ANALYSES, bad)).toContain('颜色');
    expect(projectStoreValidationError(LS_ANALYSES, [entry({})])).toBeNull();
  });

  it('汇总 HTML:恶意颜色回退中性色,输出不含事件属性;标题引号被转义', () => {
    const html = buildProjectSummary('注入"测试', [entry({ statusColor: evil, statusBg: evil })]);
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain(evil);
    expect(html).toContain('#5b6472'); // statusColor 回退
    expect(html).toContain('#eef1f4'); // statusBg 回退
    expect(html).toContain('能力&lt;b&gt;');
  });
});
