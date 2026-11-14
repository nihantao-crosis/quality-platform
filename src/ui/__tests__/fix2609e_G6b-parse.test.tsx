/**
 * 2026-09 全面审查第 2 批复审收口 G6b-parse:工作表单元格编辑器(GAP-8-4)。
 * Chromium(WebView2 / Chrome PWA)对 type=number 在插入时就滤掉非法字符(「3,5」→35、「12.5mm」→12.5),
 * badInput=false,严格解析形同虚设;jsdom 则把这类值净化成空串,旧测试测不出来。
 * 这里断言编辑器不是 type=number,并用原始串走真实提交路径(真实组件 + 真实 store)。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ modal: null, openMenu: null, toast: null });
  useData.getState().importMatrix('编辑器测试', ['直径', '长度'], [[10.1, 20.1], [10.2, 20.2], [10.3, 20.3]]);
});

function openEditor(row = 1): HTMLInputElement {
  render(<Worksheet />);
  const grid = screen.getByRole('grid', { name: '数据工作表' });
  fireEvent.doubleClick(within(grid).getByRole('gridcell', { name: new RegExp(`^直径，第 ${row} 行，当前值`) }));
  return screen.getByLabelText(`编辑直径，第 ${row} 行`) as HTMLInputElement;
}

describe('GAP-8-4 复审:单元格编辑器改为 type=text + inputMode=decimal,对原始 draft 严格解析', () => {
  it('编辑器不是 type=number(修复前 type="number",Chromium 会在插入时改写输入)', () => {
    const input = openEditor();
    expect(input.type).not.toBe('number');
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('decimal');
  });

  it('「3,5」原样到达解析层:拒绝、给出逗号原因、值不变(Chromium 旧行为是提交 35)', () => {
    const input = openEditor();
    fireEvent.change(input, { target: { value: '3,5' } });
    // 编辑中即标红并给出原因
    expect(input.value).toBe('3,5');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.title).toMatch(/逗号/);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useData.getState().model.subs[0].vals[0]).toBe(10.1);
    expect(useApp.getState().toast).toMatch(/未修改直径，第 1 行：「3,5」含逗号/);
  });

  it('「12.5mm」拒绝并指出单位(Chromium 旧行为是静默提交 12.5)', () => {
    const input = openEditor();
    fireEvent.change(input, { target: { value: '12.5mm' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(input);
    expect(useData.getState().model.subs[0].vals[0]).toBe(10.1);
    expect(useApp.getState().toast).toMatch(/单位或多余字符「mm」/);
  });

  it('合法值与无歧义千分位照常提交,千分位读法向用户说明;空串视为放弃编辑', () => {
    let input = openEditor();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(input, { target: { value: '1,000.5' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useData.getState().model.subs[0].vals[0]).toBe(1000.5);
    expect(useApp.getState().toast).toContain('已按千分位读作 1000.5');

    cleanup();
    useApp.setState({ toast: null });
    input = openEditor(2);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useData.getState().model.subs[1].vals[0]).toBe(10.2);
    expect(useApp.getState().toast).toBeNull();
  });
});
