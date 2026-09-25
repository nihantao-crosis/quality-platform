/** v1.43 蜂群整改：窄屏导航与菜单的行为级回归。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SideNav } from '../shell/SideNav';
import { MenuBar } from '../shell/MenuBar';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({
    recents: [{ name: '窄屏恢复数据.csv', savedAt: new Date(0).toISOString() }],
  });
  useAnalyses.setState({ saved: [] });
  useApp.setState({ projectName: '窄屏项目', page: 'dashboard', openMenu: null });
});

describe('移动端导航抽屉', () => {
  it('通过显式按钮打开，最近数据恢复入口保留完整可点击名称，并可关闭', () => {
    render(<SideNav />);
    const toggle = screen.getByRole('button', { name: '导航与项目' });
    const nav = document.getElementById('quality-platform-side-nav');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(nav?.classList.contains('mobile-open')).toBe(false);

    fireEvent.click(toggle);
    expect(document.querySelector('.side-nav-mobile-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(nav?.classList.contains('mobile-open')).toBe(true);
    expect((screen.getByRole('button', { name: /↻ 窄屏恢复数据\.csv/ }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav?.classList.contains('mobile-open')).toBe(false);
  });
});

describe('窄屏右侧菜单', () => {
  it('窗口与帮助菜单向右对齐且宽度受视口约束', () => {
    render(<MenuBar wsName="测试工作表" />);
    fireEvent.click(screen.getByRole('button', { name: '帮助' }));
    const popup = document.querySelector('.menu-popup') as HTMLElement | null;
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
    expect(popup?.style.left).toBe('auto');
    expect(popup?.style.maxWidth).toContain('100vw');
  });
});
