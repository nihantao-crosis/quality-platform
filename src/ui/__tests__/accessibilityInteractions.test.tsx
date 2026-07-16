/** GUI 可访问性交互：原生按钮、弹窗焦点管理与 Toast 严重级别。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Modals, Toast } from '../shell/Modals';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useApp.setState({ page: 'dashboard', modal: null, openMenu: null, toast: null, spcType: 'xbar-r' });
  useData.getState().resetDemo();
});

describe('原生操作控件', () => {
  it('主导航、工作表动作和 SPC 切换均为按钮', () => {
    render(<App />);

    const worksheetNav = screen.getByRole('button', { name: '数据工作表' });
    fireEvent.click(worksheetNav);
    expect(screen.getByRole('button', { name: '＋ 子组' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Excel / CSV 导入已连接' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '控制图 (SPC)' }));
    const ewma = screen.getByRole('button', { name: 'EWMA' });
    expect(ewma.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(ewma);
    expect(ewma.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('弹窗焦点管理', () => {
  function ModalHost() {
    const openModal = useApp((state) => state.openModal);
    return (
      <>
        <button type="button" onClick={() => openModal('sort')}>打开排序</button>
        <Modals />
      </>
    );
  }

  it('打开时聚焦弹窗，Tab 在首尾循环，关闭后恢复触发按钮', () => {
    render(<ModalHost />);
    const opener = screen.getByRole('button', { name: '打开排序' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: '排序' });
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(document.activeElement).toBe(opener);
  });
});

describe('Toast 语义与颜色', () => {
  it('成功信息使用 status/绿色，失败信息使用 alert/红色', () => {
    render(<Toast />);

    act(() => useApp.setState({ toast: '导出完成' }));
    const success = screen.getByRole('status');
    expect((success.firstElementChild as HTMLElement).style.background).toContain('67');

    act(() => useApp.setState({ toast: '导出失败：文件损坏，无法读取' }));
    const failure = screen.getByRole('alert');
    expect((failure.firstElementChild as HTMLElement).style.background).toContain('226');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
