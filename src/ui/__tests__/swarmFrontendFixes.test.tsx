/** DOE 持久化提示、工作表键盘交互与 QPROJ 遮罩焦点回归。 @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { platform } from '../../platform/adapter';
import * as project from '../../platform/project';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Doe } from '../pages/Doe';
import { Worksheet } from '../pages/Worksheet';
import { chartTokens } from '../tokens';

const originalImportMatrix = useData.getState().importMatrix;
const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.setState({ importMatrix: originalImportMatrix });
  useData.getState().resetDemo();
  useApp.setState({
    page: 'doe', doeTab: 'create', modal: null, busyOverlay: null, toast: null,
    importTab: 'csv', importKind: 'var', openMenu: null, varOpen: false,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
    spcStageCol: null, selSub: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useData.setState({ importMatrix: originalImportMatrix });
  useApp.setState({ modal: null, busyOverlay: null, toast: null });
});

function generateStoredDoe() {
  render(<Doe T={T} />);
  fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
}

describe('DOE 生成结果消费 PersistOutcome', () => {
  it('只有 persisted=true 才报告已持久化', () => {
    const importMatrix = vi.fn(() => ({ persisted: true, archiving: false }));
    useData.setState({ importMatrix });

    generateStoredDoe();

    expect(importMatrix).toHaveBeenCalledTimes(1);
    expect(useApp.getState().toast).toContain('已持久化并写入工作表');
    expect(useApp.getState().toast).not.toContain('尚未持久化');
  });

  it('既未落盘也未归档时仅报告内存态，不再被成功提示覆盖', () => {
    const importMatrix = vi.fn(() => ({
      persisted: false,
      archiving: false,
      rejected: '浏览器存储空间不足',
    }));
    useData.setState({ importMatrix });

    generateStoredDoe();

    expect(useApp.getState().toast).toMatch(/^⚠/);
    expect(useApp.getState().toast).toContain('当前工作表内存');
    expect(useApp.getState().toast).toContain('尚未持久化');
    expect(useApp.getState().toast).toContain('浏览器存储空间不足');
    expect(useApp.getState().toast).not.toContain('已持久化并写入工作表');
  });

  it('archiving 明示后台归档并消费 durability 拒绝为最终警告', async () => {
    let rejectArchive!: (reason?: unknown) => void;
    const durability = new Promise<void>((_resolve, reject) => { rejectArchive = reject; });
    const importMatrix = vi.fn(() => ({ persisted: false, archiving: true, durability }));
    useData.setState({ importMatrix });

    generateStoredDoe();
    expect(useApp.getState().toast).toContain('正在归档到本机数据集库');

    await act(async () => {
      rejectArchive(new Error('磁盘写入失败'));
      await durability.catch(() => undefined);
    });
    await waitFor(() => expect(useApp.getState().toast).toContain('本机归档失败'));
    expect(useApp.getState().toast).toMatch(/^⚠/);
    expect(useApp.getState().toast).toContain('尚未持久化');
    expect(useApp.getState().toast).not.toContain('正在归档到本机数据集库');
  });
});

describe('工作表键盘可达编辑与删除', () => {
  beforeEach(() => {
    useData.getState().importMatrix('键盘测试', ['宽度', '高度'], [[1, 2], [3, 4], [5, 6]]);
  });

  it('网格单元格支持 Enter/F2 编辑、Enter 提交、Escape 取消并返回焦点', async () => {
    render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    expect(grid.getAttribute('aria-rowcount')).toBe('4');
    expect(grid.getAttribute('aria-colcount')).toBe('3');
    expect([...grid.querySelectorAll<HTMLElement>('[tabindex="0"]')]).toHaveLength(1);

    const widthHeader = within(grid).getByRole('columnheader', { name: /列 宽度/ });
    expect(widthHeader.tabIndex).toBe(0);
    widthHeader.focus();
    fireEvent.keyDown(widthHeader, { key: 'ArrowDown' });
    const widthCell = within(grid).getByRole('gridcell', { name: /宽度，第 1 行，当前值 1/ });
    await waitFor(() => expect(document.activeElement).toBe(widthCell));
    expect([...grid.querySelectorAll<HTMLElement>('[tabindex="0"]')]).toEqual([widthCell]);
    fireEvent.keyDown(widthCell, { key: 'Enter' });
    const widthInput = screen.getByRole('spinbutton', { name: '编辑宽度，第 1 行' });
    expect(document.activeElement).toBe(widthInput);
    fireEvent.change(widthInput, { target: { value: '42' } });
    fireEvent.keyDown(widthInput, { key: 'Enter' });

    expect(useData.getState().model.subs[0].vals[0]).toBe(42);
    const committedCell = within(grid).getByRole('gridcell', { name: /宽度，第 1 行，当前值 42/ });
    await waitFor(() => expect(document.activeElement).toBe(committedCell));

    const heightCell = within(grid).getByRole('gridcell', { name: /高度，第 1 行，当前值 2/ });
    heightCell.focus();
    fireEvent.keyDown(heightCell, { key: 'F2' });
    const heightInput = screen.getByRole('spinbutton', { name: '编辑高度，第 1 行' });
    fireEvent.change(heightInput, { target: { value: '99' } });
    fireEvent.keyDown(heightInput, { key: 'Escape' });

    expect(useData.getState().model.subs[0].vals[1]).toBe(2);
    await waitFor(() => expect(document.activeElement).toBe(heightCell));

    fireEvent.doubleClick(heightCell);
    expect(screen.getByRole('spinbutton', { name: '编辑高度，第 1 行' })).toBeTruthy();
  });

  it('列头支持键盘重命名；行号/列头用 Delete 删除且隐藏按钮不污染 Tab 顺序', async () => {
    render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    const header = within(grid).getByRole('columnheader', { name: '列 宽度；按 Enter 或 F2 重命名，按 Delete 删除列' });
    expect(header.tabIndex).toBe(0);
    header.focus();
    fireEvent.keyDown(header, { key: 'F2' });
    const cancelledRename = screen.getByRole('textbox', { name: '重命名列：宽度' });
    fireEvent.change(cancelledRename, { target: { value: '不应保存' } });
    fireEvent.keyDown(cancelledRename, { key: 'Escape' });
    expect(useData.getState().model.colNames[0]).toBe('宽度');
    await waitFor(() => expect(document.activeElement).toBe(header));

    fireEvent.keyDown(header, { key: 'Enter' });
    const rename = screen.getByRole('textbox', { name: '重命名列：宽度' });
    fireEvent.change(rename, { target: { value: '新宽度' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    expect(useData.getState().model.colNames[0]).toBe('新宽度');
    await waitFor(() => expect(document.activeElement).toBe(
      within(grid).getByRole('columnheader', { name: '列 新宽度；按 Enter 或 F2 重命名，按 Delete 删除列' }),
    ));

    const renamedHeader = within(grid).getByRole('columnheader', { name: /列 新宽度/ });
    fireEvent.keyDown(renamedHeader, { key: 'ArrowLeft' });
    const rowNumberHeader = within(grid).getByRole('columnheader', { name: '行号列' });
    await waitFor(() => expect(document.activeElement).toBe(rowNumberHeader));
    fireEvent.keyDown(rowNumberHeader, { key: 'ArrowDown' });
    const firstRow = within(grid).getByRole('rowheader', { name: '第 1 行；按 Delete 删除此行' });
    await waitFor(() => expect(document.activeElement).toBe(firstRow));
    fireEvent.keyDown(firstRow, { key: 'Delete' });
    expect(useData.getState().model.k).toBe(2);

    const heightHeader = within(grid).getByRole('columnheader', { name: /列 高度/ });
    heightHeader.focus();
    fireEvent.keyDown(heightHeader, { key: 'Delete' });
    expect(useData.getState().model.colNames).toEqual(['新宽度']);
    const hiddenActions = [...grid.querySelectorAll<HTMLButtonElement>('.ws-del, .col-del')];
    expect(hiddenActions.every((button) => button.tabIndex === -1)).toBe(true);
    expect([...grid.querySelectorAll<HTMLElement>('[tabindex="0"]')]).toHaveLength(1);
  });

  it('方向键跨越数值和文本格，文本格 Enter 不进入编辑', async () => {
    useData.getState().importMatrix(
      '交错键盘测试', ['数值A', '数值B'], [[1, 2], [3, 4]],
      [{ name: '批次', values: ['甲', '乙'], sourceIndex: 1 }],
    );
    render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    const numeric = within(grid).getByRole('gridcell', { name: /数值A，第 1 行/ });
    numeric.focus();
    fireEvent.keyDown(numeric, { key: 'ArrowRight' });
    const text = [...within(grid).getAllByRole('gridcell')].find((cell) => cell.textContent === '甲')!;
    await waitFor(() => expect(document.activeElement).toBe(text));
    expect(text.tabIndex).toBe(0);
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(document.activeElement).toBe(text);
    expect(screen.queryByRole('textbox', { name: /编辑批次/ })).toBeNull();
    fireEvent.keyDown(text, { key: 'ArrowRight' });
    const numericB = within(grid).getByRole('gridcell', { name: /数值B，第 1 行/ });
    await waitFor(() => expect(document.activeElement).toBe(numericB));
  });

  it('虚拟化窗口携带真实 aria-rowindex，上下占位行隐藏出语义树', async () => {
    const rows = Array.from({ length: 401 }, (_, index) => [index, index + 1]);
    useData.getState().importMatrix('虚拟键盘测试', ['A', 'B'], rows);
    const { container } = render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    expect(grid.getAttribute('aria-rowcount')).toBe('402');
    const initialCell = within(grid).getByRole('gridcell', { name: /A，第 1 行，当前值 0/ });
    initialCell.focus();
    fireEvent.scroll(grid.parentElement!, { target: { scrollTop: 9_000 } });
    await waitFor(() => expect(container.querySelectorAll('.worksheet-virtual-spacer')).toHaveLength(2));
    const dataRows = [...within(grid).getAllByRole('row')].filter((row) => row.closest('tbody'));
    expect(dataRows[0].getAttribute('aria-rowindex')).toBe('290');
    expect(dataRows.every((row, index) => row.getAttribute('aria-rowindex') === String(index + 290))).toBe(true);
    const spacers = [...container.querySelectorAll<HTMLElement>('.worksheet-virtual-spacer')];
    expect(spacers).toHaveLength(2);
    expect(spacers.every((spacer) => spacer.getAttribute('role') === 'presentation')).toBe(true);
    expect(spacers.every((spacer) => spacer.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(spacers.every((spacer) => !dataRows.includes(spacer))).toBe(true);
    const tabStops = [...grid.querySelectorAll<HTMLElement>('[tabindex="0"]')];
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0].getAttribute('data-grid-row')).toBe('289');
  });
});

describe('QPROJ 安全失败解除遮罩后的焦点', () => {
  it('lockRequired:false 将焦点恢复到导入对话框，Tab 仍在首尾循环', async () => {
    let resolveApply!: (result: project.ProjectApplyResult) => void;
    const applying = new Promise<project.ProjectApplyResult>((resolve) => { resolveApply = resolve; });
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({ name: 'safe.qproj', contents: '{}' });
    vi.spyOn(project, 'applyProjectText').mockImplementation(async () => applying);
    useApp.setState({ page: 'worksheet', modal: 'import', busyOverlay: null });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(useApp.getState().busyOverlay).toContain('正在导入项目'));
    const overlay = screen.getByRole('alert');
    expect(document.activeElement).toBe(overlay);

    await act(async () => {
      resolveApply({ error: '文件校验失败', lockRequired: false });
      await applying;
    });
    await waitFor(() => expect(useApp.getState().busyOverlay).toBeNull());

    const dialog = screen.getByRole('dialog', { name: '导入数据' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
