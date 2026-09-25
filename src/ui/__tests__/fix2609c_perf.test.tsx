/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 2 批 · G8-perf 回归:20 万行 / 5000 列性能包线。
 * - UI-05   工作表列虚拟化(宽表不再一次创建 行×列 个 EditableCell)
 * - GAP-10-22 总览页:按字段订阅 + memo + 判异/能力/AD 记忆化
 * - GAP-10-23 SPC 页:同上 + 判异明细走 pointRuleDetailLimit 有界通道(与全量展开逐项对拍)
 * - GAP-10-24 多列单格编辑:展开求和内核提速,增量与完整重建逐位一致
 * 计时断言一律留 ≥2 倍余量或用同进程相对基准;修复前后数值写在任务 notes。
 */
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { performance } from 'node:perf_hooks';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_K, computeCChart, computePChart, computeVarModel, cusumSeries, evalLimitedRules, evalRules, ewmaSeries,
  expandSpcRuleItems, mean, prepareSpcData, stagedRange, stagedXbar, stdev, uniqueSpcPointCount, updateVarModelCell,
  withSigmaMethod,
  type NelsonRuleK, type NelsonRules, type SpcViolationItem, type TextColumn,
} from '../../core';
import { platform } from '../../platform/adapter';
import { DEFAULT_SPC_RULES, useApp, type SpcType } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { chartTokens } from '../tokens';
import { Worksheet } from '../pages/Worksheet';
import { Dashboard } from '../pages/Dashboard';
import { Spc } from '../pages/Spc';
import { spcReport } from '../reportData';

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** 自相关 + 慢漂移(刀具磨损/温漂形态),三位小数:判异明细量级与审查复现一致。 */
function driftSeries(count: number, seed: number): number[] {
  const random = lcg(seed);
  let level = 0;
  return Array.from({ length: count }, (_, index) => {
    level = 0.92 * level + (random() - 0.5);
    return Math.round((10 + level + Math.sin(index / 5000) * 0.8) * 1000) / 1000;
  });
}

beforeEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard', modal: null, busyOverlay: null, toast: null, openMenu: null, varOpen: false, selSub: null,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcType: 'i-mr', spcRules: { ...DEFAULT_SPC_RULES },
    spcRuleK: { ...DEFAULT_RULE_K }, capSubgroupMode: 'spc',
  });
});
afterEach(() => {
  cancelPendingDatasetWork();
});

