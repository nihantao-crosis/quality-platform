/** DOE 创建页：分部、折叠预检与“存储到工作表”开关。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../../App';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ page: 'doe', doeTab: 'create', modal: null, openMenu: null });
});

describe('DOE 创建安全闸门', () => {
  it('2^(4-1) 无效全折叠被禁用；指定因子折叠显示实际分辨率并支持互补分部', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '分数因子 2^(k−p)' }));

    fireEvent.change(screen.getByLabelText('折叠'), { target: { value: 'full' } });
    expect(screen.getByRole('alert').textContent).toContain('新增设计点为 0');
    expect(screen.getByText(/共/).parentElement?.textContent).toContain('8');
    expect(screen.getByRole('button', { name: '生成设计表 → 工作表' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('折叠'), { target: { value: 'factor' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText(/实际分辨率/).some((element) => element.textContent?.includes('实际分辨率 完全'))).toBe(true);
    fireEvent.change(screen.getByLabelText('分数因子分部'), { target: { value: '2' } });
    expect(screen.getByText(/生成元 D=−ABC/)).toBeTruthy();
  });

  it('关闭“将设计存储在工作表中”只生成预览，不改当前数据集或跳页', () => {
    const beforeName = useData.getState().model.name;
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '分数因子 2^(k−p)' }));
    const store = screen.getByLabelText('将设计存储在工作表中');
    expect((store as HTMLInputElement).checked).toBe(true);
    fireEvent.click(store);
    fireEvent.click(screen.getByRole('button', { name: '生成设计预览' }));

    expect(screen.getByText(/设计预览 · DOE分数因子_/)).toBeTruthy();
    expect(screen.getAllByText(/未写入工作表/).length).toBeGreaterThan(0);
    expect(useData.getState().model.name).toBe(beforeName);
    expect(useApp.getState().page).toBe('doe');
  });
});
