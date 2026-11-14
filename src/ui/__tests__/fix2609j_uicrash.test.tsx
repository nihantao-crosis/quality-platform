/**
 * fix2609j G18-uicrash(UI 层):
 * - UI-10:帕累托图/缺陷明细表/总览帕累托对最多 5 万类别不设显示上限(数十万 SVG/DOM 节点)。
 * - UI-21:DOE 分析页设计矩阵表不设行数上限(大型生产记录被识别为重复 2² 设计后渲染上万行)。
 * - UI-20:帕累托页无 selector 订阅 + 鱼骨图 key 含实时存储内容 → 无关状态变化让鱼骨图重挂载丢草稿/选中/焦点。
 * - CORE-07:Gage 角色推荐只在 MSA 页按需计算且同一输入只打分一次;其他页编辑单元格不触发推荐。
 * 全部渲染真实生产组件、调用真实 store/解析函数。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import App from '../../App';
import { parseCategoryCounts } from '../../core';
import { __gageRecommendationComputeCountForTests } from '../../core/gageData';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { clearFishboneState, loadFishboneState, saveFishboneState, FISHBONE_DEFAULT } from '../../store/fishboneStore';
import { MAX_PARETO_PLOT_BARS, ParetoChart } from '../charts/misc';
import { paretoReport } from '../reportData';
import { Dashboard } from '../pages/Dashboard';
import { Doe, MAX_DOE_MATRIX_ROWS } from '../pages/Doe';
import { MAX_PARETO_TABLE_ROWS, Pareto } from '../pages/SimplePages';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'pareto', modal: null, openMenu: null, toast: null, busyOverlay: null, varOpen: false,
    paretoView: 'pareto', paretoThreshold: 0.95, paretoShowDemo: false, fishboneRevision: 0,
  });
});

afterEach(() => {
  cleanup();
  cancelPendingDatasetWork();
});

/** 5 万条互不相同的单列原始标签(MES 自由文本/序列号误粘)→ 真实 parseCategoryCounts 自动计数。 */
function fiftyThousandCategories() {
  const labels = Array.from({ length: 50_000 }, (_, i) => `SN-${String(i).padStart(6, '0')}`);
  // 让频数有差异(前几类多一些),其余各 1 次
  const text = [...labels, ...labels.slice(0, 40), ...labels.slice(0, 10)].join('\n');
  const parsed = parseCategoryCounts(text);
  if ('error' in parsed) throw new Error(parsed.error);
  expect(parsed.rows.length).toBe(50_000);
  return parsed.rows;
}

function count(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
}

describe('UI-10 帕累托显示预算(5 万类别)', () => {
  it('ParetoChart 960×340 / 520×210:节点有界、渲染快;注明被折叠类别数;累计仍到 100%', () => {
    const rows = paretoReport({ rows: fiftyThousandCategories(), mergeOther: false, threshold: 0.95 })
      .rows.map(({ name, count: c }) => ({ name, count: c }));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    for (const [w, h] of [[960, 340], [520, 210]] as const) {
      const t0 = performance.now();
      const html = renderToStaticMarkup(createElement(ParetoChart, { T, rows, w, h, title: 'SN 的 Pareto 图' }));
      const elapsed = performance.now() - t0;
      // 修复前(实测):960×340 → 1593ms、50.9MB、rect 50002 / text 200017 / circle 50000
      expect(elapsed, `${w}×${h} 渲染 ${elapsed.toFixed(1)}ms`).toBeLessThan(250);
      expect(count(html, 'rect')).toBeLessThanOrEqual(MAX_PARETO_PLOT_BARS + 2);
      expect(count(html, 'circle')).toBeLessThanOrEqual(MAX_PARETO_PLOT_BARS);
      expect(count(html, 'text')).toBeLessThan(200);
      expect(html.length).toBeLessThan(100_000);
      const folded = 50_000 - (MAX_PARETO_PLOT_BARS - 1);
      expect(html).toContain(`共 50000 类`);
      expect(html).toContain(`其余 ${folded} 类`);
      // 左轴顶=全量总数(统计用全量,不因折叠丢频数)
      expect(html).toContain(`>${total}</text>`);
      if (h >= 260) expect(html).toContain('>100</text>'); // 统计表累积% 末列(「其他」)= 100
    }
  });

  it('未超预算时图形逐类绘制,不出现折叠说明(既有形制不变)', () => {
    const rows = [{ name: 'A', count: 10 }, { name: 'B', count: 6 }, { name: 'C', count: 2 }];
    const html = renderToStaticMarkup(createElement(ParetoChart, { T, rows, w: 960, h: 340 }));
    expect(count(html, 'circle')).toBe(3);
    expect(html).not.toContain('其余');
    expect(html).not.toMatch(/共 \d+ 类/);
  });

  it('帕累托页:图与缺陷明细表都有上限并明示折叠数;件数/结论仍按全量', () => {
    const rows = fiftyThousandCategories();
    expect(useData.getState().importPareto('序列号', rows).rejected).toBeUndefined();
    const t0 = performance.now();
    const view = render(createElement(Pareto, { T }));
    const elapsed = performance.now() - t0;
    const tbodyRows = view.container.querySelectorAll('tbody tr').length;
    // 修复前:明细表 5 万行 + 图 15 万+ SVG 节点(jsdom 挂载 ~2s+)
    expect(tbodyRows).toBeLessThanOrEqual(MAX_PARETO_TABLE_ROWS);
    expect(view.container.querySelectorAll('circle').length).toBeLessThanOrEqual(MAX_PARETO_PLOT_BARS);
    expect(view.container.querySelectorAll('*').length).toBeLessThan(2000);
    expect(elapsed, `页面挂载 ${elapsed.toFixed(1)}ms`).toBeLessThan(1500);
    const text = view.container.textContent ?? '';
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    expect(text).toContain(`共 ${total} 件`);
    expect(text).toContain(`其余 ${50_000 - (MAX_PARETO_TABLE_ROWS - 1)} 类`);
    expect(text).toContain('共 50000 类');
    // 折叠行累计 = 100%
    const last = view.container.querySelectorAll('tbody tr')[tbodyRows - 1];
    expect(last.textContent).toContain('100%');
  });

  it('质量总览(默认落地页)的帕累托同样受上限保护', () => {
    useData.getState().importPareto('序列号', fiftyThousandCategories());
    useApp.setState({ page: 'dashboard' });
    const t0 = performance.now();
    const view = render(createElement(Dashboard, { T }));
    const elapsed = performance.now() - t0;
    // 修复前:总览尺寸 jsdom 挂载 2190ms、150,022 个 DOM 节点
    expect(view.container.querySelectorAll('circle').length).toBeLessThan(MAX_PARETO_PLOT_BARS + 200);
    expect(view.container.querySelectorAll('*').length).toBeLessThan(10_000);
    expect(view.container.textContent).toContain('共 50000 类');
    expect(elapsed, `总览挂载 ${elapsed.toFixed(1)}ms`).toBeLessThan(2000);
  });
});

