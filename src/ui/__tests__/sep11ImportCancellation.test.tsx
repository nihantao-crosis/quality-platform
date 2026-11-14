/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { platform } from '../../platform/adapter';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Modals } from '../shell/Modals';

vi.mock('xlsx', async (original) => {
  const actual = await original<typeof import('xlsx')>();
  return { ...actual, read: vi.fn(actual.read) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function workbook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Y'], [1], [2], [3]]), '数据');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useApp.setState({ modal: null, busyOverlay: null });
});

describe('Excel 取消与串行解析', () => {
  it('预取消不加载 ZIP、不调用 SheetJS', async () => {
    const load = vi.spyOn(JSZip, 'loadAsync');
    const controller = new AbortController();
    controller.abort();
    expect(await xlsxBytesToCsv(workbook(), { signal: controller.signal })).toEqual({ error: '已取消 Excel 导入' });
    expect(load).not.toHaveBeenCalled();
    expect(XLSX.read).not.toHaveBeenCalled();
  });

  it('在途与排队任务均取消，第三个任务串行进入且正常完成', async () => {
    const bytes = workbook();
    const zip = await JSZip.loadAsync(bytes);
    const held = deferred<JSZip>();
    const load = vi.spyOn(JSZip, 'loadAsync').mockImplementationOnce(() => held.promise);
    const controller = new AbortController();
    const first = xlsxBytesToCsv(bytes, { signal: controller.signal });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    controller.abort();
    const queuedController = new AbortController();
    const second = xlsxBytesToCsv(bytes, { signal: queuedController.signal });
    queuedController.abort();
    const third = xlsxBytesToCsv(bytes);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(load).toHaveBeenCalledTimes(1);
    held.resolve(zip);
    expect(await first).toEqual({ error: '已取消 Excel 导入' });
    expect(await second).toEqual({ error: '已取消 Excel 导入' });
    expect(await third).toMatchObject({ sheetName: '数据', csv: 'Y\n1\n2\n3' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(XLSX.read).toHaveBeenCalledTimes(1);
  });

  it('元数据等待期间取消，不启动逐项校验或 SheetJS', async () => {
    const bytes = workbook();
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file('xl/workbook.xml')!;
    const metadata = await entry.async('uint8array');
    const held = deferred<Uint8Array>();
    vi.spyOn(entry, 'async').mockImplementationOnce(() => held.promise);
    const sheet = zip.file('xl/worksheets/sheet1.xml')! as JSZip.JSZipObject & {
      internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
    };
    const stream = vi.spyOn(sheet, 'internalStream');
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(zip);
    const controller = new AbortController();
    const pending = xlsxBytesToCsv(bytes, { signal: controller.signal });
    await waitFor(() => expect(entry.async).toHaveBeenCalled());
    controller.abort();
    held.resolve(metadata);
    expect(await pending).toEqual({ error: '已取消 Excel 导入' });
    expect(stream).not.toHaveBeenCalled();
    expect(XLSX.read).not.toHaveBeenCalled();
  });

  it('正在输出数据的 ZIP 流取消后暂停，后续条目和 SheetJS 都不执行', async () => {
    const bytes = workbook();
    const zip = await JSZip.loadAsync(bytes);
    const sheet = zip.file('xl/worksheets/sheet1.xml')! as JSZip.JSZipObject & {
      internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
    };
    const realStream = sheet.internalStream.bind(sheet);
    const controller = new AbortController();
    const pauses = vi.fn();
    vi.spyOn(sheet, 'internalStream').mockImplementation((type) => {
      const stream = realStream(type);
      const pause = stream.pause.bind(stream);
      stream.pause = () => { pauses(); return pause(); };
      // 注册在校验器处理器之前，触发真实在途流的取消。
      stream.on('data', () => controller.abort());
      return stream;
    });
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(zip);
    expect(await xlsxBytesToCsv(bytes, { signal: controller.signal })).toEqual({ error: '已取消 Excel 导入' });
    expect(pauses).toHaveBeenCalled();
    expect(XLSX.read).not.toHaveBeenCalled();
  });

  it.each(['tab', 'kind', 'close', 'unmount'] as const)('真实弹窗 %s 使在途 XLSX 取消，迟到结果不写回', async (action) => {
    localStorage.clear();
    useData.getState().resetDemo();
    const model = useData.getState().model;
    useApp.setState({ modal: 'import', importTab: 'excel', importKind: 'var', toast: null, busyOverlay: null });
    const bytes = workbook();
    const zip = await JSZip.loadAsync(bytes);
    const held = deferred<JSZip>();
    const load = vi.spyOn(JSZip, 'loadAsync').mockImplementationOnce(() => held.promise);
    vi.spyOn(platform, 'pickImportFile').mockResolvedValueOnce({ name: '旧.xlsx', bytes });
    const view = render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    if (action === 'tab') fireEvent.click(screen.getByRole('tab', { name: 'CSV 文件' }));
    else if (action === 'kind') fireEvent.click(screen.getByLabelText('不良数（P 图）'));
    else if (action === 'close') fireEvent.click(screen.getByRole('button', { name: '取消' }));
    else view.unmount();
    await act(async () => {
      held.resolve(zip);
      // 排到旧任务后，保证它已真正退出，而不是只观察尚未完成的结果。
      await xlsxBytesToCsv(bytes, { signal: AbortSignal.abort() });
    });
    expect(XLSX.read).not.toHaveBeenCalled();
    expect(useData.getState().model).toBe(model);
    expect(useApp.getState().toast).toBeNull();
    expect(screen.queryByText(/✓ 旧/)).toBeNull();
  });

  it('流在 1 MiB 暂停点取消，已排恢复定时器不会重启任务', async () => {
    const source = await JSZip.loadAsync(workbook());
    source.file('padding.bin', new Uint8Array(1024 * 1024));
    source.file('after.bin', new Uint8Array([1]));
    const bytes = await source.generateAsync({ type: 'uint8array' });
    const zip = await JSZip.loadAsync(bytes);
    type Streaming = JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };
    const after = vi.spyOn(zip.file('after.bin')! as Streaming, 'internalStream');
    const controller = new AbortController();
    let onData!: (chunk: Uint8Array) => void;
    const pause = vi.fn();
    const resume = vi.fn(() => {
      onData(new Uint8Array(1024 * 1024));
      queueMicrotask(() => controller.abort());
    });
    const fakeStream = {
      on(event: string, callback: (chunk: Uint8Array) => void) {
        if (event === 'data') onData = callback;
        return fakeStream;
      },
      pause, resume,
    };
    vi.spyOn(zip.file('padding.bin')! as Streaming, 'internalStream')
      .mockReturnValue(fakeStream as unknown as JSZip.JSZipStreamHelper<Uint8Array>);
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(zip);
    expect(await xlsxBytesToCsv(bytes, { signal: controller.signal })).toEqual({ error: '已取消 Excel 导入' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pause).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    expect(XLSX.read).not.toHaveBeenCalled();
  });

  it('关闭后重开弹窗不并发解压，第二个文件可继续导入', async () => {
    useApp.setState({ modal: 'import', importTab: 'excel', importKind: 'var', toast: null, busyOverlay: null });
    const bytes = workbook();
    const zip = await JSZip.loadAsync(bytes);
    const held = deferred<JSZip>();
    const load = vi.spyOn(JSZip, 'loadAsync').mockImplementationOnce(() => held.promise);
    vi.spyOn(platform, 'pickImportFile')
      .mockResolvedValueOnce({ name: '旧.xlsx', bytes })
      .mockResolvedValueOnce({ name: '新.xlsx', bytes });
    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    act(() => useApp.setState({ modal: 'import' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { held.resolve(zip); });
    await screen.findByText(/✓ 新.xlsx/);
    expect(screen.queryByText(/✓ 旧.xlsx/)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    expect(XLSX.read).toHaveBeenCalledTimes(1);
  });
});
