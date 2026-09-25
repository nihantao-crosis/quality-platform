/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '../../core';
import { platform } from '../../platform/adapter';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';
import { Modals } from '../shell/Modals';

vi.mock('../../core', async (original) => {
  const actual = await original<typeof import('../../core')>();
  return {
    ...actual,
    evalRules: vi.fn(actual.evalRules),
    evalLimitedRules: vi.fn(actual.evalLimitedRules),
    // fix2609k G20:工作表行高亮改走与 SPC 页/看板同源的唯一判异原语 evaluateSpcChartRules
    evaluateSpcChartRules: vi.fn(actual.evaluateSpcChartRules),
  };
});

beforeEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  localStorage.clear();
  useData.getState().resetDemo();
  useData.getState().importMatrix('original', ['X1', 'X2'], [[1, 2], [2, 4], [3, 5]]);
  useApp.setState({
    page: 'worksheet', modal: null, busyOverlay: null, toast: null, selSub: null,
    spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null,
    spcSigmaMethod: 'classic', spcType: 'xbar-r', spcRules: DEFAULT_SPC_RULES,
    spcRuleK: core.DEFAULT_RULE_K,
  });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  cancelPendingDatasetWork();
  vi.restoreAllMocks();
});

function paste(target: Element) {
  fireEvent.paste(target, { clipboardData: { getData: () => 'Y\n41\n42' } });
}

describe('工作表粘贴范围', () => {
  it.each(['help', 'import', 'options'] as const)('%s 弹窗内正常按钮粘贴不改变后台数据，关闭后继续可用', (modal) => {
    render(<><Worksheet /><Modals /></>);
    const before = useData.getState();
    const stored = JSON.stringify(localStorage);
    act(() => useApp.setState({ modal }));
    const button = screen.getByRole('dialog').querySelector('button')!;
    button.focus();
    paste(button);
    // 即使外部人为把焦点留在被遮挡的工作表也不允许导入。
    paste(screen.getByRole('grid', { hidden: true }));
    expect(useData.getState().model).toBe(before.model);
    expect(useData.getState().recents).toBe(before.recents);
    expect(useData.getState().undoStack).toBe(before.undoStack);
    expect(JSON.stringify(localStorage)).toBe(stored);
    act(() => useApp.setState({ modal: null }));
    paste(screen.getByRole('grid'));
    expect(useData.getState().model.subs.map((row) => row.vals)).toEqual([[41], [42]]);
  });

  it('事务忙态、工作表外及编辑器后代均不导入', () => {
    render(<Worksheet />);
    const before = useData.getState().model;
    act(() => useApp.setState({ busyOverlay: '正在清理' }));
    paste(screen.getByRole('grid'));
    act(() => useApp.setState({ busyOverlay: null }));
    paste(document.body);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.appendChild(child);
    screen.getByRole('grid').parentElement!.appendChild(editor);
    paste(child);
    expect(useData.getState().model).toBe(before);
    expect(useApp.getState().toast).toBeNull();
  });

  it('真实添加行/列按钮遭到 store 拒绝时不覆盖失败提示或变更数据', () => {
    const before = useData.getState().model;
    vi.spyOn(useData.getState(), 'addSubgroupRow').mockImplementation(() => {
      useApp.getState().showToast('行数已达上限'); return false;
    });
    vi.spyOn(useData.getState(), 'insertColumn').mockImplementation(() => {
      useApp.getState().showToast('列数已达上限'); return false;
    });
    render(<Worksheet />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 子组' }));
    expect(useApp.getState().toast).toBe('行数已达上限');
    fireEvent.click(screen.getByRole('button', { name: '＋ 数值列' }));
    expect(useApp.getState().toast).toBe('列数已达上限');
    expect(useData.getState().model).toBe(before);
  });
});

it('虚拟滚动复用判异；修改 K、测量值、图型和 σ 方法后重新计算', () => {
  useData.getState().importMatrix('large', ['X1', 'X2'],
    Array.from({ length: 1000 }, (_, i) => [i % 13, i % 13 + 2]));
  render(<Worksheet />);
  // fix2609k G20:行高亮经 evaluateSpcChartRules(位置+离散一次评估,count-only)
  const location = vi.mocked(core.evaluateSpcChartRules);
  const initial = location.mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  const scroller = screen.getByRole('grid').parentElement!;
  for (const scrollTop of [300, 600, 1200]) fireEvent.scroll(scroller, { target: { scrollTop } });
  expect(location.mock.calls.length).toEqual(initial);
  expect(location.mock.calls[location.mock.calls.length - 1]?.[4]).toBe(false);
  const changes = [
    () => useApp.setState({ spcRuleK: { ...core.DEFAULT_RULE_K, k2: 12 } }),
    () => useData.getState().updateCell(0, 0, 99),
    () => useApp.setState({ spcType: 'xbar-s' }),
    () => useApp.setState({ spcSigmaMethod: 'pooled' }),
  ];
  for (const change of changes) {
    const calls = location.mock.calls.length;
    act(change);
    expect(location.mock.calls.length).toBeGreaterThan(calls);
  }
});
