/**
 * 2026-09 全面审查第 7 批 G23c C1(G13 复审 P2):commitOn=change 的严格数值框逐键输入时,
 * 此前每个合法前缀都即时写进 store 并持久化——打「1,000」得 1、打「12.5mm」得 12.5、打「3,5」得 3,
 * 失焦/切页后草稿丢失,输入框显示前缀且无任何告警,报告导出与项目快照也按前缀输出。
 * 修复后:合法整串仍实时生效;一旦当前串非法,store 回退到本次编辑开始时的值(μ₀ 回退原始字段,
 * 「跟随目标值」的 null 语义保留),告警写明「未修改,仍按编辑前的值」;失焦/回车/卸载后不残留前缀。
 * 全部走真实页面组件 + 真实 store;逐键用 fireEvent.change 依次写入累积串,复现真实键入路径。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Anova, GageRR } from '../pages/SimplePages';
import { Capability } from '../pages/Capability';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ modal: null, openMenu: null, toast: null, t1ColName: null, t1Mu0: null });
});
afterEach(() => { cleanup(); });

/** 逐键输入:依次写入 "1"、"1,"、"1,0"…,与真实键盘一致(每键一次 change)。 */
function typeKeys(el: HTMLInputElement, text: string) {
  let acc = '';
  for (const ch of text) {
    acc += ch;
    fireEvent.change(el, { target: { value: acc } });
  }
}

function setupT1(mu0: number | null) {
  useData.getState().importMatrix('t 检验', ['A'], [[10.1], [10.3], [9.9], [10.2], [10.0]]);
  useApp.setState({ page: 'anova', hypoTab: 't1', t1ColName: 'A', t1Mu0: mu0, tgt: 10 });
}

const mu0Box = () => screen.getByLabelText('单样本 t 目标 μ₀') as HTMLInputElement;
const h0Text = () => document.body.textContent?.match(/H₀: μ = -?[\d.]+/)?.[0] ?? null;

describe('C1 μ₀ 逐键输入不再把合法前缀写进 store', () => {
  for (const raw of ['1,000', '12.5mm', '3,5']) {
    it(`逐键「${raw}」+ 失焦 + 卸载/重挂载:t1Mu0 仍是编辑前的 10,输入框与 H₀ 均为 10`, () => {
      setupT1(10);
      const { unmount } = render(<Anova T={T} />);
      const mu0 = mu0Box();
      fireEvent.change(mu0, { target: { value: '' } });
      typeKeys(mu0, raw);
      // 键入过程中:store 与检验结果都回到编辑前的值,告警如实写明
      expect(useApp.getState().t1Mu0).toBe(10);
      expect(h0Text()).toBe('H₀: μ = 10.0000');
      const alert = screen.getByRole('alert').textContent ?? '';
      expect(alert).toContain('未修改');
      expect(alert).toContain('仍按编辑前的值 10');
      expect(mu0.value).toBe(raw);
      fireEvent.blur(mu0);
      expect(useApp.getState().t1Mu0).toBe(10);
      unmount();
      render(<Anova T={T} />);
      expect(mu0Box().value).toBe('10');
      expect(useApp.getState().t1Mu0).toBe(10);
      expect(h0Text()).toBe('H₀: μ = 10.0000');
    });
  }

  it('未失焦直接卸载(切页签/切页面)同样不残留前缀', () => {
    setupT1(10);
    const { unmount } = render(<Anova T={T} />);
    const mu0 = mu0Box();
    fireEvent.change(mu0, { target: { value: '' } });
    typeKeys(mu0, '12.5mm');
    unmount();
    expect(useApp.getState().t1Mu0).toBe(10);
    render(<Anova T={T} />);
    expect(mu0Box().value).toBe('10');
  });

  it('μ₀ 未单独设置(null=跟随目标值)时,非法输入回退后仍是 null,不被钉成固定数', () => {
    setupT1(null);
    render(<Anova T={T} />);
    const mu0 = mu0Box();
    expect(mu0.value).toBe('10');
    fireEvent.change(mu0, { target: { value: '' } });
    typeKeys(mu0, '1,000');
    fireEvent.blur(mu0);
    expect(useApp.getState().t1Mu0).toBeNull();
  });

  it('合法整串逐键输入仍实时生效(12.5),回车确认后规范显示', () => {
    setupT1(10);
    render(<Anova T={T} />);
    const mu0 = mu0Box();
    fireEvent.change(mu0, { target: { value: '' } });
    typeKeys(mu0, '12.5');
    expect(useApp.getState().t1Mu0).toBe(12.5);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h0Text()).toBe('H₀: μ = 12.5000');
    fireEvent.keyDown(mu0, { key: 'Enter' });
    fireEvent.blur(mu0);
    expect(mu0.value).toBe('12.5');
    expect(useApp.getState().t1Mu0).toBe(12.5);
  });

  it('先合法改成 12.5 再继续键入「mm」:回退到本次编辑开始时的值,而非中途的 12.5', () => {
    setupT1(10);
    render(<Anova T={T} />);
    const mu0 = mu0Box();
    fireEvent.change(mu0, { target: { value: '' } });
    typeKeys(mu0, '12.5');
    fireEvent.change(mu0, { target: { value: '12.5m' } });
    expect(useApp.getState().t1Mu0).toBe(10);
    fireEvent.change(mu0, { target: { value: '12.5' } });
    expect(useApp.getState().t1Mu0).toBe(12.5);
  });
});

