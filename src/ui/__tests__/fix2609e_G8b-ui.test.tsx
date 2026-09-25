/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 2 批复审收口 · G8b-ui 回归。
 * - UI-05(P2)焦点 effect 抢占:方向键一次后,鼠标/触控板横向或纵向滚动引起的窗口变化
 *   不得再对钳制格调用 focus()(抢走 grid 外输入框焦点、把滚动拉回)。
 * - UI-05(P3)行窗口阈值:≤40 列窄表只按行数 >400 开行窗口(400×31、301×38 与旧版 DOM 一致)。
 * - UI-05(P3)定宽列:列头 title 带列名、文本列 td 带 title。
 * - GAP-10-22(P2)壳层阻塞:真实 <App/> 在 20 万行 + 已确认 1000σ 远规格下,toast/菜单
 *   变化不再重跑 isCapabilityWarningAcknowledged / computeCapability。
 */
import { performance } from 'node:perf_hooks';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ computeCapability: 0, acknowledged: 0 }));

vi.mock('../../core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core')>();
  return {
    ...actual,
    computeCapability: (...args: Parameters<typeof actual.computeCapability>) => {
      spies.computeCapability += 1;
      return actual.computeCapability(...args);
    },
  };
});
vi.mock('../../store/dataStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/dataStore')>();
  return {
    ...actual,
    isCapabilityWarningAcknowledged: (...args: Parameters<typeof actual.isCapabilityWarningAcknowledged>) => {
      spies.acknowledged += 1;
      return actual.isCapabilityWarningAcknowledged(...args);
    },
  };
});

import App from '../../App';
import { capabilityWarningFingerprint, computeCapability, DEFAULT_RULE_K, nf } from '../../core';
import { platform } from '../../platform/adapter';
import { useAnalyses } from '../../store/analyses';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import {
  cancelPendingDatasetWork, capabilitySpecKey, capabilitySubgroupSemantics, resolveCapabilityMeasurementData, useData,
} from '../../store/dataStore';
import { Worksheet } from '../pages/Worksheet';

beforeEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
  useApp.setState({
    page: 'worksheet', modal: null, busyOverlay: null, toast: null, openMenu: null, varOpen: false, selSub: null,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcType: 'i-mr', spcRules: { ...DEFAULT_SPC_RULES },
    spcRuleK: { ...DEFAULT_RULE_K }, capSubgroupMode: 'spc', capabilityWarningAcknowledgement: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cancelPendingDatasetWork();
});

function importWide(name: string, rowCount: number, colCount: number, textCols: Parameters<ReturnType<typeof useData.getState>['importMatrix']>[3] = []) {
  const rows = Array.from({ length: rowCount }, (_, r) => Array.from({ length: colCount }, (_, c) => r * 1000 + c));
  act(() => { useData.getState().importMatrix(name, Array.from({ length: colCount }, (_, c) => `P${c + 1}`), rows, textCols); });
}

function renderWithOutsideInput() {
  const view = render(
    <>
      <input aria-label="外部备注" />
      <Worksheet />
    </>,
  );
  const grid = screen.getByRole('grid', { name: '数据工作表' });
  return { ...view, grid, scroller: grid.parentElement as HTMLDivElement, outside: screen.getByLabelText('外部备注') as HTMLInputElement };
}

