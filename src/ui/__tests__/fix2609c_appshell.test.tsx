/**
 * fix2609c G7-appshell 回归:CORE-02 / CORE-03 / UI-02。
 * - CORE-02:prepareGageStudy 缺胞诊断按「部件水平×操作员水平」全量枚举并物化字符串 → O(P×O) 时间/内存。
 * - CORE-03:Math.min/max(...counts) 展开超 ~12.5 万胞抛 RangeError;壳层 useMemo 在边界外 → 整页白屏。
 * - UI-02:ErrorBoundary 只包页面内容区,壳层(Modals/StatusBar/App 级计算)渲染期抛错整棵树卸载。
 * 全部走真实生产函数(computeVarModel / effectiveGageSelection / prepareGageStudy / importMatrix / <App/>);
 * 仅 UI-02 用例用开关让 Modals / StatusBar 在渲染期故意抛错(模拟任意壳层回归),开关关闭时透传真实组件。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import App from '../../App';
import { computeVarModel, effectiveGageSelection, prepareGageStudy } from '../../core';
import { GAGE_MAX_CROSS_CELLS } from '../../core/gageData';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';

const boom = vi.hoisted(() => ({ modal: false, statusBar: false }));

vi.mock('../shell/Modals', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shell/Modals')>();
  const { useApp: useAppStore } = await import('../../store/appStore');
  const { createElement: h } = await import('react');
  return {
    ...original,
    Modals: () => {
      const modal = useAppStore((s) => s.modal);
      if (boom.modal && modal) throw new Error('MODAL_BOOM: 对话框渲染期异常');
      return h(original.Modals);
    },
  };
});

vi.mock('../shell/StatusBar', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shell/StatusBar')>();
  const { createElement: h } = await import('react');
  return {
    ...original,
    StatusBar: (props: ComponentProps<typeof original.StatusBar>) => {
      if (boom.statusBar) throw new Error('SHELL_BOOM: 状态栏渲染期异常');
      return h(original.StatusBar, props);
    },
  };
});

let consoleError: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  boom.modal = false;
  boom.statusBar = false;
  useApp.setState({
    page: 'dashboard', modal: null, openMenu: null, toast: null, busyOverlay: null,
    gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
  });
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
});

/** React 对被边界捕获的渲染异常仍会 console.error;预期抛错的用例里静音,避免噪声。 */
function muteReactErrorLog() {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
}