describe('C1 同族:能力页规格限 / MSA 过程公差(StrictNumberInput commitOn=change)', () => {
  // 数据离散度取 σ≈3:逐键途经的前缀(2、3、24)都不触发「规格超 1000σ」确认分支。能力页在分析分支切换时
  // 会把规格编辑区挂到另一处(输入框重挂载、焦点丢失),那是 Capability.tsx 的布局问题,另记跨组需求。
  function setupCapability() {
    const rows = Array.from({ length: 25 }, (_, i) => Array.from({ length: 5 }, (_, j) => 25 + (((i * 7 + j * 3) % 11) - 5)));
    useData.getState().importMatrix('能力.csv', ['C1', 'C2', 'C3', 'C4', 'C5'], rows);
    useApp.setState({ page: 'capability', lsl: 24.9, tgt: 25, usl: 25.1, lslOn: true, uslOn: true, spcDataLayout: 'rows' });
  }

  it('LSL 逐键「24.8mm」+ 失焦 + 卸载/重挂载:lsl 仍是 24.9', () => {
    setupCapability();
    const { unmount } = render(<Capability T={T} />);
    const lsl = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    fireEvent.change(lsl, { target: { value: '' } });
    typeKeys(lsl, '24.8mm');
    // 同一个输入框元素(未因分支切换重挂载),确保测的是逐键会话本身
    expect(screen.getByRole('textbox', { name: 'LSL 下限' })).toBe(lsl);
    expect(useApp.getState().lsl).toBe(24.9);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('LSL 下限无效') && el.textContent.includes('仍按编辑前的值 24.9'))).toBe(true);
    fireEvent.blur(lsl);
    expect(useApp.getState().lsl).toBe(24.9);
    unmount();
    render(<Capability T={T} />);
    expect((screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement).value).toBe('24.9');
  });

  it('LSL 逐键「3,5」中途卸载:不残留前缀 3', () => {
    setupCapability();
    const { unmount } = render(<Capability T={T} />);
    const lsl = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    fireEvent.change(lsl, { target: { value: '' } });
    typeKeys(lsl, '3,5');
    unmount();
    expect(useApp.getState().lsl).toBe(24.9);
  });

  it('MSA 过程公差(允许清空):清空后键入「0.5mm」回退到编辑前的 1,而不是清空后的 null 或前缀 0.5', () => {
    useData.getState().importMatrix('量具研究.csv', ['测量值'], [[10], [10.1], [10.2], [10.1], [20], [20.2], [20.1], [20.3]], [
      { name: '部件', values: ['P1', 'P1', 'P1', 'P1', 'P2', 'P2', 'P2', 'P2'] },
      { name: '操作员', values: ['O1', 'O1', 'O2', 'O2', 'O1', 'O1', 'O2', 'O2'] },
    ]);
    useApp.setState({
      page: 'gagerr', gageUseReal: true, gageValueName: '测量值', gagePartName: '部件', gageOperatorName: '操作员',
      gageTolMode: 'width', gageTolValue: 1, gageTolByCol: {},
    });
    render(<GageRR T={T} />);
    const input = screen.getByLabelText('过程公差数值') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(useApp.getState().gageTolValue).toBeNull();
    typeKeys(input, '0.5mm');
    expect(useApp.getState().gageTolValue).toBe(1);
    fireEvent.blur(input);
    expect(useApp.getState().gageTolValue).toBe(1);
    // 清空本身合法(允许空)仍即时生效
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(useApp.getState().gageTolValue).toBeNull();
  });
});