// ------------------------------------------------------------------ GAP-10-24(放在最前:计时不受后续 20 万行 UI 用例的堆/JIT 状态干扰)
/** 修复前 basicMath.expansionSumAtScale + mean 的逐字复刻,用于逐位对拍新内核。 */
function legacyExpansion(xs: number[], scale = 1): number {
  const partials: number[] = [];
  for (const raw of xs) {
    let x = raw / scale;
    let write = 0;
    for (let read = 0; read < partials.length; read++) {
      let y = partials[read];
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y;
      const low = y - (high - x);
      if (low !== 0) partials[write++] = low;
      x = high;
    }
    partials.length = write;
    partials.push(x);
  }
  let total = 0;
  for (const partial of partials) total += partial;
  return total;
}
function legacyMean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  if (xs.some((value) => !Number.isFinite(value))) return xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const unscaledTotal = legacyExpansion(xs);
  if (Number.isFinite(unscaledTotal)) return unscaledTotal / xs.length;
  let scale = 0;
  for (const value of xs) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return 0;
  const normalizedTotal = legacyExpansion(xs, scale);
  const total = normalizedTotal * scale;
  return Number.isFinite(total) ? total / xs.length : (normalizedTotal / xs.length) * scale;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe('GAP-10-24 多列单格编辑', () => {
  it('新展开求和内核与旧实现逐位一致(对抗性量级/排列/极值/非有限值)', () => {
    const random = lcg(424242);
    const cases: number[][] = [
      [], [0], [-0], [-0, -0], [1e16, -1e16, 1],
      [2 ** 108, -(2 ** 108), 2 ** 54, -(2 ** 54), -1],
      [-1, 2 ** 54, -(2 ** 108), 2 ** 108, -(2 ** 54)],
      [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE / 3],
      [Number.MIN_VALUE, 5e-324, -Number.MIN_VALUE, 1e-310],
      [1, Number.NaN, 2], [Number.POSITIVE_INFINITY, 1], [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      Array.from({ length: 5000 }, () => (random() - 0.5) * 10 ** Math.floor(random() * 60 - 30)),
      Array.from({ length: 5000 }, () => (random() < 0.5 ? -1 : 1) * random() * Number.MAX_VALUE),
      Array.from({ length: 20_000 }, () => Math.round((10 + (random() - 0.5) * 3.7) * 1000) / 1000),
      Array.from({ length: 2000 }, (_, i) => (i % 2 ? 1e300 : -1e300) + i),
    ];
    for (const xs of cases) expect(Object.is(mean(xs), legacyMean(xs)), `mean(${xs.slice(0, 4).join(',')}…)`).toBe(true);
  });

  it('200k×4 连续编辑与完整重建逐位一致,且每格耗时相对同进程旧求和基准显著下降', () => {
    const k = 200_000;
    const n = 4;
    const flat = driftSeries(k * n, 777);
    let rows = Array.from({ length: k }, (_, row) => flat.slice(row * n, row * n + n));
    const names = ['直径', '长度', '宽度', '高度'];
    let model = computeVarModel('200k×4', names, rows);
    const applyEdit = (row: number, col: number, value: number) => {
      model = updateVarModelCell(model, row, col, value);
      rows = rows.slice();
      rows[row] = [...rows[row]];
      rows[row][col] = value;
    };
    // 预热 JIT(与工厂逐格修正的稳态一致),预热编辑同样计入最终逐位对拍
    for (let warm = 0; warm < 3; warm++) {
      applyEdit(warm + 1, warm % n, 9.5 + warm);
      legacyMean(model.all);
      mean(model.all);
    }

    const editMs: number[] = [];
    const legacyMeanMs: number[] = [];
    const meanMs: number[] = [];
    for (let edit = 0; edit < 9; edit++) {
      const row = (edit * 48_611) % k;
      let started = performance.now();
      applyEdit(row, edit % n, 9 + edit * 0.125);
      editMs.push(performance.now() - started);
      // 同进程基准:修复前 mean 的逐字复刻(本批不改它),消除机器/CI 负载差异
      started = performance.now();
      legacyMean(model.all);
      legacyMeanMs.push(performance.now() - started);
      started = performance.now();
      mean(model.all);
      meanMs.push(performance.now() - started);
    }
    expect(model).toEqual(computeVarModel('200k×4', names, rows));
    // 取最小值:排除并发 worker/GC 抖动,两侧同口径
    const edit = Math.min(...editMs);
    const yardstick = Math.min(...legacyMeanMs);
    const newMean = Math.min(...meanMs);
    console.info(`[GAP-10-24] updateVarModelCell 200k×4 最小 ${edit.toFixed(1)}ms(中位 ${median(editMs).toFixed(1)}ms) · 旧 mean(80 万) ${yardstick.toFixed(1)}ms · 新 mean ${newMean.toFixed(1)}ms · 比值 ${(edit / yardstick).toFixed(2)}`);
    // 本机实测 修复前:单格编辑 74.2ms = 3.34× 旧 mean(22.2ms),新 mean ≡ 旧 mean(1.0×);
    // 修复后:单格编辑 28–31ms ≈ 1.45–1.9×,新 mean 8–9ms ≈ 0.4×。阈值取两侧中点附近留余量。
    expect(newMean).toBeLessThan(yardstick * 0.75);
    expect(edit).toBeLessThan(yardstick * 2.5);
  });
});

// ------------------------------------------------------------------ UI-05
describe('UI-05 工作表列虚拟化', () => {
  const editableCount = (root: ParentNode) => root.querySelectorAll('.worksheet-editable-cell').length;

  it('400 行 × 100 列宽表(≤400 行不触发旧行窗口):只渲染可视窗口,不再创建 4 万个编辑格', () => {
    const rows = Array.from({ length: 400 }, (_, r) => Array.from({ length: 100 }, (_, c) => ((r * 7 + c) % 97) + 0.5));
    act(() => { useData.getState().importMatrix('宽表100', Array.from({ length: 100 }, (_, c) => `P${c + 1}`), rows); });
    const started = performance.now();
    const { container } = render(<Worksheet />);
    const elapsed = performance.now() - started;
    const count = editableCount(container);
    console.info(`[UI-05] 400×100 首渲染 ${elapsed.toFixed(0)}ms · EditableCell=${count}`);
    // 修复前:40,000 个 EditableCell(jsdom 约 10s / 1.2GB);修复后按行×列双窗口
    expect(count).toBeLessThan(2_000);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    expect(grid.getAttribute('aria-rowcount')).toBe('401');
    expect(grid.getAttribute('aria-colcount')).toBe('101');
  });

  it('导入闸门上限 400 × 5000 列可挂载,渲染格数与列数无关', () => {
    const cols = 5000;
    const rows = Array.from({ length: 400 }, (_, r) => Array.from({ length: cols }, (_, c) => ((r + c) % 89) + 0.25));
    act(() => { useData.getState().importMatrix('宽表5000', Array.from({ length: cols }, (_, c) => `P${c + 1}`), rows); });
    const started = performance.now();
    const { container } = render(<Worksheet />);
    const elapsed = performance.now() - started;
    const count = editableCount(container);
    console.info(`[UI-05] 400×5000 首渲染 ${elapsed.toFixed(0)}ms · EditableCell=${count}`);
    expect(count).toBeLessThan(2_000);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    expect(grid.getAttribute('aria-colcount')).toBe('5001');
    // 占位格撑出全宽,滚动条与未渲染列一致
    expect((grid as HTMLTableElement).style.width).toBe(`${44 + cols * 120}px`);
    expect(screen.getByText(/宽表已启用列虚拟化 · 共 5,000 列/)).toBeTruthy();
  });

  it('横向滚动后:窗口列号/aria-colindex 正确,编辑写回真实列,键盘 End/Home 跨窗口移动焦点', async () => {
    const rows = Array.from({ length: 30 }, (_, r) => Array.from({ length: 300 }, (_, c) => r * 1000 + c));
    act(() => { useData.getState().importMatrix('宽表300', Array.from({ length: 300 }, (_, c) => `P${c + 1}`), rows); });
    const { container } = render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    expect(within(grid).queryByRole('columnheader', { name: /列 P300；/ })).toBeNull();
    expect(container.querySelectorAll('.worksheet-col-spacer').length).toBeGreaterThan(0);

    const scroller = grid.parentElement!;
    act(() => { fireEvent.scroll(scroller, { target: { scrollLeft: 120 * 200 } }); });
    const cell = within(grid).getByRole('gridcell', { name: /^P201，第 3 行，当前值 2200/ });
    expect(cell.getAttribute('aria-colindex')).toBe('202');
    expect(within(grid).queryByRole('gridcell', { name: /^P1，第 3 行/ })).toBeNull();
    expect(within(grid).getByRole('columnheader', { name: /列 P201；/ }).getAttribute('aria-colindex')).toBe('202');

    // 编辑:窗口内第 201 个测量列 → store 第 200 列(0 基)
    fireEvent.doubleClick(cell);
    const input = within(grid).getByRole('textbox', { name: '编辑P201，第 3 行' });
    fireEvent.change(input, { target: { value: '42.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useData.getState().model.subs[2].vals[200]).toBe(42.5);
    expect(useData.getState().model.subs[2].vals[199]).toBe(2199);

    // 键盘:End 跳到末列(窗口外)→ 自动横向滚动并聚焦;Home → 行号槽;→ 回到 P1
    const focusCell = within(grid).getByRole('gridcell', { name: /^P201，第 1 行/ });
    focusCell.focus();
    act(() => { fireEvent.keyDown(focusCell, { key: 'End' }); });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^P300，第 1 行/);
    expect(document.activeElement?.getAttribute('aria-colindex')).toBe('301');
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Home' }); });
    expect(document.activeElement?.getAttribute('role')).toBe('rowheader');
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^P1，第 1 行/);
    // 整张 grid 仍只有一个 Tab 停靠点
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('窄表(≤40 列)保持全列渲染,不加 aria-colindex 与占位格', () => {
    act(() => { useData.getState().importMatrix('窄表', ['A', 'B', 'C'], [[1, 2, 3], [4, 5, 6], [7, 8, 9]]); });
    const { container } = render(<Worksheet />);
    expect(editableCount(container)).toBe(9);
    expect(container.querySelectorAll('.worksheet-col-spacer')).toHaveLength(0);
    expect(container.querySelector('[aria-colindex]')).toBeNull();
  });
});

// ------------------------------------------------------------------ 总览 / SPC 页公共夹具
let commitMs = 0;
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => { commitMs += actualDuration; };

/** 模拟 App:全量订阅 app store(toast/菜单变化必重渲染),每次渲染新建 T 对象。 */
function Harness({ page }: { page: 'dashboard' | 'spc' }) {
  const { chartStyle, showGrid } = useApp();
  const T = chartTokens(chartStyle, showGrid);
  return (
    <Profiler id={page} onRender={onRender}>
      {page === 'spc' ? <Spc T={T} /> : <Dashboard T={T} />}
    </Profiler>
  );
}

function timed(label: string, action: () => void): { wall: number; render: number } {
  commitMs = 0;
  const started = performance.now();
  act(action);
  const wall = performance.now() - started;
  console.info(`[${label}] 墙钟 ${wall.toFixed(1)}ms · React 渲染 ${commitMs.toFixed(1)}ms`);
  return { wall, render: commitMs };
}

function load200kDrift() {
  const values = driftSeries(200_000, 20260925);
  act(() => { useData.getState().importMatrix('漂移20万', ['X'], values.map((value) => [value])); });
  const center = mean(values);
  const spread = stdev(values);
  useApp.setState({ lsl: center - 6 * spread, usl: center + 6 * spread, tgt: center, lslOn: true, uslOn: true });
  return values;
}

/** 无关 UI 状态变化的上限:修复前 200k 漂移数据为 300–700ms/次,这里留 >3 倍余量。 */
const UNRELATED_RENDER_BUDGET_MS = 100;

describe('GAP-10-22 总览页:无关状态变化不重跑 O(N) 计算', () => {
  it('200k 漂移数据:toast 出现/消失、菜单开合都不再阻塞;准则变化仍正确重算', () => {
    const values = load200kDrift();
    const mount = timed('GAP-10-22 首屏', () => { render(<Harness page="dashboard" />); });
    expect(mount.wall).toBeGreaterThan(0);

    const unrelated = [
      timed('GAP-10-22 showToast', () => useApp.getState().showToast('已保存分析')),
      timed('GAP-10-22 toast 清除', () => useApp.setState({ toast: null })),
      timed('GAP-10-22 setOpenMenu', () => useApp.getState().setOpenMenu('file')),
      timed('GAP-10-22 关闭菜单', () => useApp.getState().setOpenMenu(null)),
    ];
    for (const run of unrelated) {
      expect(run.wall).toBeLessThan(UNRELATED_RENDER_BUDGET_MS);
      expect(run.render).toBeLessThan(UNRELATED_RENDER_BUDGET_MS / 2);
    }

    // 相关变化(关掉准则 2)必须重算,且告警计数与真实判异引擎一致(口径不变:明细条数)
    const expectedAlerts = (rules: NelsonRules) => {
      const prepared = prepareSpcData(useData.getState().model, [], { layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: [] });
      const model = withSigmaMethod(prepared.model!, 'classic');
      const dispersion = evalLimitedRules(model.mr.slice(1) as number[], model.mrbar, model.mrUcl, 0, rules, DEFAULT_RULE_K);
      const main = evalRules(model.indiv, model.indMean, (model.iUcl - model.indMean) / 3, rules, DEFAULT_RULE_K);
      return dispersion.list.length || main.list.length;
    };
    const alertValue = () => screen.getByText('未处理告警').parentElement!.querySelector('.mono')!.textContent;
    expect(alertValue()).toBe(String(expectedAlerts(useApp.getState().spcRules)));
    timed('GAP-10-22 切换准则 2', () => useApp.getState().toggleRule('r2'));
    expect(useApp.getState().spcRules.r2).toBe(false);
    expect(alertValue()).toBe(String(expectedAlerts(useApp.getState().spcRules)));
    expect(values).toHaveLength(200_000);
  });
});

describe('GAP-10-23 SPC 页:无关状态变化不重跑判异链路', () => {
  it('200k 漂移 I-MR:toast/菜单零重算,点选数据点只做常数级渲染', () => {
    load200kDrift();
    useApp.setState({ page: 'spc' });
    timed('GAP-10-23 首屏', () => { render(<Harness page="spc" />); });
    const unrelated = [
      timed('GAP-10-23 showToast', () => useApp.getState().showToast('已保存分析')),
      timed('GAP-10-23 toast 清除', () => useApp.setState({ toast: null })),
      timed('GAP-10-23 setOpenMenu', () => useApp.getState().setOpenMenu('file')),
    ];
    for (const run of unrelated) {
      expect(run.wall).toBeLessThan(UNRELATED_RENDER_BUDGET_MS);
      expect(run.render).toBeLessThan(UNRELATED_RENDER_BUDGET_MS / 2);
    }
    // 列表只渲染 12 条,但总数取完整统计
    const summary = screen.getByText(/共 \d+ 个失控点 · \d+ 个点-准则命中/);
    const [, points, hits] = summary.textContent!.match(/共 (\d+) 个失控点 · (\d+) 个点-准则命中/)!;
    expect(Number(hits)).toBeGreaterThan(12);
    expect(Number(points)).toBeGreaterThan(0);
    const select = timed('GAP-10-23 点选数据点(selSub)', () => useApp.getState().setSelSub(10));
    // 点选会重绘图表选中态,但不再重跑判异/展开/排序
    expect(select.wall).toBeLessThan(UNRELATED_RENDER_BUDGET_MS * 3);
  });
});

// ------------------------------------------------------------------ GAP-10-23 有界明细与旧全量展开对拍
interface Scenario {
  name: string;
  type: SpcType;
  rows: number[][];
  textCols?: TextColumn[];
  stageCol?: string;
  ruleK?: NelsonRuleK;
  sigmaMethod?: 'classic' | 'pooled';
}

/** 旧实现(修复前 Spc.tsx 326-393 + spcReport 全量入参)的逐行复刻,作为对拍基准。 */
function legacyViolations(s: Scenario, prepared: ReturnType<typeof prepareSpcData>, rules: NelsonRules, K: NelsonRuleK) {
  const pModel = useData.getState().pModel;
  const cModel = useData.getState().cModel;
  const M = withSigmaMethod(prepared.model!, s.sigmaMethod ?? 'classic');
  const means = M.subs.map((sub) => sub.mean);
  const stageLabels = s.stageCol ? prepared.textCols.find((column) => column.name === s.stageCol)!.values : null;
  const staged = stageLabels && M.hasSubgroups
    ? {
        x: stagedXbar(M.subs.map((sub) => sub.vals), stageLabels, rules, s.sigmaMethod ?? 'classic', K),
        r: stagedRange(M.subs.map((sub) => sub.vals), stageLabels, rules, s.sigmaMethod ?? 'classic', K),
      }
    : null;
  const advData = M.hasSubgroups ? means : M.indiv;
  const advMu = M.hasSubgroups ? M.xbarbar : M.indMean;
  const advSigma = M.hasSubgroups ? M.sigmaChart / Math.sqrt(M.n) : M.iSig;
  const label: Record<SpcType, string> = { 'xbar-r': 'X̄', 'xbar-s': 'X̄', 'i-mr': 'I', ewma: 'EWMA', cusum: 'CUSUM', p: 'P', c: 'C' };
  let viol: Set<number>;
  let list: { i: number; rule: number; desc: string }[];
  let mainLength: number;
  const dispItems: SpcViolationItem[] = [];
  const pushDisp = (dViol: Set<number>, dList: { i: number; rule: number; desc: string }[], chartLabel: string, offset: number) => {
    if (!dViol.size) return;
    expandSpcRuleItems(dViol, dList, chartLabel, K).forEach((item) => {
      dispItems.push({ ...item, i: item.i + offset, desc: `${chartLabel} 图：${item.desc}` });
    });
  };
  if (s.type === 'xbar-r' && staged) {
    viol = staged.x.viol; list = staged.x.list; mainLength = means.length;
    pushDisp(staged.r.viol, staged.r.list, 'R', 0);
  } else if (s.type === 'xbar-r' || s.type === 'xbar-s') {
    const usesS = s.type === 'xbar-s';
    const r = evalRules(means, M.xbarbar, ((usesS ? M.uclXs : M.uclX) - M.xbarbar) / 3, rules, K);
    viol = r.viol; list = r.list; mainLength = means.length;
    const d = usesS
      ? evalLimitedRules(M.svals, M.sCl, M.uclS, M.lclS, rules, K)
      : evalLimitedRules(M.subs.map((sub) => sub.range), M.rCl, M.uclR, M.lclR, rules, K);
    pushDisp(d.viol, d.list, usesS ? 'S' : 'R', 0);
  } else if (s.type === 'i-mr') {
    const r = evalRules(M.indiv, M.indMean, (M.iUcl - M.indMean) / 3, rules, K);
    viol = r.viol; list = r.list; mainLength = M.indiv.length;
    const d = evalLimitedRules(M.mr.slice(1) as number[], M.mrbar, M.mrUcl, 0, rules, K);
    pushDisp(d.viol, d.list, 'MR', 1);
  } else if (s.type === 'p') {
    const r = evalLimitedRules(pModel.pprop, pModel.pbar, pModel.pUcls, pModel.pLcls, rules, K,
      pModel.pNs.map((n) => Math.sqrt(pModel.pbar * (1 - pModel.pbar) / n)));
    viol = r.viol; list = r.list; mainLength = pModel.pprop.length;
  } else if (s.type === 'c') {
    const r = evalLimitedRules(cModel.cdata, cModel.cbar, cModel.cUcl, cModel.cLcl, rules, K, Math.sqrt(cModel.cbar));
    viol = r.viol; list = r.list; mainLength = cModel.cdata.length;
  } else {
    const series = s.type === 'ewma'
      ? ewmaSeries(advData, advMu, advSigma)
      : cusumSeries(advData, advMu, advSigma, 0.5, M.hasSubgroups ? 4 : 5);
    viol = series.viol;
    list = [...viol].sort((a, b) => a - b).map((i) => ({ i, rule: 1, desc: s.type === 'ewma' ? 'EWMA 超出时变控制限' : '累积和超出判定限 H' }));
    mainLength = advData.length;
  }
  const all = [
    ...expandSpcRuleItems(viol, list, label[s.type], K),
    ...dispItems,
  ].sort((a, b) => a.i - b.i || a.chartLabel.localeCompare(b.chartLabel) || a.rule - b.rule);
  return { all, dispItems, mainLength, M };
}

function subgroupRows(k: number, n: number, seed: number): number[][] {
  const flat = driftSeries(k * n, seed);
  return Array.from({ length: k }, (_, row) => flat.slice(row * n, row * n + n));
}

const SCENARIOS: Scenario[] = [
  { name: 'I-MR 漂移', type: 'i-mr', rows: driftSeries(3000, 11).map((v) => [v]) },
  { name: 'I-MR 自定义 K', type: 'i-mr', rows: driftSeries(3000, 12).map((v) => [v]), ruleK: { ...DEFAULT_RULE_K, k1: 2.5, k2: 7, k3: 5, k7: 12, k8: 6 } },
  { name: 'X̄-R n=5', type: 'xbar-r', rows: subgroupRows(800, 5, 13) },
  { name: 'X̄-R pooled', type: 'xbar-r', rows: subgroupRows(800, 4, 14), sigmaMethod: 'pooled' },
  { name: 'X̄-S n=6', type: 'xbar-s', rows: subgroupRows(700, 6, 15) },
  {
    name: 'X̄-R 分阶段', type: 'xbar-r', rows: subgroupRows(900, 5, 16), stageCol: '阶段',
    textCols: [{ name: '阶段', values: Array.from({ length: 900 }, (_, i) => (i < 300 ? '甲' : i < 650 ? '乙' : '丙')) }],
  },
  { name: 'EWMA', type: 'ewma', rows: driftSeries(3000, 17).map((v) => [v]) },
  { name: 'CUSUM', type: 'cusum', rows: subgroupRows(600, 5, 18) },
  { name: 'P 图(变样本量)', type: 'p', rows: driftSeries(40, 19).map((v) => [v]) },
  { name: 'C 图', type: 'c', rows: driftSeries(40, 20).map((v) => [v]) },
];

describe('GAP-10-23 有界明细视图与旧全量展开逐项一致', () => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const { computeSpcPageView } = await import('../pages/Spc');
    expect(typeof computeSpcPageView).toBe('function');
    const random = lcg(99);
    const pCounts = Array.from({ length: 60 }, (_, i) => Math.round(8 + 6 * Math.sin(i / 4) + random() * 6 + (i > 45 ? 12 : 0)));
    const pSizes = Array.from({ length: 60 }, (_, i) => 180 + (i % 7) * 15);
    const cCounts = Array.from({ length: 60 }, (_, i) => Math.round(5 + 3 * Math.sin(i / 3) + random() * 4 + (i > 40 ? 8 : 0)));
    useData.setState({ pModel: computePChart(pCounts, pSizes, 'P 测试'), cModel: computeCChart(cCounts, 'C 测试') });
    const n = scenario.rows[0].length;
    const model = computeVarModel(scenario.name, Array.from({ length: n }, (_, i) => `X${i + 1}`), scenario.rows, {
      sigmaMethod: 'classic',
    });
    const textCols = scenario.textCols ?? [];
    const prepared = prepareSpcData(model, textCols, {
      layout: n === 1 ? 'individuals' : 'rows', valueColumn: null, subgroupColumn: null, pendingCells: [],
    });
    const rules: NelsonRules = { r1: true, r2: true, r3: true, r4: true, r5: true, r6: true, r7: true, r8: true };
    const K = scenario.ruleK ?? { ...DEFAULT_RULE_K };
    const view = computeSpcPageView({
      prepared, rawModel: model, spcType: scenario.type, spcSigmaMethod: scenario.sigmaMethod ?? 'classic',
      spcStageCol: scenario.stageCol ?? null, spcRules: rules, spcRuleK: K, spcShowZones: false,
      pModel: useData.getState().pModel, cModel: useData.getState().cModel,
    });
    const legacy = legacyViolations(scenario, prepared, rules, K);
    expect(view.effType).toBe(scenario.type);
    if (scenario.stageCol) expect(view.staged).not.toBeNull();
    expect(legacy.all.length, '场景需要足够多的命中以覆盖截断').toBeGreaterThan(12);

    const v = view.violations;
    expect(v.items).toEqual(legacy.all.slice(0, 12));
    expect(v.pointRuleHitCount).toBe(legacy.all.length);
    expect(v.affectedPointCount).toBe(uniqueSpcPointCount(legacy.all));
    const byRule: Record<number, number> = {};
    legacy.all.forEach((item) => { byRule[item.rule] = (byRule[item.rule] ?? 0) + 1; });
    expect(v.byRule).toEqual(byRule);
    expect(v.variation.affectedPointCount).toBe(uniqueSpcPointCount(legacy.dispItems));
    expect(v.variation.pointRuleHitCount).toBe(legacy.dispItems.length);
    expect(v.variationItems).toEqual([...legacy.dispItems]
      .sort((a, b) => a.i - b.i || a.chartLabel.localeCompare(b.chartLabel) || a.rule - b.rule).slice(0, 12));
    const points = new Set(legacy.all.map((item) => item.i));
    for (let i = 0; i < legacy.mainLength + 1; i++) expect(v.isViolationPoint(i)).toBe(points.has(i));

    // 结论卡:有界入参 + 完整统计 ≡ 旧的全量入参
    const variationChartLabel = scenario.type === 'xbar-r' ? 'R' : scenario.type === 'xbar-s' ? 'S' : scenario.type === 'i-mr' ? 'MR' : null;
    const expectedReport = spcReport({
      ...{
        k: view.main.props.data.length,
        n: scenario.type === 'p' ? useData.getState().pModel.pNs : scenario.type === 'c' ? 1 : legacy.M.n,
        hasSubgroups: scenario.type === 'p' || scenario.type === 'c' ? false : legacy.M.hasSubgroups,
        structure: scenario.type === 'p' ? 'attribute-p' : scenario.type === 'c' ? 'attribute-c' : legacy.M.hasSubgroups ? 'subgroup' : 'individual',
        typeLabel: { 'xbar-r': 'X̄-R', 'xbar-s': 'X̄-S', 'i-mr': 'I-MR', ewma: 'EWMA', cusum: 'CUSUM', p: 'P 图', c: 'C 图' }[scenario.type],
        advancedChart: scenario.type === 'ewma' || scenario.type === 'cusum' ? scenario.type : undefined,
        variableName: scenario.type === 'p' || scenario.type === 'c' ? undefined : prepared.variableName,
        dataRole: view.report.checks.find((check) => check.name === '数据角色')?.note,
      },
      violList: legacy.all,
      variationChartLabel,
      variationViolations: legacy.dispItems,
    });
    expect(view.report).toEqual(expectedReport);
  });
});

