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
  // fix2609 TESTS-02 同类残留:上一用例「已生成…共 8 运行」的 toast 会让 getByText(/共/) 命中两处。
  useApp.setState({ page: 'doe', doeTab: 'create', modal: null, openMenu: null, toast: null });
});

describe('DOE 创建安全闸门', () => {
  it('重复因子字段、种子和分数设计 radio 都有唯一可访问名称', () => {
    render(<App />);
    for (let factor = 1; factor <= 2; factor++) {
      expect(screen.getByLabelText(`两水平全因子因子 ${factor} 名称`)).toBeTruthy();
      expect(screen.getByLabelText(`两水平全因子因子 ${factor} 低水平`)).toBeTruthy();
      expect(screen.getByLabelText(`两水平全因子因子 ${factor} 高水平`)).toBeTruthy();
    }
    expect(screen.getByLabelText('随机化种子模式')).toBeTruthy();
    expect(screen.getByLabelText('随机化种子数值')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '一般全因子' }));
    for (let factor = 1; factor <= 2; factor++) {
      expect(screen.getByLabelText(`一般全因子因子 ${factor} 名称`)).toBeTruthy();
      expect(screen.getByLabelText(`一般全因子因子 ${factor} 水平数`)).toBeTruthy();
      for (let level = 1; level <= 3; level++) {
        expect(screen.getByLabelText(`一般全因子因子 ${factor} 水平 ${level} 数值`)).toBeTruthy();
      }
    }

    fireEvent.click(screen.getByRole('button', { name: '分数因子 2^(k−p)' }));
    for (let factor = 1; factor <= 4; factor++) {
      expect(screen.getByLabelText(`分数因子因子 ${factor} 名称`)).toBeTruthy();
      expect(screen.getByLabelText(`分数因子因子 ${factor} 低水平`)).toBeTruthy();
      expect(screen.getByLabelText(`分数因子因子 ${factor} 高水平`)).toBeTruthy();
    }
    const radioNames = screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'));
    expect(radioNames.every(Boolean)).toBe(true);
    expect(new Set(radioNames).size).toBe(radioNames.length);
  });

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

  it('三因子交互图的两个因子选择器名称可区分', () => {
    useData.getState().importMatrix('DOE', ['A', 'B', 'C', 'Y'], [
      [-1, -1, -1, 10], [1, -1, -1, 12], [-1, 1, -1, 11], [1, 1, -1, 15],
      [-1, -1, 1, 13], [1, -1, 1, 17], [-1, 1, 1, 14], [1, 1, 1, 20],
    ]);
    useApp.setState({
      page: 'doe', doeTab: 'analyze', doeView: 'interact',
      doeFactorCols: ['A', 'B', 'C'], doeRespCol: 'Y',
    });
    render(<App />);
    expect(screen.getByLabelText('交互作用图第一个因子')).toBeTruthy();
    expect(screen.getByLabelText('交互作用图第二个因子')).toBeTruthy();
  });
});
