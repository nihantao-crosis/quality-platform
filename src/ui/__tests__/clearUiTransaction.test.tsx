/**
 * 清库从第二次确认起就是全局事务：quiesce/SQLite 任一延迟期间
 * 都不得关闭对话框或让应用快捷键穿透。
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const quiescePendingDatasetWorkForClear = vi.hoisted(() => vi.fn());

vi.mock('../../store/dataStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/dataStore')>();
  return { ...actual, quiescePendingDatasetWorkForClear };
});

import App from '../../App';
import { platform, type DatasetDb } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function testDb(overrides: Partial<DatasetDb>): DatasetDb {
  return {
    async put() {},
    async get() { return null; },
    async list() { return []; },
    async remove() { return false; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    modal: 'options', busyOverlay: null, toast: null, openMenu: null, varOpen: false,
  });
  quiescePendingDatasetWorkForClear.mockReset();
  platform.datasetDb = null;
});

afterEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

describe('清库全局交互屏障', () => {
  it('quiesce 与 db.clear 延迟期间都拦截关闭、背景点击和快捷键', async () => {
    const quiesce = deferred<void>();
    const clearing = deferred<{ opId: string; committed: true; removed: number }>();
    quiescePendingDatasetWorkForClear.mockReturnValueOnce(quiesce.promise);
    let clearOpId = '';
    const clear = vi.fn((opId: string) => {
      clearOpId = opId;
      return clearing.promise;
    });
    platform.datasetDb = testDb({ clear });

    render(<App />);
    const clearButton = screen.getByRole('button', { name: '清除数据并恢复演示' });
    fireEvent.click(clearButton);
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));

    expect(useApp.getState().busyOverlay).toContain('停止后台写入');
    expect((screen.getByRole('button', { name: '关闭选项' }) as HTMLButtonElement).disabled).toBe(true);
    expect(clear).not.toHaveBeenCalled();

    const originalName = useData.getState().model.name;
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭选项' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    const shortcutAccepted = fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(shortcutAccepted).toBe(false);
    expect(useApp.getState().modal).toBe('options');
    expect(useData.getState().model.name).toBe(originalName);

    quiesce.resolve();
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(useApp.getState().busyOverlay).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    const dbShortcutAccepted = fireEvent.keyDown(window, { key: 'n', metaKey: true });
    expect(dbShortcutAccepted).toBe(false);
    expect(useApp.getState().modal).toBe('options');
    expect(useData.getState().model.name).toBe(originalName);

    clearing.resolve({ opId: clearOpId, committed: true, removed: 3 });
    await waitFor(() => {
      expect(useApp.getState().busyOverlay).toBeNull();
      expect(useApp.getState().modal).toBeNull();
    });
  });

  it('quiesce 明确失败时恢复交互，且不进入 db.clear', async () => {
    quiescePendingDatasetWorkForClear.mockRejectedValueOnce(new Error('flush failed'));
    const clear = vi.fn();
    platform.datasetDb = testDb({ clear });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));

    await waitFor(() => expect(useApp.getState().busyOverlay).toBeNull());
    expect(clear).not.toHaveBeenCalled();
    expect(useApp.getState().modal).toBe('options');
    expect((screen.getByRole('button', { name: '关闭选项' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