function heapUsed(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

/** 部件 P 个 × 操作员 O 个 × 每胞 r 次的完整交叉长表(部件为数值 ID,操作员为文本列)。 */
function crossedLongTable(parts: number, operators: string[], repeats: number) {
  const rows: number[][] = [];
  const ops: string[] = [];
  for (let p = 0; p < parts; p++) {
    for (const op of operators) {
      for (let t = 0; t < repeats; t++) {
        rows.push([p + 1, 10 + ((p * 7 + op.charCodeAt(0) + t) % 13) * 0.01]);
        ops.push(op);
      }
    }
  }
  return { colNames: ['部件', '测量值'], rows, textCols: [{ name: '操作员', values: ops }] };
}

describe('CORE-03 prepareGageStudy 大交叉表不再 RangeError', () => {
  it('62500 部件 × 2 操作员 × 1 次(12.5 万胞,自动推荐角色):返回可读错误而非抛 RangeError', () => {
    const table = crossedLongTable(62_500, ['A', 'B'], 1);
    const M = computeVarModel('检验记录', table.colNames, table.rows);
    const selection = effectiveGageSelection(M, table.textCols, { value: null, part: null, operator: null });
    expect(selection).toEqual({ valueColumn: '测量值', partColumn: '部件', operatorColumn: '操作员' });
    const t0 = performance.now();
    let result: ReturnType<typeof prepareGageStudy> | null = null;
    expect(() => { result = prepareGageStudy(M, table.textCols, selection); }).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(result!.ok).toBe(false);
    const reason = (result as unknown as { reason: string }).reason;
    expect(reason).toContain('125000 个组合');
    expect(reason).toContain(`上限 ${GAGE_MAX_CROSS_CELLS}`);
    expect(reason).toMatch(/疑似.*ID 列/);
  });

  it('7 万部件 × 2 操作员长表(交叉完整、每胞 1 次,14 万行):不抛错且耗时有界', () => {
    const table = crossedLongTable(70_000, ['A', 'B'], 1);
    const M = computeVarModel('检验记录', table.colNames, table.rows);
    const t0 = performance.now();
    const result = prepareGageStudy(M, table.textCols, { valueColumn: '测量值', partColumn: '部件', operatorColumn: '操作员' });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('140000 个组合');
  });

  it('上限以内的不等重复仍给出最少/最多的具体胞(口径与文案不变)', () => {
    const table = crossedLongTable(3, ['A', 'B'], 2);
    table.rows.push([1, 10.5]);
    table.textCols[0].values.push('A');
    const M = computeVarModel('不等重复', table.colNames, table.rows);
    const result = prepareGageStudy(M, table.textCols, { valueColumn: '测量值', partColumn: '部件', operatorColumn: '操作员' });
    expect(result).toEqual({
      ok: false,
      reason: '各胞重复测量次数不一致:最少为部件「1」×操作员「B」(2 次),最多为部件「1」×操作员「A」(3 次);交叉 Gage R&R 要求所有部件×操作员组合重复次数相同且 ≥2',
    });
  });
});

describe('CORE-02 缺胞诊断不再按 部件×操作员 全量物化', () => {
  it('7 万部件 × 2 操作员长表(交叉不完整):不抛错、耗时与堆增长有界', () => {
    const rows: number[][] = [];
    const ops: string[] = [];
    for (let i = 0; i < 140_000; i++) {
      rows.push([(i % 70_000) + 1, 10 + (i % 7) * 0.013]);
      ops.push(i < 70_000 ? 'A' : (i % 3 === 0 ? 'B' : 'A'));
    }
    const M = computeVarModel('检验记录', ['部件', '测量值'], rows);
    const text = [{ name: '操作员', values: ops }];
    const h0 = heapUsed();
    const t0 = performance.now();
    const result = prepareGageStudy(M, text, { valueColumn: '测量值', partColumn: '部件', operatorColumn: '操作员' });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(heapUsed() - h0).toBeLessThan(200e6);
    expect(result.ok).toBe(false);
  });

  it('手选两列逐行唯一 ID(3000 行 → 900 万组合,修复前 +1.8 GB 堆):秒级内返回「疑似 ID 列」', () => {
    const rows: number[][] = [];
    for (let i = 0; i < 3_000; i++) rows.push([i + 1, 500_001 + i, 10 + (i % 9) * 0.01]);
    const M = computeVarModel('MES', ['样品号', '流水号', '测量值'], rows);
    const h0 = heapUsed();
    const t0 = performance.now();
    const result = prepareGageStudy(M, [], { valueColumn: '测量值', partColumn: '样品号', operatorColumn: '流水号' });
    const elapsed = performance.now() - t0;
    const grown = heapUsed() - h0;
    expect(elapsed).toBeLessThan(500);
    expect(grown).toBeLessThan(100e6);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('9000000 个组合');
      expect(result.reason).toMatch(/疑似.*ID 列/);
    }
  });

  it('零操作自动推荐路径(样品号逐行唯一 + 检验员 300 人,2 万行;修复前 +1.2 GB 堆)', () => {
    const rows: number[][] = [];
    const ops: string[] = [];
    for (let i = 0; i < 20_000; i++) { rows.push([i + 1, 10 + (i % 11) * 0.013]); ops.push(`检${i % 300}`); }
    const M = computeVarModel('MES', ['样品号', '测量值'], rows);
    const text = [{ name: '检验员', values: ops }];
    const selection = effectiveGageSelection(M, text, { value: null, part: null, operator: null });
    expect(selection.partColumn).toBe('样品号');
    expect(selection.operatorColumn).toBe('检验员');
    const h0 = heapUsed();
    const t0 = performance.now();
    const result = prepareGageStudy(M, text, selection);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(heapUsed() - h0).toBeLessThan(100e6);
    expect(result.ok).toBe(false);
  });

  it('上限以内的缺胞仍逐个指名前 3 个缺胞并给出总数(文案不变)', () => {
    const table = crossedLongTable(5, ['A', 'B', 'C'], 2);
    // 删掉 部件 1×C、部件 2×B、部件 3×A、部件 4×C 共 4 个胞
    const drop = new Set(['1|C', '2|B', '3|A', '4|C']);
    const keep = table.rows.map((row, i) => !drop.has(`${row[0]}|${table.textCols[0].values[i]}`));
    const rows = table.rows.filter((_, i) => keep[i]);
    const ops = table.textCols[0].values.filter((_, i) => keep[i]);
    const M = computeVarModel('缺胞', table.colNames, rows);
    const result = prepareGageStudy(M, [{ name: '操作员', values: ops }], { valueColumn: '测量值', partColumn: '部件', operatorColumn: '操作员' });
    expect(result).toEqual({
      ok: false,
      reason: '交叉设计不完整:部件「1」×操作员「C」缺 2 次测量、部件「2」×操作员「B」缺 2 次测量、部件「3」×操作员「A」缺 2 次测量等共 4 个组合缺测(其余胞均为 2 次)',
    });
  });
});

