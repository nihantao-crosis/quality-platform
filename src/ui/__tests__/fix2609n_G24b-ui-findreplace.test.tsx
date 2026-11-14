/**
 * fix2609n · G24b-ui B3f:查找/替换对话框在 findReplace 返回 0 时,若 store 已给出拒绝原因
 * (applyEdit 的「工作表编辑已拒绝：…」),不得再用「未找到可替换的值」覆盖。
 * 真实 Modals / 真实 store;只把 findReplace 这一依赖替换成「匹配 1 处、替换时被拒并提示」的桩——
 * 仅替换数值不改变维度,真实 applyEdit 的维度拒绝在 UI 上几乎构造不出来。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Modals } from '../shell/Modals';

const realFindReplace = useData.getState().findReplace;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ page: 'worksheet', modal: 'findreplace', toast: null, openMenu: null, busyOverlay: null });
  useData.getState().importMatrix('录入表.csv', ['x'], [[3], [1], [2]]);
});
afterEach(() => {
  useData.setState({ findReplace: realFindReplace });
  cleanup();
});

describe('B3f 查找替换:被拒原因不被「未找到可替换的值」覆盖', () => {
  it('替换被 store 拒绝并已提示原因 → 对话框不关闭、提示仍是拒绝原因', () => {
    const refusal = '工作表编辑已拒绝：测试构造的维度超限';
    useData.setState({
      findReplace: (find, replace, col) => {
        if (replace == null) return realFindReplace(find, null, col);
        useApp.getState().showToast(refusal);
        return 0;
      },
    });
    render(<Modals />);
    fireEvent.change(screen.getByLabelText('查找数值'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('替换为'), { target: { value: '33' } });
    const btn = screen.getByRole('button', { name: '全部替换' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(useApp.getState().modal).toBe('findreplace');
    expect(useApp.getState().toast).toBe(refusal);
  });

  it('确无匹配(替换时返回 0 且没有任何提示)→ 仍提示「未找到可替换的值」', () => {
    useData.setState({
      findReplace: (find, replace, col) => (replace == null ? realFindReplace(find, null, col) : 0),
    });
    render(<Modals />);
    fireEvent.change(screen.getByLabelText('查找数值'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('替换为'), { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: '全部替换' }));
    expect(useApp.getState().toast).toBe('未找到可替换的值');
  });
});