// ------------------------------------------------------------------ UI-05 焦点抢占
describe('UI-05 复审:窗口变化不再抢焦点/拉回滚动', () => {
  it('列窗口:方向键一次后焦点移到外部输入框,连续横向滚动不调用 focus()、焦点与 scrollLeft 不变', () => {
    importWide('宽表300', 30, 300);
    const { grid, scroller, outside } = renderWithOutsideInput();
    const first = within(grid).getByRole('gridcell', { name: /^P1，第 1 行/ });
    first.focus();
    act(() => { fireEvent.keyDown(first, { key: 'ArrowRight' }); });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^P2，第 1 行/);

    outside.focus();
    expect(document.activeElement).toBe(outside);
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    // 复审轨迹:12000 → 14650 → 15550(Chromium 中曾回跳到 11409.5 / 14050 / 15010)
    for (const left of [12_000, 14_650, 15_550]) {
      act(() => { fireEvent.scroll(scroller, { target: { scrollLeft: left } }); });
      expect(scroller.scrollLeft).toBe(left);
      expect(document.activeElement).toBe(outside);
    }
    expect(focusSpy).not.toHaveBeenCalled();
    // 窗口确实移动了(否则本用例不构成复现)
    expect(within(grid).queryByRole('gridcell', { name: /^P2，第 1 行/ })).toBeNull();
    // grid 仍保有唯一 Tab 停靠点
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('行窗口:方向键一次后焦点移到外部输入框,纵向滚动不调用 focus()', () => {
    importWide('长表1000', 1000, 3);
    const { grid, scroller, outside } = renderWithOutsideInput();
    const first = within(grid).getByRole('gridcell', { name: /^P1，第 1 行/ });
    first.focus();
    act(() => { fireEvent.keyDown(first, { key: 'ArrowDown' }); });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^P1，第 2 行/);

    outside.focus();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    for (const top of [30 * 300, 30 * 600]) {
      act(() => { fireEvent.scroll(scroller, { target: { scrollTop: top } }); });
      expect(scroller.scrollTop).toBe(top);
      expect(document.activeElement).toBe(outside);
    }
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('grid 内原焦点格随滚动被卸载时,无滚动地移到钳制停靠格(键盘用户不丢位置)', () => {
    importWide('宽表300', 30, 300);
    const { grid, scroller } = renderWithOutsideInput();
    const first = within(grid).getByRole('gridcell', { name: /^P1，第 1 行/ });
    first.focus();
    act(() => { fireEvent.keyDown(first, { key: 'ArrowRight' }); });
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    act(() => { fireEvent.scroll(scroller, { target: { scrollLeft: 120 * 200 } }); });
    expect(within(grid).queryByRole('gridcell', { name: /^P2，第 1 行/ })).toBeNull();
    const active = document.activeElement as HTMLElement;
    expect(grid.contains(active)).toBe(true);
    expect(active.getAttribute('tabindex')).toBe('0');
    expect(active.getAttribute('data-grid-row')).toBe('1');
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(scroller.scrollLeft).toBe(120 * 200);
  });

  it('新的键盘请求仍正常聚焦(End 跨窗口)', () => {
    importWide('宽表300', 30, 300);
    const { grid } = renderWithOutsideInput();
    const first = within(grid).getByRole('gridcell', { name: /^P1，第 1 行/ });
    first.focus();
    act(() => { fireEvent.keyDown(first, { key: 'ArrowRight' }); });
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'End' }); });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^P300，第 1 行/);
  });
});

// ------------------------------------------------------------------ UI-05 P3 阈值与 title
describe('UI-05 复审 P3:窄表行窗口分界与定宽列 title', () => {
  const renderedRows = (root: ParentNode) => root.querySelectorAll('tr.ws-row').length;

  it.each([
    [400, 30],
    [400, 31],
    [301, 40],
    [301, 38],
    [350, 38],
  ])('%i 行 × %i 列(≤40 渲染列)全部行渲染,与旧版 DOM 一致', (rowCount, colCount) => {
    importWide(`窄表${rowCount}x${colCount}`, rowCount, colCount);
    const { container } = render(<Worksheet />);
    expect(renderedRows(container)).toBe(rowCount);
    expect(container.querySelector('.worksheet-virtual-spacer')).toBeNull();
    expect(container.querySelector('.worksheet-col-spacer')).toBeNull();
  });

  it('301 行 × 41 列(已开列窗口)仍按行×窗口列数启用行窗口', () => {
    importWide('宽表301x41', 301, 41);
    const { container } = render(<Worksheet />);
    expect(container.querySelector('.worksheet-col-spacer')).not.toBeNull();
    expect(renderedRows(container)).toBeLessThan(301);
    expect(container.querySelector('.worksheet-virtual-spacer')).not.toBeNull();
  });

  it('定宽列:列头 title 含完整列名,长名省略号生效;文本列单元格 title 给出全值', () => {
    const longName = '三坐标测点_左前轮毂安装面平面度_批次A';
    const rows = Array.from({ length: 5 }, (_, r) => Array.from({ length: 60 }, (_, c) => r + c));
    const names = Array.from({ length: 60 }, (_, c) => (c === 0 ? longName : `P${c + 1}`));
    const batch = Array.from({ length: 5 }, (_, r) => `MES-2026092600000${r}-长批次号`);
    act(() => { useData.getState().importMatrix('宽表长名', names, rows, [{ name: '批次号', values: batch, sourceIndex: 1 }]); });
    const { container } = render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    const header = within(grid).getByRole('columnheader', { name: new RegExp(`^列 ${longName}；`) });
    expect(header.getAttribute('title')).toContain(longName);
    const nameSpan = header.querySelector('span > span') as HTMLElement;
    expect(nameSpan.style.textOverflow).toBe('ellipsis');
    expect(nameSpan.style.minWidth).toBe('0px');
    expect(container.querySelector(`td[title="${batch[2]}"]`)).not.toBeNull();
    expect(within(grid).getByRole('columnheader', { name: '批次号' }).getAttribute('title')).toBe('批次号');
  });
});