describe('UI-21 DOE 设计矩阵表行数上限', () => {
  /** 班次(1/2)×机台(1/2)×测量值 的生产记录——默认列角色即被识别为重复 2² 设计。 */
  function productionLog(n: number) {
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) rows.push([(i % 2) + 1, (Math.floor(i / 2) % 2) + 1, 50 + ((i * 37) % 101) / 100]);
    return rows;
  }

  it('2 万行生产记录:设计矩阵只渲染前 N 行并注明总运行数与「不像按设计采集」提示', () => {
    useData.getState().importMatrix('MES抽取', ['班次', '机台', '测量值'], productionLog(20_000));
    useApp.setState({ page: 'doe', doeTab: 'analyze', doeFactorCols: null, doeRespCol: null });
    const t0 = performance.now();
    const view = render(createElement(Doe, { T }));
    const elapsed = performance.now() - t0;
    const table = Array.from(view.container.querySelectorAll('table')).find((tb) => tb.querySelector('th')?.textContent === '运行');
    expect(table).toBeTruthy();
    const matrixCard = table!.parentElement!.parentElement!;
    expect(matrixCard.textContent, '应识别为 2 因子设计').toMatch(/^设计矩阵 · 2 因子 \(20000 运行\)/);
    // 修复前:tbody 20000 行 / 80000 个 td
    expect(table!.querySelectorAll('tbody tr').length).toBe(MAX_DOE_MATRIX_ROWS);
    expect(view.container.querySelectorAll('td').length).toBeLessThan(5000);
    expect(matrixCard.textContent).toContain(`共 20000 运行，仅显示前 ${MAX_DOE_MATRIX_ROWS} 行`);
    expect(matrixCard.textContent).toContain('不像按设计采集');
    expect(elapsed, `DOE 页挂载 ${elapsed.toFixed(1)}ms`).toBeLessThan(4000);
  });

  it('标准规模设计(8 运行)全量显示,无截断提示', () => {
    useData.getState().importMatrix('DOE', ['A', 'B', '响应'], productionLog(8));
    useApp.setState({ page: 'doe', doeTab: 'analyze', doeFactorCols: null, doeRespCol: null });
    const view = render(createElement(Doe, { T }));
    const table = Array.from(view.container.querySelectorAll('table')).find((tb) => tb.querySelector('th')?.textContent === '运行');
    expect(table!.querySelectorAll('tbody tr').length).toBe(8);
    expect(view.container.textContent).not.toContain('仅显示前');
    expect(view.container.textContent).not.toContain('不像按设计采集');
  });
});

