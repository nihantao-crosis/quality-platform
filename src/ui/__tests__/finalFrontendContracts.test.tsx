/** 终局前端合同：异步导出所有权、宽表变量选择与 QPROJ 待恢复锁。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../platform/adapter';
import * as project from '../../platform/project';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Modals } from '../shell/Modals';
import { Toolbar } from '../shell/Toolbar';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    modal: null,
    busyOverlay: null,
    exportFmt: 'excel',
    importTab: 'csv',
    varOpen: false,
    activeVar: undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useApp.setState({ modal: null, busyOverlay: null, varOpen: false });
});

describe('导出弹窗实例所有权', () => {
  it('旧任务完成不关闭后来重开的导出弹窗', async () => {
    let resolveOld!: (path: string) => void;
    const oldJob = new Promise<string>((resolve) => { resolveOld = resolve; });
    const exportFile = vi.spyOn(platform, 'exportFile')
      .mockImplementationOnce(async () => oldJob)
      .mockResolvedValueOnce('new.xlsx');

    useApp.setState({ modal: 'export' });
    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));

    act(() => useApp.setState({ modal: 'calc' }));
    act(() => useApp.setState({ modal: 'export' }));
    await act(async () => { resolveOld('old.xlsx'); await oldJob; });

    expect(useApp.getState().modal).toBe('export');
    expect(screen.getByRole('dialog', { name: '导出报表' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
  });

  it('Excel 描述按真实合同说明为当前分析所用数据与结果', () => {
    useApp.setState({ modal: 'export' });
    render(<Modals />);
    expect(screen.getByText('真 .xlsx · 当前分析所用数据与结果')).toBeTruthy();
  });
});

describe('宽表活动变量选择', () => {
  it('5000 列只渲染前 100 个候选，可搜索并选中末尾列', () => {
    const columns = Array.from({ length: 5000 }, (_, index) => `C${String(index).padStart(4, '0')}`);
    useData.getState().importMatrix('5000列.csv', columns, [
      columns.map((_, index) => index),
      columns.map((_, index) => index + 1),
    ]);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /\u6d3b动变量：/ }));

    const variableList = screen.getByLabelText('活动变量列表');
    expect(variableList.querySelectorAll('button')).toHaveLength(100);
    expect(screen.getByRole('status').textContent).toContain('共 5000 项');
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索活动变量' }), { target: { value: 'C4999' } });
    expect(variableList.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'C4999' }));
    expect(useApp.getState().activeVar).toBe('C4999');
    expect(useApp.getState().varOpen).toBe(false);
  });
});

describe('QPROJ 待恢复锁', () => {
  it('选择文件路径的 lockRequired 错误保持全局阻断', async () => {
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({ name: 'ambiguous.qproj', contents: '{}' });
    vi.spyOn(project, 'applyProjectText').mockResolvedValue({
      error: '无法确认 journal 状态',
      lockRequired: true,
    });
    useApp.setState({ modal: 'import' });
    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(useApp.getState().busyOverlay).toContain('请立即重启'));
  });

  it('拖放路径的 lockRequired 错误保持全局阻断，普通安全失败解锁', async () => {
    const apply = vi.spyOn(project, 'applyProjectText')
      .mockResolvedValueOnce({ error: '事务状态待恢复', lockRequired: true })
      .mockResolvedValueOnce({ error: '文件校验失败', lockRequired: false });
    useApp.setState({ modal: 'import' });
    const { container, unmount } = render(<Modals />);
    const drop = [...container.querySelectorAll('div')]
      .find((element) => (element.getAttribute('style') ?? '').includes('dashed'))!;
    fireEvent.drop(drop, {
      dataTransfer: { files: [new File(['{}'], 'ambiguous.qproj', { type: 'application/json' })] },
    });
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(useApp.getState().busyOverlay).toContain('请立即重启');

    unmount();
    useApp.setState({ modal: 'import', busyOverlay: null });
    const second = render(<Modals />);
    const secondDrop = [...second.container.querySelectorAll('div')]
      .find((element) => (element.getAttribute('style') ?? '').includes('dashed'))!;
    fireEvent.drop(secondDrop, {
      dataTransfer: { files: [new File(['{}'], 'safe.qproj', { type: 'application/json' })] },
    });
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(useApp.getState().busyOverlay).toBeNull();
  });
});
