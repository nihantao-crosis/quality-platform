/**
 * fix2609d · G4c-datastore 回归(第 1b 批 G4b 对抗复审)：
 * (1) pristine「未编辑则按名替换」只限 Web 端、源表未变的确定性派生；文件导入/粘贴/桌面端一律改名保全；
 *     按名替换时沿用规格记忆并明示。
 * (2) Web 端挤出确认键不含会变化的请求名：DOE 满 5 条时重试能成功。
 * (3) 本机库删除后，× / 挤出不得把已删内容补回库。
 * (4) 另存为副本返回并提示被挤出的数据集。
 * (6) 标准化/随机数据成功提示拼接改名/挤出说明。
 * 另：活动表已被 × 移出最近列表时，改名写入替换它同样须经确认。
 * 全部调用真实生产函数/真实组件(useData、Worksheet 粘贴、MenuBar、Modals、Doe)。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import {
  DatasetEvictionError,
  cancelPendingDatasetWork,
  datasetWriteNotes,
  rememberSpecFor,
  settlePendingDatasetWrites,
  useData,
} from '../../store/dataStore';
import { Doe } from '../pages/Doe';
import { Worksheet } from '../pages/Worksheet';
import { MenuBar } from '../shell/MenuBar';
import { Modals } from '../shell/Modals';
import { chartTokens } from '../tokens';

function recentNames(): string[] {
  return useData.getState().recents.map((entry) => entry.name);
}

function persistedRecent(name: string): { rows: number[][] } | undefined {
  const raw = localStorage.getItem('qp-recents-v1');
  if (!raw) return undefined;
  return (JSON.parse(raw) as Array<{ name: string; data?: { rows: number[][] } }>)
    .find((entry) => entry.name === name)?.data;
}

function storedSpecs(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem('qp-specs-v1') ?? '{}') as Record<string, unknown>;
}

async function editCell(row: number, col: number, value: number) {
  vi.useFakeTimers();
  useData.getState().updateCell(row, col, value);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
}

function paste(text: string) {
  fireEvent.paste(screen.getByRole('grid'), { clipboardData: { getData: () => text } });
}

function memoryDb(initial: Array<[string, string]> = []) {
  const store = new Map(initial);
  const db: DatasetDb = {
    async put(name, json) { store.set(name, json); },
    async insert(name, json) { if (store.has(name)) return false; store.set(name, json); return true; },
    async get(name) { return store.get(name) ?? null; },
    async list() { return [...store.keys()].map((name) => ({ name, saved_at: '2026-09-26T00:00:00Z', bytes: 10 })); },
    async remove(name) { return store.delete(name); },
    async clear(opId) { const removed = store.size; store.clear(); return { opId, committed: true, removed }; },
    async clearStatus() { return null; },
    async stats() { return { count: store.size, total_bytes: 0, path: ':memory:' }; },
  };
  return { db, store };
}

function clickMenu(menu: string, item: string) {
  const { container } = render(<MenuBar wsName="t" />);
  const top = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === menu);
  expect(top, `未找到「${menu}」菜单`).toBeTruthy();
  fireEvent.click(top!);
  const entry = [...document.querySelectorAll('button, [role="menuitem"]')]
    .find((b) => (b.textContent ?? '').includes(item));
  expect(entry, `未找到「${item}」菜单项`).toBeTruthy();
  fireEvent.click(entry!);
}

/** 最旧的是已编辑的 E.csv，另有 4 张表：最近列表 5 项已满。 */
async function seedFullWithEditedOldest() {
  useData.getState().importMatrix('E.csv', ['x'], [[1], [2], [3]]);
  await editCell(0, 0, 424242);
  for (let i = 1; i <= 4; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
  expect(recentNames()).toEqual(['D4.csv', 'D3.csv', 'D2.csv', 'D1.csv', 'E.csv']);
}

beforeEach(() => {
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({ page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null, openMenu: null, varOpen: false });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('(1) pristine 按名替换只限确定性派生', () => {
  it('Web：未编辑的同名文件再导入(内容不同)另存为「名 (2)」，旧内容仍在最近列表且提示说明', () => {
    const opts = { onNameConflict: 'rename' as const };
    useData.getState().importMatrix('report.csv', ['x'], [[11.11], [2]], [], [], opts);
    const again = useData.getState().importMatrix('report.csv', ['x'], [[3], [4]], [], [], opts);
    expect(again.name).toBe('report (2).csv');
    expect(again.replacedPristine).toBeUndefined();
    expect(persistedRecent('report.csv')?.rows).toEqual([[11.11], [2]]);
    expect(datasetWriteNotes('report.csv', again).join(' ')).toContain('原数据集保留在最近列表');
  });

  it('Web：工作表再次粘贴(内容不同)不替换上一份未编辑的粘贴数据，其规格记忆也保留', () => {
    render(<Worksheet />);
    paste('值\n10\n20');
    expect(useData.getState().model.name).toBe('剪贴板数据');
    rememberSpecFor('剪贴板数据', { lsl: 5, tgt: 15, usl: 25 });
    paste('值\n1\n2\n3');
    expect(useData.getState().model.name).toBe('剪贴板数据 (2)');
    expect(persistedRecent('剪贴板数据')?.rows).toEqual([[10], [20]]);
    expect(storedSpecs()['剪贴板数据']).toEqual({ lsl: 5, tgt: 15, usl: 25 });
    expect(useApp.getState().toast).toContain('本次另存为「剪贴板数据 (2)」');
  });

  it('桌面：未编辑的同名文件再导入，本机库中的旧版不被覆盖', async () => {
    const { db, store } = memoryDb();
    platform.datasetDb = db;
    const opts = { onNameConflict: 'rename' as const };
    useData.getState().importMatrix('report.csv', ['x'], [[11.11], [2]], [], [], opts);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    const again = useData.getState().importMatrix('report.csv', ['x'], [[3], [4]], [], [], opts);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(again.name).toBe('report (2).csv');
    expect(JSON.parse(store.get('report.csv') ?? 'null')?.rows).toEqual([[11.11], [2]]);
  });

  it('Web：源表未变时换条件再筛选按名替换未编辑的子集，规格限沿用并明示替换', async () => {
    useData.getState().importMatrix('A.csv', ['x', 'y'], [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    expect(useData.getState().subsetByCondition('C1 >= 4')).toMatchObject({ ok: true, name: 'A (子集)' });
    rememberSpecFor('A (子集)', { lsl: 0, tgt: 10.5, usl: 99 });
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    const again = useData.getState().subsetByCondition('C1 <= 3');
    expect(again).toMatchObject({ ok: true, name: 'A (子集)' });
    expect(recentNames()).toEqual(['A (子集)', 'A.csv']);
    expect(storedSpecs()['A (子集)']).toEqual({ lsl: 0, tgt: 10.5, usl: 99 });
    const notes = again.ok ? datasetWriteNotes(again.requested, again.outcome).join(' ') : '';
    expect(notes).toContain('已替换未编辑的同名数据集「A (子集)」');
  });

  it('Web：源表在派生后被编辑过，再派生不再视为原样结果，旧子集保留', async () => {
    useData.getState().importMatrix('A.csv', ['x', 'y'], [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    expect(useData.getState().subsetByCondition('C1 >= 4')).toMatchObject({ ok: true, name: 'A (子集)' });
    expect(await useData.getState().loadRecent('A.csv')).toBe(true);
    await editCell(5, 1, 66);
    const again = useData.getState().subsetByCondition('C1 >= 4');
    expect(again).toMatchObject({ ok: true, name: 'A (子集) (2)' });
    expect(persistedRecent('A (子集)')?.rows).toEqual([[4, 40], [5, 50], [6, 60]]);
  });
});

describe('(2) Web 端挤出确认键稳定', () => {
  it('DOE：最近列表满 5 条时首次被拒，按提示重试(设计名已变)即确认并生成', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T10:00:00'));
    try {
      for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`D${i}.csv`, ['x'], [[i], [i + 1]]);
      useApp.setState({ page: 'doe', doeTab: 'create' });
      render(<Doe T={chartTokens('经典', true)} />);
      const button = screen.getByRole('button', { name: '生成设计表 → 工作表' });
      fireEvent.click(button);
      expect(useApp.getState().toast).toContain('最近列表已满');
      expect(useData.getState().model.name).not.toMatch(/^DOE设计_/);
      vi.setSystemTime(new Date('2026-09-26T10:00:07'));
      fireEvent.click(button);
      expect(useData.getState().model.name).toMatch(/^DOE设计_100007_/);
      expect(recentNames()).not.toContain('D1.csv');
      expect(useApp.getState().toast).toContain('「D1.csv」已移出最近列表，浏览器端无法恢复');
    } finally {
      vi.useRealTimers();
    }
  });

  it('活动表已被 × 移出最近列表时，同名改名写入替换它须先确认，确认后提示属实', async () => {
    const opts = { onNameConflict: 'rename' as const };
    useData.getState().importMatrix('G.csv', ['x'], [[1], [2]], [], [], opts);
    await editCell(0, 0, 55.5);
    useData.getState().removeRecent('G.csv');
    let error: unknown = null;
    try { useData.getState().importMatrix('G.csv', ['x'], [[7], [8]], [], [], opts); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DatasetEvictionError);
    expect((error as DatasetEvictionError).evicted).toEqual(['G.csv']);
    expect(useData.getState().model.subs[0].vals).toEqual([55.5]);
    const confirmed = useData.getState().importMatrix('G.csv', ['x'], [[7], [8]], [], [], opts);
    expect(confirmed.name).toBe('G (2).csv');
    expect(datasetWriteNotes('G.csv', confirmed).join(' ')).toContain('已按确认移出最近列表');
  });
});

describe('(3) 本机库删除后不复活', () => {
  it('库中删除 X 后点 × 或 X 被挤出，库中仍无 X', async () => {
    const { db, store } = memoryDb();
    platform.datasetDb = db;
    useData.getState().importMatrix('机密X.csv', ['x'], [[1], [2]]);
    useData.getState().importMatrix('B.csv', ['x'], [[3], [4]]);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(store.has('机密X.csv')).toBe(true);
    useApp.setState({ modal: 'vault' });
    render(<Modals />);
    const row = await screen.findByText('机密X.csv');
    const del = () => [...row.parentElement!.parentElement!.querySelectorAll('button')]
      .find((b) => /删除/.test(b.textContent ?? ''))!;
    fireEvent.click(del());
    fireEvent.click(del());
    await waitFor(() => expect(useApp.getState().toast).toContain('已从数据集库删除 机密X.csv'));
    expect(store.has('机密X.csv')).toBe(false);
    useData.getState().removeRecent('机密X.csv');
    for (let i = 1; i <= 5; i++) useData.getState().importMatrix(`F${i}.csv`, ['x'], [[i], [i + 1]]);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settlePendingDatasetWrites();
    expect(store.has('机密X.csv')).toBe(false);
  });
});

describe('(4)(6) 成功提示拼接挤出/改名说明', () => {
  it('Web：最近列表已满时另存为副本，结果带 evicted，菜单提示点名被移出的数据集', async () => {
    await seedFullWithEditedOldest();
    const copy = useData.getState().saveAsCopy();
    expect(copy.outcome.evicted).toEqual(['E.csv']);
    cleanup();
    await seedFullWithEditedOldest();
    clickMenu('文件', '另存为副本');
    expect(useApp.getState().toast).toContain('已另存为');
    expect(useApp.getState().toast).toContain('「E.csv」已移出最近列表，浏览器端无法恢复');
  });

  it('标准化(菜单)改名时提示原数据集位置', async () => {
    useData.getState().importMatrix('B.csv', ['x', 'y'], [[1, 2], [2, 5], [4, 7], [8, 3]]);
    expect(useData.getState().standardize()?.name).toBe('B (标准化)');
    await editCell(0, 0, 555);
    expect(await useData.getState().loadRecent('B.csv')).toBe(true);
    clickMenu('计算', '标准化');
    expect(useData.getState().model.name).toBe('B (标准化) (2)');
    expect(useApp.getState().toast).toContain('本次另存为「B (标准化) (2)」（原数据集保留在最近列表）');
  });

  it('随机数据弹窗：同参数再生成改名时提示原数据集位置', () => {
    useApp.setState({ modal: 'random' });
    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(useData.getState().model.name).toBe('随机数据 N(25,0.03)');
    act(() => { useApp.setState({ modal: 'random' }); });
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(useData.getState().model.name).toBe('随机数据 N(25,0.03) (2)');
    expect(useApp.getState().toast).toContain('本次另存为「随机数据 N(25,0.03) (2)」（原数据集保留在最近列表）');
  });
});
