/**
 * 2026-09 全面审查第 2 批 G6-parse:UI 入口回归(真实组件 + 真实 store,不 mock 被测逻辑)。
 * GAP-8-4:DOE 一般全因子水平值严格解析;GAP-8-5/8-6:列重命名、鱼骨图原因、项目名的 IME 组字守卫。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../../App';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { clearFishboneState, loadFishboneState } from '../../store/fishboneStore';
import { Worksheet } from '../pages/Worksheet';
import { Fishbone } from '../pages/Fishbone';
import { SideNav } from '../shell/SideNav';
import { chartTokens } from '../tokens';

/** 真实拼音输入法的事件序列:compositionstart → 组字缓冲变化 → 候选框打开时的 Enter(isComposing)。 */
function composeThenEnter(input: HTMLElement, pinyin: string) {
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: pinyin } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ modal: null, openMenu: null, toast: null });
});

describe('GAP-8-4 DOE 一般全因子水平值不再被 parseFloat 静默截断', () => {
  const openGeneral = () => {
    useApp.setState({ page: 'doe', doeTab: 'create' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '一般全因子' }));
  };
  const setLevels = (factor: number, values: string[]) => values.forEach((value, index) =>
    fireEvent.change(screen.getByLabelText(`一般全因子因子 ${factor} 水平 ${index + 1} 数值`), { target: { value } }));

  it('「1,000/2,000/3,000」被拒绝并说明原因,不生成设计、不写工作表', () => {
    openGeneral();
    const before = useData.getState().model.name;
    setLevels(1, ['1,000', '2,000', '3,000']);
    // 输入框当场标红并显示原因
    expect(screen.getByLabelText('一般全因子因子 1 水平 1 数值').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/逗号/);
    fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
    // 修复前:因子列取值 [1,2,3]、toast「已生成 18 运行…已持久化并写入工作表」
    expect(useApp.getState().page).toBe('doe');
    expect(useData.getState().model.name).toBe(before);
    expect(useApp.getState().toast).toMatch(/水平 1 无效：「1,000」含逗号/);
  });

  it('「12.5mm」「0x10」「1 000」同样拒绝并指出具体问题', () => {
    openGeneral();
    for (const [bad, reason] of [['12.5mm', /单位或多余字符「mm」/], ['0x10', /十六进制/], ['1 000', /空格/]] as const) {
      setLevels(1, [bad, '20', '30']);
      fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
      expect(useApp.getState().page, bad).toBe('doe');
      expect(useApp.getState().toast, bad).toMatch(reason);
    }
  });

  it('全角数字与无歧义千分位按真实数值写入设计表', () => {
    openGeneral();
    setLevels(1, ['１０００', '1,000.5', '３０００']);
    fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
    expect(useApp.getState().page).toBe('worksheet');
    const { model } = useData.getState();
    const factorIndex = model.colNames.findIndex((name) => !['标准序', '运行序', '区组'].includes(name));
    const levels = [...new Set(model.subs.map((s) => s.vals[factorIndex]))].sort((a, b) => a - b);
    expect(levels).toEqual([1000, 1000.5, 3000]);
    expect(useApp.getState().toast).toContain('已按千分位读作 1000.5');
  });
});

describe('GAP-8-5 工作表列重命名忽略 IME 组字期的 Enter/Esc', () => {
  it('组字 Enter 不提交拼音;组字结束后的 Enter 正常提交', () => {
    useData.getState().importMatrix('IME测试', ['直径1', '直径2'], [[1, 2], [3, 4], [5, 6]]);
    render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    fireEvent.doubleClick(within(grid).getByRole('columnheader', { name: /列 直径1/ }));
    const input = screen.getByRole('textbox', { name: '重命名列：直径1' });

    composeThenEnter(input, 'zhijing');
    // 修复前:列名 = "zhijing" 且编辑框已关闭
    expect(useData.getState().model.colNames[0]).toBe('直径1');
    expect(screen.getByRole('textbox', { name: '重命名列：直径1' })).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229, isComposing: true });
    expect(screen.queryByRole('textbox', { name: '重命名列：直径1' })).toBe(input);

    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '直径' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(useData.getState().model.colNames[0]).toBe('直径');
    expect(screen.queryByRole('textbox', { name: /重命名列/ })).toBeNull();
  });
});

describe('GAP-8-6 鱼骨图原因与项目名忽略 IME 组字期的 Enter', () => {
  it('鱼骨图:组字 Enter 不追加拼音根因、不清空输入框', () => {
    clearFishboneState();
    render(<Fishbone T={chartTokens('经典', true)} />);
    const input = screen.getByPlaceholderText('添加「人」类原因…') as HTMLInputElement;
    const before = loadFishboneState().data.categories[0].causes;

    composeThenEnter(input, 'daojumosun');
    // 修复前:causes 追加 "daojumosun"、输入框被清空、演示数据被标成用户数据
    expect(loadFishboneState().data.categories[0].causes).toEqual(before);
    expect(input.value).toBe('daojumosun');

    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '刀具磨损' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(loadFishboneState().data.categories[0].causes).toEqual([...before, '刀具磨损']);
    expect(input.value).toBe('');
  });

  it('项目名:组字 Enter 不把拼音定为项目名,也不退出编辑态', () => {
    useApp.setState({ projectName: '质检项目' });
    render(<SideNav />);
    fireEvent.doubleClick(screen.getByRole('button', { name: /📁 质检项目/ }));
    const input = screen.getByDisplayValue('质检项目');

    composeThenEnter(input, 'dianjixiangmu');
    // 修复前:projectName = "dianjixiangmu" 且编辑框关闭
    expect(useApp.getState().projectName).toBe('质检项目');
    expect(screen.getByDisplayValue('dianjixiangmu')).toBe(input);

    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '电机项目' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(useApp.getState().projectName).toBe('电机项目');
  });
});