describe('CORE-02/03 App 壳层:Gage 研究只在 MSA 页按需计算,异常不再白屏', () => {
  it('导入 62500×2 长表(12.5 万胞)后渲染 App:壳层存活,MSA 页给出可读原因', () => {
    const table = crossedLongTable(62_500, ['A', 'B'], 1);
    useData.getState().importMatrix('检验记录', table.colNames, table.rows, table.textCols);
    expect(useData.getState().model.k).toBe(125_000);
    let view: ReturnType<typeof render> | null = null;
    expect(() => { view = render(<App />); }).not.toThrow();
    expect(view!.container.textContent).toContain('Gage R&R —');
    expect(view!.container.querySelector('.page-content')).not.toBeNull();
    act(() => useApp.getState().goTo('gagerr'));
    expect(view!.container.textContent).toContain('尚未运行 · 部件 62500 个水平 × 操作员 2 个水平');
    expect(view!.container.textContent).toContain('Gage R&R —');
  });

  it('非 MSA 页不跑 Gage 解析:有效研究在访问 MSA 页之前状态栏为「—」,访问后按同一输入共享结果', () => {
    const table = crossedLongTable(5, ['甲', '乙'], 2);
    useData.getState().importMatrix('Gage.csv', table.colNames, table.rows, table.textCols);
    const view = render(<App />);
    expect(view.container.textContent).toContain('Gage R&R —');
    act(() => useApp.getState().goTo('gagerr'));
    expect(view.container.textContent).toContain('导入数据 · 2 操作员 × 5 部件 × 2 次');
    const onMsa = view.container.textContent!.match(/Gage R&R ([0-9.]+%)/)?.[1];
    expect(onMsa).toBeTruthy();
    act(() => useApp.getState().goTo('dashboard'));
    expect(view.container.textContent).toContain(`Gage R&R ${onMsa}`);
    // 数据变化后(未回 MSA 页)不再展示旧值,诚实显示未运行
    act(() => { useData.getState().importMatrix('Gage2.csv', table.colNames, table.rows.map((r) => [r[0], r[1] + 0.001]), table.textCols); });
    expect(view.container.textContent).toContain('Gage R&R —');
  });
});

describe('UI-02 壳层错误边界', () => {
  it('Modals 渲染期抛错:只替换对话框层为可关闭的错误卡,菜单栏/页面/状态栏保留', () => {
    muteReactErrorLog();
    boom.modal = true;
    const view = render(<App />);
    expect(() => act(() => useApp.getState().openModal('help'))).not.toThrow();
    expect(view.container.textContent).toContain('对话框渲染出错');
    expect(view.container.textContent).toContain('MODAL_BOOM');
    expect(view.container.querySelector('.page-content')).not.toBeNull();
    expect(view.container.textContent).toContain('图表风格');
    fireEvent.click(view.getByText('关闭对话框'));
    expect(useApp.getState().modal).toBeNull();
    expect(view.container.textContent).not.toContain('对话框渲染出错');
    // 边界随对话框关闭自动复位:修好后再次打开可正常渲染
    boom.modal = false;
    act(() => useApp.getState().openModal('about'));
    expect(view.container.textContent).not.toContain('对话框渲染出错');
  });

  it('壳层组件(StatusBar)渲染期抛错:显示可恢复卡片而非白屏,「恢复演示数据集并重试」可逃生', () => {
    muteReactErrorLog();
    useData.getState().importMatrix('普通.csv', ['测量值'], [[1], [2], [3]]);
    boom.statusBar = true;
    let view: ReturnType<typeof render> | null = null;
    expect(() => { view = render(<App />); }).not.toThrow();
    const text = view!.container.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('应用界面渲染出错');
    expect(text).toContain('SHELL_BOOM');
    expect(view!.getByText('恢复演示数据集并重试')).toBeTruthy();
    boom.statusBar = false;
    fireEvent.click(view!.getByText('恢复演示数据集并重试'));
    expect(useData.getState().model.isDemo).toBe(true);
    expect(view!.container.textContent).not.toContain('应用界面渲染出错');
    expect(view!.container.textContent).toContain('图表风格');
  });

  it('壳层异常后「重试」:异常消失即恢复完整界面', () => {
    muteReactErrorLog();
    boom.statusBar = true;
    const view = render(<App />);
    expect(view.container.textContent).toContain('应用界面渲染出错');
    boom.statusBar = false;
    fireEvent.click(view.getByText('重试'));
    expect(view.container.textContent).not.toContain('应用界面渲染出错');
    expect(view.container.textContent).toContain('图表风格');
  });

});
