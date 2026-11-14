/** legacy 超限 vault 的可见降容/恢复入口。 @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platform, type DatasetDb } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import { Modals } from '../shell/Modals';

function db(overrides: Partial<DatasetDb> = {}): DatasetDb {
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
  cleanup();
  platform.datasetDb = null;
  useApp.setState({ modal: 'vault', busyOverlay: null, toast: null });
});

afterEach(() => {
  cleanup();
  platform.datasetDb = null;
  useApp.setState({ modal: null, busyOverlay: null, toast: null });
});

describe('数据集库恢复 UI', () => {
  it('list 失败明确报错，不伪装成空库', async () => {
    platform.datasetDb = db({
      async list() { throw new Error('sqlite locked'); },
    });
    render(<Modals />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('sqlite locked');
    expect(alert.textContent).toContain('原子清除');
    expect(screen.queryByText(/库内暂无数据集/)).toBeNull();
  });

  it('历史库总数大于有界列表时显示降容与清空指引', async () => {
    platform.datasetDb = db({
      async list() {
        return [{ name: 'visible', saved_at: '2026-08-13T00:00:00Z', bytes: 1 }];
      },
      async stats() { return { count: 1001, total_bytes: 1001, path: ':memory:' }; },
    });
    render(<Modals />);

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('仅显示最新 1 条'));
    expect(dialog.textContent).toContain('可逐项删除降容');
  });
});