// ------------------------------------------------------------------ GAP-10-22 壳层
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('GAP-10-22 复审:真实 AppShell 在 20 万行已确认远规格下,无关变化不重算能力', () => {
  it('toast 出现/消失、菜单开合:isCapabilityWarningAcknowledged / computeCapability 零调用,状态栏 Cpk 与能力页同源', () => {
    const random = lcg(20260926);
    const values = Array.from({ length: 200_000 }, () => Math.round((random() - 0.5) * 2e6) / 1e12);
    const spec = { lsl: -1, tgt: 0, usl: 1 };
    act(() => { useData.getState().importMatrix('微位移20万', ['位移'], values.map((value) => [value])); });
    useApp.setState({
      page: 'dashboard', spcDataLayout: 'individuals', spcValueCol: '位移', spcSubgroupCol: null,
      lsl: spec.lsl, tgt: spec.tgt, usl: spec.usl, lslOn: true, uslOn: true,
    });
    const data = useData.getState();
    const prepared = resolveCapabilityMeasurementData(data.model, data.textCols);
    if (!prepared.model) throw new Error(prepared.error);
    const fingerprint = capabilityWarningFingerprint(
      capabilitySpecKey(data.model, data.textCols)!,
      prepared.model.all,
      prepared.model.sigmaWithin,
      spec,
      capabilitySubgroupSemantics(data.model, data.textCols)!,
    );
    if (!fingerprint) throw new Error('夹具未触发远距离规格警告');
    useApp.getState().acknowledgeCapabilityWarning(fingerprint);

    const view = render(<App />);
    const expected = nf(computeCapability(prepared.model.all, prepared.model.sigmaWithin, spec, { allowDistantSpec: true }).cpk, 2);
    expect(view.container.textContent).toContain(`Cpk ${expected}`);

    const actions: Array<[string, () => void]> = [
      ['showToast', () => useApp.getState().showToast('已保存分析')],
      ['toast 清除', () => useApp.setState({ toast: null })],
      ['setOpenMenu', () => useApp.getState().setOpenMenu('file')],
      ['关闭菜单', () => useApp.getState().setOpenMenu(null)],
    ];
    for (const [label, action] of actions) {
      spies.acknowledged = 0;
      spies.computeCapability = 0;
      const started = performance.now();
      act(action);
      const wall = performance.now() - started;
      console.info(`[GAP-10-22 AppShell] ${label} 墙钟 ${wall.toFixed(1)}ms · 指纹 ${spies.acknowledged} 次 · 能力 ${spies.computeCapability} 次`);
      expect(spies.acknowledged).toBe(0);
      expect(spies.computeCapability).toBe(0);
      // 修复前实测 387–482ms/次;这里只兜底防回退,主断言是上面的零调用计数
      expect(wall).toBeLessThan(250);
    }
    expect(view.container.textContent).toContain(`Cpk ${expected}`);

    // 相关变化(改规格)仍重算:确认指纹随规格失效 → 状态栏不再显示已确认口径的 Cpk
    spies.acknowledged = 0;
    act(() => { useApp.setState({ usl: 2 }); });
    expect(spies.acknowledged).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain(`Cpk ${expected}`);
  }, 60_000);
});
