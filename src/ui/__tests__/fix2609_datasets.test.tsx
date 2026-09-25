/**
 * fix2609 · G4-datasets 回归:
 * - STORE-04 / UI-04:派生(子集/标准化/转置/堆叠/随机)、工作表 Ctrl+V、导入弹窗剪贴板/同名文件再导入
 *   不得按固定名称整键覆盖已编辑过的同名数据集(最近列表、本机库、撤销栈、规格记忆)。
 * - STORE-08:Web 端最近列表写入失败后，闸门提示须可操作，且释放空间后可直接恢复切换。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import {
  cancelPendingDatasetWork,
  datasetReplacementBlockReason,
  rememberSpecFor,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';
import { Modals } from '../shell/Modals';
import { SideNav } from '../shell/SideNav';

const nativeSetItem = Storage.prototype.setItem;

function rowsOf(name: string): number[][] | undefined {
  const st = useData.getState();
  if (st.model.name === name) return st.model.subs.map((s) => s.vals);
  return st.recents.find((r) => r.name === name)?.data?.rows;
}

function persistedRecentRows(name: string): number[][] | undefined {
  const raw = localStorage.getItem('qp-recents-v1');
  if (!raw) return undefined;
  const entries = JSON.parse(raw) as Array<{ name: string; data?: { rows: number[][] } }>;
  return entries.find((entry) => entry.name === name)?.data?.rows;
}

/** 单格编辑后立即落盘(与真实 400ms 内的合并持久化等价)。 */
async function editCell(row: number, col: number, value: number) {
  vi.useFakeTimers();
  useData.getState().updateCell(row, col, value);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
}

function memoryDb(): DatasetDb & { puts: Array<{ name: string; json: string }> } {
  const store = new Map<string, string>();
  const puts: Array<{ name: string; json: string }> = [];
  return {
    puts,
    async put(name: string, json: string) { puts.push({ name, json }); store.set(name, json); },
    async get(name: string) { return store.get(name) ?? null; },
    async list() { return [...store.keys()].map((name) => ({ name, saved_at: '', bytes: 0 })); },
    async remove(name: string) { return store.delete(name); },
    async clear(opId: string) { store.clear(); return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  } as unknown as DatasetDb & { puts: Array<{ name: string; json: string }> };
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null });
});

