/** v1.43 第二轮：帕累托资源包线、导入解析复用、窄屏弹窗与抽屉焦点。 */
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '../../core';
import { platform } from '../../platform/adapter';
import { useApp, type Modal } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { Modals } from '../shell/Modals';
import { SideNav } from '../shell/SideNav';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
  useApp.setState({
    page: 'dashboard', modal: null, toast: null, importTab: 'csv', importKind: 'var',
    openMenu: null, projectName: '移动端测试项目',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('帕累托在分配 records/cells 前执行资源预检', () => {
  it('空格分隔遵守 RFC 引号边界，类别内空格与转义引号不被截断', () => {
    const result = core.parseCategoryCounts('"轴 承 划伤" 5\n"毛刺 ""严重""" 3');
    if ('error' in result) throw new Error(result.error);
    expect(result.rows).toEqual([
      { name: '轴 承 划伤', count: 5 },
      { name: '毛刺 "严重"', count: 3 },
    ]);
    expect(result.note).toContain('空格分隔');
  });

  it('只有引号内部空格的单列标签仍保持为完整类别', () => {
    const result = core.parseCategoryCounts('"Failure Mode"\n"Failure Mode"\n"Other Mode"');
    if ('error' in result) throw new Error(result.error);
    expect(result.rows).toEqual([
      { name: 'Failure Mode', count: 2 },
      { name: 'Other Mode', count: 1 },
    ]);
  });

  it('拒绝超过原始逻辑记录上限的单列标签流', () => {
    const text = Array.from({ length: 200_001 }, () => '同一缺陷').join('\n');
    const result = core.parseCategoryCounts(text);
    expect('error' in result && result.error).toMatch(/原始记录数.*上限/);
  });

  it('横向 2×N 按类别上限早拒，不先转置成五万条小数组', () => {
    const names = Array.from({ length: 50_002 }, (_, index) => `D${index}`).join(',');
    const counts = Array.from({ length: 50_002 }, () => '1').join(',');
    const result = core.parseCategoryCounts(`${names}\n${counts}`);
    expect('error' in result && result.error).toMatch(/横向帕累托类别数.*上限/);
  });

  it('按真实总字段数与单格字符数拒绝资源炸弹', () => {
    const row = Array.from({ length: 2_000 }, () => 'A').join(',');
    const tooManyCells = core.parseCategoryCounts(Array.from({ length: 1_001 }, () => row).join('\n'));
    expect('error' in tooManyCells && tooManyCells.error).toMatch(/单元格总数.*上限/);

    const longCell = core.parseCategoryCounts(`${'A'.repeat(32_769)},1\nB,2`);
    expect('error' in longCell && longCell.error).toMatch(/单元格长度.*上限/);
  });
});

describe('导入预览与确认共用同一解析结果', () => {
  it('普通 CSV 文件只解析一次', async () => {
    const parseSpy = vi.spyOn(core, 'parseMatrix');
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({
      name: '普通.csv', contents: '测量值,班组\n10.1,甲\n10.2,乙\n10.3,甲',
    });
    useApp.setState({ modal: 'import', importTab: 'csv', importKind: 'var' });
    render(<Modals />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await screen.findByText(/✓ 普通\.csv/);
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('帕累托文件预览后不重复解析', async () => {
    const parseSpy = vi.spyOn(core, 'parseCategoryCounts');
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({
      name: '缺陷.csv', contents: '类别,频数\n划伤,5\n毛刺,3',
    });
    useApp.setState({ modal: 'import', importTab: 'csv', importKind: 'pareto' });
    render(<Modals />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await screen.findByText(/✓ 缺陷\.csv/);
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('并排数据块只在选择时解析一次，确认直接消费 pending.parsed', async () => {
    const parseSpy = vi.spyOn(core, 'parseMatrix');
    vi.spyOn(platform, 'pickImportFile').mockResolvedValue({
      name: '并排.csv',
      contents: '部件,测量A,,部件,测量B\n1,10.1,,1,20.1\n2,10.2,,2,20.2',
    });
    useApp.setState({ modal: 'import', importTab: 'csv', importKind: 'var' });
    render(<Modals />);

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    const group = await screen.findByRole('group', { name: '选择数据块' });
    fireEvent.click(within(group).getByRole('button', { name: /测量A（/ }));
    await screen.findByText(/✓ 并排\.csv · 第 1 块 · 源列 C1–C2 · 部件\/测量A/);
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });
});

describe('375px 弹窗视口包线', () => {
  it('所有固定宽度弹窗都有视口最大宽高和内部滚动区', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<Modals />);
    const modals: Modal[] = [
      'import', 'export', 'calc', 'formula', 'subset', 'vault', 'findreplace',
      'about', 'help', 'options', 'sort', 'colstats', 'random',
    ];
    for (const modal of modals) {
      act(() => useApp.setState({ modal }));
      const panel = document.querySelector<HTMLElement>('.modal-panel');
      expect(panel, `${modal} 缺少统一 modal-panel`).not.toBeNull();
      expect(panel?.style.maxWidth).toContain('100vw');
      expect(panel?.style.maxHeight).toContain('100dvh');
      const hasScrollableBody = panel?.querySelector('.modal-scroll-body, .help-modal-content');
      expect(hasScrollableBody, `${modal} 缺少内部滚动区`).not.toBeNull();
    }
    act(() => useApp.setState({ modal: null }));
  });
});

describe('移动抽屉键盘焦点闭环', () => {
  it('打开移焦、Tab 留在抽屉内，Escape 与导航关闭后归还触发按钮', () => {
    render(<SideNav />);
    const toggle = screen.getByRole('button', { name: '导航与项目' });
    fireEvent.click(toggle);

    const nav = document.getElementById('quality-platform-side-nav')!;
    expect(nav.contains(document.activeElement)).toBe(true);
    const drawerButtons = within(nav).getAllByRole('button');
    const first = drawerButtons[0];
    const last = drawerButtons[drawerButtons.length - 1];

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.side-nav-mobile-backdrop')!);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    fireEvent.click(within(nav).getByRole('button', { name: '数据工作表' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    act(() => useApp.setState({ modal: 'help' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    act(() => useApp.setState({ modal: null }));
  });
});