describe('UI-20 鱼骨图不随无关状态变化重挂载', () => {
  function setupFishbone() {
    useApp.setState({ paretoView: 'fishbone' });
    const view = render(createElement(Pareto, { T }));
    const categoryButton = (label: string) => Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent === label)!;
    const draftInput = () => view.container.querySelector<HTMLInputElement>('input[placeholder^="添加「"]')!;
    const problemInput = () => view.container.querySelector<HTMLInputElement>('input[placeholder="待分析的质量问题"]')!;
    return { view, categoryButton, draftInput, problemInput };
  }

  it('选「料」→ 添加原因 → 输入草稿并聚焦;toast/菜单变化后类别、草稿、焦点、节点都保留', () => {
    const { categoryButton, draftInput } = setupFishbone();
    fireEvent.click(categoryButton('料'));
    fireEvent.change(draftInput(), { target: { value: '来料批次混料' } });
    fireEvent.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '添加')!);
    expect(loadFishboneState().data.categories[2].causes).toContain('来料批次混料');
    const input = draftInput();
    fireEvent.change(input, { target: { value: '正在输入的原因B' } });
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => { useApp.setState({ toast: null, openMenu: '文件' }); });
    act(() => { useApp.getState().showToast('任意提示'); });
    act(() => { useApp.setState({ toast: null, openMenu: null, varOpen: true }); });

    // 修复前:{cat:'人', draft:'', focused:false},且输入框节点被替换
    expect(draftInput()).toBe(input);
    expect(categoryButton('料').getAttribute('aria-pressed')).toBe('true');
    expect(draftInput().value).toBe('正在输入的原因B');
    expect(document.activeElement).toBe(input);
  });

  it('「问题」输入框边打字边遇 toast 消失:不被夺焦', () => {
    const { problemInput } = setupFishbone();
    const input = problemInput();
    fireEvent.change(input, { target: { value: '压装力超差' } });
    input.focus();
    act(() => { useApp.setState({ toast: null, openMenu: null, varOpen: false }); });
    act(() => { useApp.getState().showToast('上一步操作完成'); });
    expect(problemInput()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('压装力超差');
  });

  it('外部改写鱼骨存储仍会刷新:历史恢复(bumpFishboneRevision)与「清除本地数据」遮罩事务', () => {
    const { view, problemInput } = setupFishbone();
    fireEvent.change(problemInput(), { target: { value: '用户问题' } });
    expect(loadFishboneState().isDemo).toBe(false);
    // 历史恢复路径:写存储后 bump
    act(() => {
      saveFishboneState({ ...FISHBONE_DEFAULT, problem: '历史问题' }, false);
      useApp.getState().bumpFishboneRevision();
    });
    expect(problemInput().value).toBe('历史问题');
    // 清除本地数据路径(OptionsModal 同序):遮罩 → clearFishboneState → 撤遮罩 → toast
    act(() => { useApp.getState().setBusyOverlay('正在停止后台写入并清除本地数据…'); });
    act(() => { clearFishboneState(); });
    act(() => {
      useApp.getState().setBusyOverlay(null);
      useApp.getState().showToast('浏览器数据与本机数据集库已清除');
    });
    expect(problemInput().value).toBe(FISHBONE_DEFAULT.problem);
    expect(view.container.textContent).toContain('当前为内置“尺寸超差”示例');
  });
});

describe('CORE-07 Gage 角色推荐只在 MSA 页按需计算', () => {
  /** 宽表:1 个小数测量列 + 24 个小整数编码列(每列都会进推荐的两两配对)。 */
  function wideTable(rows: number, cols: number) {
    const colNames = ['测量值', ...Array.from({ length: cols }, (_, c) => `编码${c + 1}`)];
    const data: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row = [10 + ((r * 13) % 97) / 100];
      for (let c = 0; c < cols; c++) row.push((r >> (c % 4)) % (2 + (c % 5)));
      data.push(row);
    }
    return { colNames, data };
  }

  it('工作表页连续编辑单元格:壳层不触发推荐打分;进入 MSA 页只打分一次(修复前壳层+页面 3 次),页上编辑每次一次', () => {
    const { colNames, data } = wideTable(1500, 24);
    useData.getState().importMatrix('MES宽表', colNames, data);
    useApp.setState({ page: 'worksheet', gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null });
    render(<App />);
    const start = __gageRecommendationComputeCountForTests();
    for (let i = 0; i < 3; i++) act(() => { useData.getState().updateCell(i, 1, 1); });
    act(() => { useApp.getState().showToast('无关提示'); });
    expect(__gageRecommendationComputeCountForTests() - start).toBe(0);

    act(() => useApp.getState().goTo('gagerr'));
    const onMsa = __gageRecommendationComputeCountForTests() - start;
    expect(onMsa).toBe(1);
    act(() => { useData.getState().updateCell(5, 2, 0); });
    expect(__gageRecommendationComputeCountForTests() - start).toBe(2);
    // 无关 UI 状态变化不重算
    act(() => { useApp.setState({ openMenu: '文件' }); });
    act(() => { useApp.setState({ openMenu: null }); });
    expect(__gageRecommendationComputeCountForTests() - start).toBe(2);
    // 离开 MSA 页后编辑:不计算
    act(() => useApp.getState().goTo('worksheet'));
    act(() => { useData.getState().updateCell(6, 2, 1); });
    expect(__gageRecommendationComputeCountForTests() - start).toBe(2);
  });
});
