/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform, type PickedFile } from '../../platform/adapter';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Modals } from '../shell/Modals';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    modal: 'import', importTab: 'csv', importKind: 'var', toast: null, openMenu: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('导入请求单调 epoch', () => {
  it('切换 tab 后旧文件选择结果失效，只有后发请求可写预览', async () => {
    const first = deferred<PickedFile | null>();
    const second = deferred<PickedFile | null>();
    vi.spyOn(platform, 'pickImportFile')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<Modals />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    expect(screen.getByRole('status').textContent).toContain('正在读取');
    fireEvent.click(screen.getByRole('tab', { name: 'Excel 工作簿' }));
    fireEvent.click(screen.getByRole('tab', { name: 'CSV 文件' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    await act(async () => {
      second.resolve({ name: '新.csv', contents: '值\n10\n11\n12' });
      await second.promise;
    });
    await screen.findByText(/✓ 新\.csv/);

    await act(async () => {
      first.resolve({ name: '旧.csv', contents: '值\n1\n2\n3' });
      await first.promise;
    });
    expect(screen.queryByText(/旧\.csv/)).toBeNull();
    expect(screen.getByText(/✓ 新\.csv/)).toBeTruthy();
  });

  it('切换 kind 或关闭弹窗会抑制旧请求的迟到错误 toast', async () => {
    const kindRequest = deferred<PickedFile | null>();
    const closeRequest = deferred<PickedFile | null>();
    vi.spyOn(platform, 'pickImportFile')
      .mockImplementationOnce(() => kindRequest.promise)
      .mockImplementationOnce(() => closeRequest.promise);
    const view = render(<Modals />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    fireEvent.click(screen.getByLabelText('不良数（P 图）'));
    await act(async () => {
      kindRequest.reject(new Error('旧 kind 读取失败'));
      try { await kindRequest.promise; } catch { /* 由组件捕获 */ }
    });
    expect(useApp.getState().toast).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => {
      closeRequest.reject(new Error('关闭后读取失败'));
      try { await closeRequest.promise; } catch { /* 由组件捕获 */ }
    });
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    expect(useApp.getState().toast).toBeNull();
    view.unmount();
  });

  it('读取忙态拒绝重复拖放，完成后允许下一个文件', async () => {
    const oldBytes = deferred<ArrayBuffer>();
    const oldFile = {
      name: '旧拖放.csv',
      size: 16,
      arrayBuffer: () => oldBytes.promise,
    } as unknown as File;
    const nextPayload = new TextEncoder().encode('值\n20\n21\n22');
    const nextFile = {
      name: '新拖放.csv',
      size: nextPayload.byteLength,
      arrayBuffer: async () => nextPayload.slice().buffer,
    } as unknown as File;
    render(<Modals />);
    const dropZone = screen.getByText('拖拽文件到此处，或点击选择文件').parentElement!;

    fireEvent.drop(dropZone, { dataTransfer: { files: [oldFile] } });
    fireEvent.drop(dropZone, { dataTransfer: { files: [nextFile] } });
    expect(screen.queryByText(/✓ 新拖放\.csv/)).toBeNull();

    const oldPayload = new TextEncoder().encode('值\n1\n2\n3');
    await act(async () => {
      oldBytes.resolve(oldPayload.slice().buffer);
      await oldBytes.promise;
    });
    await screen.findByText(/✓ 旧拖放\.csv/);
    fireEvent.drop(dropZone, { dataTransfer: { files: [nextFile] } });
    await screen.findByText(/✓ 新拖放\.csv/);
    expect(screen.queryByText(/✓ 旧拖放\.csv/)).toBeNull();
    expect(screen.getByText(/✓ 新拖放\.csv/)).toBeTruthy();
  });

  it('异步 XLSX 校验错误被 await/catch，结束后清除 busy', async () => {
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({
      name: '损坏.xlsx', bytes: new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
    });
    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(useApp.getState().toast).toMatch(/导入失败/));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: '选择文件' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