afterEach(async () => {
  cleanup();
  Storage.prototype.setItem = nativeSetItem;
  vi.useRealTimers();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('STORE-04 派生数据集同名写入策略', () => {
  const source = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60], [7, 70], [8, 80]];

  it('换条件再筛选：上一份已编辑的「A (子集)」连同编辑保留，新子集另存为「A (子集) (2)」', async () => {
    useData.getState().importMatrix('A.csv', ['x', 'y'], source);
    const first = useData.getState().subsetByCondition('C1 >= 6');
    expect(first).toMatchObject({ ok: true, name: 'A (子集)', kept: 3 });
    await editCell(0, 1, 777);
    expect(persistedRecentRows('A (子集)')).toEqual([[6, 777], [7, 70], [8, 80]]);

    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const second = useData.getState().subsetByCondition('C1 <= 3');
    expect(second).toMatchObject({ ok: true, name: 'A (子集) (2)', kept: 3 });
    expect(useData.getState().model.name).toBe('A (子集) (2)');
    expect(rowsOf('A (子集) (2)')).toEqual([[1, 10], [2, 20], [3, 30]]);
    // 旧子集中的补录值在内存与 localStorage 中都仍然可恢复
    expect(rowsOf('A (子集)')).toEqual([[6, 777], [7, 70], [8, 80]]);
    expect(persistedRecentRows('A (子集)')).toEqual([[6, 777], [7, 70], [8, 80]]);
    expect(await useData.getState().loadRecent('A (子集)')).toBe(true);
    expect(useData.getState().model.subs.map((s) => s.vals)).toEqual([[6, 777], [7, 70], [8, 80]]);
  });

  it('同一条件重复筛选且内容相同时沿用原名，不制造「(2)(3)…」挤占最近列表', async () => {
    useData.getState().importMatrix('A.csv', ['x', 'y'], source);
    useData.getState().subsetByCondition('C1 <= 3');
    rememberSpecFor('A (子集)', { lsl: 0, tgt: 5, usl: 10 });
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const again = useData.getState().subsetByCondition('C1 <= 3');
    expect(again).toMatchObject({ ok: true, name: 'A (子集)' });
    expect(useData.getState().recents.map((r) => r.name)).toEqual(['A (子集)', 'A.csv']);
    // 内容相同的同名重写不清除该名下记住的规格限
    expect(JSON.parse(localStorage.getItem('qp-specs-v1') ?? '{}')['A (子集)']).toEqual({ lsl: 0, tgt: 5, usl: 10 });
  });

  it('标准化：源表改过一格后再标准化，不覆盖已录入的「B (标准化)」', async () => {
    useData.getState().importMatrix('B.csv', ['x', 'y'], [[1, 2], [2, 5], [4, 7], [8, 3]]);
    expect(useData.getState().standardize()?.name).toBe('B (标准化)');
    await editCell(0, 0, 555);
    expect(await useData.getState().loadRecent('B.csv')).toBe(true);
    await editCell(1, 1, 6);
    expect(useData.getState().standardize()?.name).toBe('B (标准化) (2)');
    expect(rowsOf('B (标准化)')?.[0][0]).toBe(555);
    expect(persistedRecentRows('B (标准化)')?.[0][0]).toBe(555);
  });

  it('同参数随机数据再生成另存为新数据集，上一份随机值(不可复现)保留', () => {
    const first = useData.getState().generateRandom(10, 1, 5, 2).name;
    const firstRows = rowsOf(first);
    const second = useData.getState().generateRandom(10, 1, 5, 2).name;
    expect(first).toBe('随机数据 N(10,1)');
    expect(second).toBe('随机数据 N(10,1) (2)');
    expect(rowsOf(first)).toEqual(firstRows);
    expect(persistedRecentRows(first)).toEqual(firstRows);
  });

  it('转置/堆叠：已编辑的派生表不被再次同操作覆盖；对派生表再做同操作不叠名', async () => {
    useData.getState().importMatrix('t.csv', ['a', 'b', 'c'], [[1, 2, 3], [4, 5, 6]]);
    useData.getState().transposeDataset();
    expect(useData.getState().model.name).toBe('t.csv (转置)');
    await editCell(0, 0, 99);
    expect(await useData.getState().loadRecent('t.csv')).toBe(true);
    useData.getState().transposeDataset();
    expect(useData.getState().model.name).toBe('t.csv (转置) (2)');
    expect(rowsOf('t.csv (转置)')?.[0][0]).toBe(99);
    // 对「t.csv (转置) (2)」再转置：回到同一基名并继续唯一化，不会生成「… (2) (转置)」
    useData.getState().transposeDataset();
    expect(useData.getState().model.name).toBe('t.csv (转置) (3)');
    expect(rowsOf('t.csv (转置)')?.[0][0]).toBe(99);

    // fix2609b M1:Web 端最近列表已满时新建类写入会先要求确认；按提示移除不需要的最近数据集腾出位置
    for (const done of ['t.csv', 't.csv (转置) (2)', 't.csv (转置) (3)']) useData.getState().removeRecent(done);
    useData.getState().importMatrix('s.csv', ['a', 'b'], [[1, 2], [3, 4]]);
    useData.getState().stackColumns();
    expect(useData.getState().model.name).toBe('s.csv (堆叠)');
    await editCell(0, 0, 42);
    expect(await useData.getState().loadRecent('s.csv')).toBe(true);
    useData.getState().stackColumns();
    expect(useData.getState().model.name).toBe('s.csv (堆叠) (2)');
    expect(rowsOf('s.csv (堆叠)')?.[0][0]).toBe(42);
  });

  it('桌面端：同名旧子集已滑出最近列表但仍在本机库时，不按名 upsert 覆盖库中记录', async () => {
    const db = memoryDb();
    platform.datasetDb = db;
    useData.getState().importMatrix('A.csv', ['x', 'y'], source);
    useData.getState().subsetByCondition('C1 >= 6');
    await editCell(0, 1, 777);
    // 再导入 5 张表，把 A 与「A (子集)」都挤出最近列表(桌面端二者仍在本机库)
    for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
    expect(useData.getState().recents.some((r) => r.name === 'A (子集)' || r.name === 'A.csv')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(JSON.parse(await db.get('A (子集)') ?? 'null')?.rows[0]).toEqual([6, 777]);
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const again = useData.getState().subsetByCondition('C1 >= 6');
    expect(again).toMatchObject({ ok: true, name: 'A (子集) (2)' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(db.puts.some((put) => put.name === 'A (子集) (2)')).toBe(true);
    const latest = JSON.parse(await db.get('A (子集)') ?? 'null') as { rows: number[][] } | null;
    expect(latest?.rows[0]).toEqual([6, 777]);
  });
});

describe('UI-04 工作表粘贴 / 导入弹窗同名写入策略', () => {
  function paste(target: Element, text: string) {
    fireEvent.paste(target, { clipboardData: { getData: () => text } });
  }

  it('编辑过的「剪贴板数据」在单元格上再 Ctrl+V 时保留，新粘贴另存为「剪贴板数据 (2)」', async () => {
    render(<Worksheet />);
    paste(screen.getByRole('grid'), '值\n10\n20\n30\n40');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    await editCell(0, 0, 99.5);
    expect(persistedRecentRows('剪贴板数据')?.[0]).toEqual([99.5]);

    paste(screen.getByRole('grid'), '值\n1\n2');
    expect(useData.getState().model.name).toBe('剪贴板数据 (2)');
    expect(useData.getState().model.subs.map((s) => s.vals)).toEqual([[1], [2]]);
    expect(rowsOf('剪贴板数据')?.[0]).toEqual([99.5]);
    expect(persistedRecentRows('剪贴板数据')?.[0]).toEqual([99.5]);
    expect(useApp.getState().toast).toContain('剪贴板数据 (2)');
    expect(useApp.getState().toast).toContain('原数据集保留');
  });

  it('粘贴内容与现有「剪贴板数据」完全相同时沿用原名', () => {
    render(<Worksheet />);
    paste(screen.getByRole('grid'), '值\n1\n2');
    paste(screen.getByRole('grid'), '值\n1\n2');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    expect(useData.getState().recents.filter((r) => r.name.startsWith('剪贴板数据'))).toHaveLength(1);
  });

  it('导入弹窗剪贴板页签：同名「剪贴板数据」已被编辑时另存为新数据集', async () => {
    useData.getState().importMatrix('剪贴板数据', ['值'], [[5], [6]]);
    await editCell(0, 0, 7.25);
    render(<Modals />);
    act(() => useApp.setState({ modal: 'import', importTab: 'clip', importKind: 'var' }));
    fireEvent.change(screen.getByRole('dialog').querySelector('textarea')!, { target: { value: '值\n1\n2\n3' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(useData.getState().model.name).toBe('剪贴板数据 (2)');
    expect(rowsOf('剪贴板数据')?.[0]).toEqual([7.25]);
    expect(persistedRecentRows('剪贴板数据')?.[0]).toEqual([7.25]);
    expect(useApp.getState().toast).toContain('已导入 剪贴板数据 (2)');
  });

  it('同名文件再导入(如 CMM 每日 report.csv)：扩展名保留在末尾，旧的已编辑 report.csv 不被覆盖', async () => {
    const opts = { onNameConflict: 'rename' as const };
    expect(useData.getState().importMatrix('report.csv', ['x'], [[1], [2]], [], [], opts).name).toBe('report.csv');
    await editCell(0, 0, 11);
    expect(useData.getState().importMatrix('report.csv', ['x'], [[3], [4]], [], [], opts).name).toBe('report (2).csv');
    expect(useData.getState().importMatrix('report.csv', ['x'], [[5], [6]], [], [], opts).name).toBe('report (3).csv');
    // 与已存在的「report (2).csv」内容相同 → 复用该名，不再续号
    expect(useData.getState().importMatrix('report.csv', ['x'], [[3], [4]], [], [], opts).name).toBe('report (2).csv');
    expect(rowsOf('report.csv')).toEqual([[11], [2]]);
    // 小数形式的名称不被误判为扩展名
    expect(useData.getState().generateRandom(10, 1.5, 3, 1).name).toBe('随机数据 N(10,1.5)');
    expect(useData.getState().generateRandom(10, 1.5, 3, 1).name).toBe('随机数据 N(10,1.5) (2)');
  });
});

describe('STORE-08 Web 端最近列表写入失败后的恢复路径', () => {
  function failLargeRecents(limit: number) {
    Storage.prototype.setItem = function quota(key: string, value: string) {
      if (key === 'qp-recents-v1' && value.length > limit) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
  }
  const bigRows = Array.from({ length: 400 }, (_, i) => [i + 0.123456, i * 2 + 0.654321]);

  it('闸门提示给出可操作步骤，且不再指向不存在的「重试保存」', () => {
    failLargeRecents(5000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows);
    expect(useData.getState().recentsUnpersisted).toBe(true);
    let message = '';
    try { useData.getState().importMatrix('别的.csv', ['x'], [[1], [2]]); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/最近数据集列表尚未保存/);
    expect(message).not.toContain('重试保存');
    // fix2609b M4:入口名与文件菜单一致(「保存项目文件…」)，不得把用户引到「导出项目汇总…」
    expect(message).toContain('保存项目文件');
    expect(message).toContain('Ctrl+S');
    expect(message).not.toContain('导出项目');
    expect(message).toContain('最近数据集');
    expect(message).toContain('×');
    expect(message).toContain('大表.csv');
    expect(datasetReplacementBlockReason()).toBe(message);
    expect(useData.getState().model.name).toBe('大表.csv');
  });

  it('空间释放后下一次切换自动重试保存并放行，无需先编辑一格', () => {
    failLargeRecents(5000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows);
    expect(() => useData.getState().resetDemo()).toThrow(/最近数据集列表尚未保存/);
    // 用户按提示腾出空间(此处模拟配额恢复)
    Storage.prototype.setItem = nativeSetItem;
    useData.getState().importMatrix('别的.csv', ['x'], [[1], [2]]);
    expect(useData.getState().model.name).toBe('别的.csv');
    expect(useData.getState().recentsUnpersisted).toBe(false);
    // 大表最新矩阵已随最近列表真正落盘，切换未丢数据
    expect(persistedRecentRows('大表.csv')).toEqual(bigRows);
  });

  it('按提示在最近列表移除其他数据集腾出空间后即可切换；侧栏加载失败时保留闸门的可操作提示', async () => {
    useData.getState().importMatrix('旧表.csv', ['x', 'y'], bigRows.slice(0, 150));
    failLargeRecents(7000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows.slice(0, 200));
    expect(useData.getState().recentsUnpersisted).toBe(true);
    render(<SideNav />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /↻ 旧表\.csv/ }));
      await Promise.resolve();
    });
    expect(useData.getState().model.name).toBe('大表.csv');
    expect(useApp.getState().toast).toMatch(/最近数据集列表尚未保存/);
    expect(useApp.getState().toast).not.toContain('已被更新的加载请求取代');

    // 移除不再需要的旧表后，最近列表写得下，闸门解除；当前大表数据完整落盘
    act(() => useData.getState().removeRecent('旧表.csv'));
    expect(useData.getState().recentsUnpersisted).toBe(false);
    expect(persistedRecentRows('大表.csv')).toEqual(bigRows.slice(0, 200));
    useData.getState().importMatrix('新表.csv', ['x'], [[1], [2]]);
    expect(useData.getState().model.name).toBe('新表.csv');
  });
});
