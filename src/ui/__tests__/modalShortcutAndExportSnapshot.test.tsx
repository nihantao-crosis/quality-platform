/**
 * @vitest-environment jsdom
 * 对话框快捷键隔离与动态导出快照的一致性回归。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { platform } from '../../platform/adapter';
import * as project from '../../platform/project';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Modals } from '../shell/Modals';

const activeReportImport = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
});

vi.mock('../../platform/activeAnalysisReport', async (importOriginal) => {
  await activeReportImport.promise;
  return importOriginal();
});

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard', modal: null, busyOverlay: null, toast: null, openMenu: null,
    exportFmt: 'pdf', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
    spcSigmaMethod: 'classic', spcRules: DEFAULT_SPC_RULES, lslOn: true, uslOn: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useApp.setState({ modal: null, busyOverlay: null, toast: null, openMenu: null });
});

describe('ExportModal 同步快照', () => {
  it('动态模块等待期间切换数据与设置，只会导出完整的后一上下文', async () => {
    useData.getState().importMatrix('上下文A.csv', ['A值'], [[0], [1], [2], [3], [4]]);
    useApp.setState({
      page: 'worksheet', modal: 'export', exportFmt: 'excel',
      spcDataLayout: 'individuals', spcValueCol: 'A值',
      lsl: 0, tgt: 1, usl: 2, lslOn: true, uslOn: true,
    });
    const exportFile = vi.spyOn(platform, 'exportFile').mockResolvedValue(null);

    render(<Modals />);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));

    // activeAnalysisReport 的动态 import 尚未完成；用户此时切换到一套完全不同的 B 状态。
    useData.getState().importMatrix('上下文B.csv', ['B值'], [[100], [101], [102], [103], [104]]);
    useApp.setState({
      exportFmt: 'pdf', spcDataLayout: 'individuals', spcValueCol: 'B值',
      lsl: 90, tgt: 100, usl: 110, lslOn: true, uslOn: true,
    });
    activeReportImport.release();

    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
    const job = exportFile.mock.calls[0][0];
    expect(job.ext).toBe('html');
    expect(job.defaultName).toContain('上下文B');
    expect(job.defaultName).not.toContain('上下文A');
    expect(job.text).toContain('90.00 / 100.00 / 110.00');
    expect(job.text).not.toContain('0.00 / 1.00 / 2.00');
  });
});

describe('modal 全局快捷键隔离', () => {
  it('对话框打开时 Ctrl/Cmd 应用命令不穿透到底层工作表', () => {
    const newWorksheet = vi.spyOn(useData.getState(), 'newWorksheet');
    const undoEdit = vi.spyOn(useData.getState(), 'undoEdit');
    const redoEdit = vi.spyOn(useData.getState(), 'redoEdit');
    const saveProject = vi.spyOn(project, 'exportProject').mockResolvedValue(null);
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const originalName = useData.getState().model.name;
    useApp.setState({ modal: 'about' });
    render(<App />);

    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      for (const key of ['n', 'z', 'y', 's', 'o', 'p', 'f']) {
        const event = new KeyboardEvent('keydown', {
          key, [modifier]: true, bubbles: true, cancelable: true,
        });
        window.dispatchEvent(event);
        expect(event.defaultPrevented, `${modifier}+${key}`).toBe(true);
      }
    }

    expect(useApp.getState().modal).toBe('about');
    expect(useData.getState().model.name).toBe(originalName);
    expect(newWorksheet).not.toHaveBeenCalled();
    expect(undoEdit).not.toHaveBeenCalled();
    expect(redoEdit).not.toHaveBeenCalled();
    expect(saveProject).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
  });

  it('无 modal 时壳快捷键照常工作，但 contenteditable 后代保留原生按键', () => {
    const originalName = useData.getState().model.name;
    render(<App />);

    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const nested = document.createElement('span');
    editor.appendChild(nested);
    document.body.appendChild(editor);
    const editingEvent = new KeyboardEvent('keydown', {
      key: 'n', ctrlKey: true, bubbles: true, cancelable: true,
    });
    nested.dispatchEvent(editingEvent);
    expect(editingEvent.defaultPrevented).toBe(false);
    expect(useData.getState().model.name).toBe(originalName);

    const commandEvent = new KeyboardEvent('keydown', {
      key: 'n', ctrlKey: true, bubbles: true, cancelable: true,
    });
    window.dispatchEvent(commandEvent);
    expect(commandEvent.defaultPrevented).toBe(true);
    expect(useApp.getState().page).toBe('worksheet');
    expect(useData.getState().model.name).not.toBe(originalName);
  });
});
