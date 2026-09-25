/** @vitest-environment jsdom */
/**
 * 2026-09 全面审查第 4 批 · G14-capability:2b+1d 对抗复审报出的能力页与回看提示收口。
 * (1) GAP-10-22-final:能力页 useApp() 全量订阅、指纹/computeCapability/AD/Box-Cox 未记忆化——
 *     20 万行停在能力页时每次 toast/菜单开合 0.5–1.1s。复现:真实 <App/>、page=capability。
 * (2) GAP-10-22-final:能力页 prepared 的 useMemo 依赖缺 spcDataLayout/spcValueCol/spcSubgroupCol/
 *     pendingCells——直接改 SPC 角色或「重置界面偏好」后页面仍按旧测量列,状态栏已切换。
 * (3) CORE-01-docs:回看口径提示只比较 metric/status——v1.42 auto 下 X̄-R、现回落 I-MR 的记录
 *     摘要同为「过程受控」时不提示,列表 title 仍写 X̄-R。
 * (4) CORE-01-docs:README 称「段长不等或 n 越界时 auto 改按 I-MR」,与 HEAD 不符;段长不等报错
 *     缺少处理办法。
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  computeCapability: 0, andersonDarling: 0, bestLambda: 0, fingerprint: 0, resolveCapability: 0,
}));

vi.mock('../../core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core')>();
  return {
    ...actual,
    computeCapability: (...args: Parameters<typeof actual.computeCapability>) => {
      spies.computeCapability += 1;
      return actual.computeCapability(...args);
    },
    andersonDarling: (...args: Parameters<typeof actual.andersonDarling>) => {
      spies.andersonDarling += 1;
      return actual.andersonDarling(...args);
    },
    bestLambda: (...args: Parameters<typeof actual.bestLambda>) => {
      spies.bestLambda += 1;
      return actual.bestLambda(...args);
    },
    capabilityWarningFingerprint: (...args: Parameters<typeof actual.capabilityWarningFingerprint>) => {
      spies.fingerprint += 1;
      return actual.capabilityWarningFingerprint(...args);
    },
  };
});
vi.mock('../../store/dataStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/dataStore')>();
  return {
    ...actual,
    resolveCapabilityMeasurementData: (...args: Parameters<typeof actual.resolveCapabilityMeasurementData>) => {
      spies.resolveCapability += 1;
      return actual.resolveCapabilityMeasurementData(...args);
    },
  };
});

import App from '../../App';
import { capabilityWarningFingerprint, computeCapability, DEFAULT_RULE_K, nf, prepareSpcData } from '../../core';
import { platform } from '../../platform/adapter';
import { useAnalyses, type SavedAnalysis } from '../../store/analyses';
import { DEFAULT_SPC_RULES, resetUiPreferences, useApp } from '../../store/appStore';
import {
  cancelPendingDatasetWork, capabilitySpecKey, capabilitySubgroupSemantics, resolveCapabilityMeasurementData, useData,
} from '../../store/dataStore';
import { Capability } from '../pages/Capability';
import { HelpModal } from '../shell/HelpModal';
import { chartTokens } from '../tokens';
import { CAPABILITY_ROLE_FIELDS } from '../useCapabilityPrepared';

const readme = readFileSync('README.md', 'utf8');

beforeEach(() => {
  cancelPendingDatasetWork();
  platform.datasetDb = null;
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'worksheet', modal: null, busyOverlay: null, toast: null, openMenu: null, varOpen: false, selSub: null,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcType: 'xbar-r', spcRules: { ...DEFAULT_SPC_RULES }, spcShowZones: true,
    spcRuleK: { ...DEFAULT_RULE_K }, capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null, capabilityBins: 13,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cancelPendingDatasetWork();
});

function resetSpies() {
  for (const key of Object.keys(spies) as Array<keyof typeof spies>) spies[key] = 0;
}

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const UNRELATED: Array<[string, () => void]> = [
  ['showToast', () => useApp.getState().showToast('已保存分析')],
  ['toast 清除', () => useApp.setState({ toast: null })],
  ['setOpenMenu', () => useApp.getState().setOpenMenu('file')],
  ['关闭菜单', () => useApp.getState().setOpenMenu(null)],
  ['varOpen 开', () => useApp.getState().setVarOpen(true)],
  ['varOpen 关', () => useApp.getState().setVarOpen(false)],
];

function expectNoRecompute(label: string, action: () => void, wallBudgetMs: number | null) {
  resetSpies();
  const started = performance.now();
  act(action);
  const wall = performance.now() - started;
  console.info(`[G14 能力页] ${label} 墙钟 ${wall.toFixed(1)}ms · ${JSON.stringify(spies)}`);
  expect(spies, label).toEqual({ computeCapability: 0, andersonDarling: 0, bestLambda: 0, fingerprint: 0, resolveCapability: 0 });
  // 复审实测修复前 477–1126ms/次;主断言是上面的零调用计数,墙钟只兜底防回退
  if (wallBudgetMs != null) expect(wall, label).toBeLessThan(wallBudgetMs);
}

// ------------------------------------------------------------------ (1) 20 万行零重算
describe('(1) GAP-10-22-final:真实 <App/> 停在能力页、20 万行,无关变化零重算', () => {
  it('非正态正值数据(走 AD + Box-Cox 链路):toast/菜单/变量面板零调用;组数滑块只重绘直方图;改规格照常重算', () => {
    const random = lcg(20260926);
    // 右偏正值(指数型):AD 判非正态 → Box-Cox 补充卡被计算
    const values = Array.from({ length: 200_000 }, () => Math.round((1 + -Math.log(1 - random() * 0.999)) * 1000) / 1000);
    act(() => { useData.getState().importMatrix('右偏20万', ['厚度'], values.map((value) => [value])); });
    useApp.setState({
      page: 'capability', spcDataLayout: 'individuals', spcValueCol: '厚度', spcSubgroupCol: null,
      lsl: 0.5, tgt: 2, usl: 8, lslOn: true, uslOn: true,
    });
    resetSpies();
    const view = render(<App />);
    // 前提:页面确实跑了能力 + AD + Box-Cox(否则本用例不构成复现)
    expect(spies.computeCapability).toBeGreaterThan(0);
    expect(spies.bestLambda).toBeGreaterThan(0);
    expect(view.container.textContent).toContain('非正态能力 · Box-Cox 变换');
    const before = view.container.textContent;

    for (const [label, action] of UNRELATED) expectNoRecompute(label, action, 250);
    // 组数滑块:页面重绘直方图,但能力/AD/Box-Cox 不重算
    expectNoRecompute('组数滑块', () => useApp.getState().setCapabilityBins(21), null);
    expect(view.container.textContent).toContain('组数 21');
    act(() => { useApp.getState().setCapabilityBins(13); });
    expect(view.container.textContent).toBe(before);

    // 相关变化(改规格)仍重算
    resetSpies();
    act(() => { useApp.setState({ usl: 9 }); });
    expect(spies.computeCapability).toBeGreaterThan(0);
    view.unmount();
  }, 120_000);

  it('已确认 1000σ 远规格(走确认指纹链路):toast/菜单零调用,页面 Cpk 与壳层同源;改规格后确认失效', () => {
    const random = lcg(20260927);
    const values = Array.from({ length: 200_000 }, () => Math.round((random() - 0.5) * 2e6) / 1e12);
    const spec = { lsl: -1, tgt: 0, usl: 1 };
    act(() => { useData.getState().importMatrix('微位移20万', ['位移'], values.map((value) => [value])); });
    useApp.setState({
      page: 'capability', spcDataLayout: 'individuals', spcValueCol: '位移', spcSubgroupCol: null,
      lsl: spec.lsl, tgt: spec.tgt, usl: spec.usl, lslOn: true, uslOn: true,
    });
    const data = useData.getState();
    const prepared = resolveCapabilityMeasurementData(data.model, data.textCols);
    if (!prepared.model) throw new Error(prepared.error);
    const fingerprint = capabilityWarningFingerprint(
      capabilitySpecKey(data.model, data.textCols)!, prepared.model.all, prepared.model.sigmaWithin, spec,
      capabilitySubgroupSemantics(data.model, data.textCols)!,
    );
    if (!fingerprint) throw new Error('夹具未触发远距离规格警告');
    useApp.getState().acknowledgeCapabilityWarning(fingerprint);

    const view = render(<App />);
    const expected = nf(computeCapability(prepared.model.all, prepared.model.sigmaWithin, spec, { allowDistantSpec: true }).cpk, 2);
    expect(view.container.textContent).toContain('已显式确认超 1000σ 规格');
    expect(view.container.textContent).toContain(`Cpk ${expected}`);

    for (const [label, action] of UNRELATED) expectNoRecompute(label, action, 250);
    expect(view.container.textContent).toContain('已显式确认超 1000σ 规格');

    resetSpies();
    act(() => { useApp.setState({ usl: 2 }); });
    expect(spies.fingerprint).toBeGreaterThan(0);
    expect(view.container.textContent).toContain('过程能力分析未运行（等待确认）');
    view.unmount();
  }, 120_000);
});

// ------------------------------------------------------------------ (2) prepared 依赖齐全
function effectiveNote(root: HTMLElement): string {
  return /当前生效:测量列「[^」]*」/.exec(root.textContent ?? '')?.[0] ?? '(无)';
}

describe('(2) 能力页 prepared 随 SPC 角色/pendingCells 失效,与全新挂载一致', () => {
  const T = chartTokens('经典', true);
  function setup() {
    const random = lcg(7);
    const rows = Array.from({ length: 40 }, () => [
      Math.round((10 + random()) * 1000) / 1000,
      Math.round((20 + 3 * random()) * 1000) / 1000,
    ]);
    act(() => { useData.getState().importMatrix('双列', ['A', 'B'], rows); });
    useApp.setState({
      page: 'capability', spcDataLayout: 'individuals', spcValueCol: 'B', spcSubgroupCol: null,
      capSubgroupMode: 'spc', lsl: 0, tgt: 15, usl: 30, lslOn: true, uslOn: true,
    });
  }
  function freshText(): { note: string; text: string } {
    const fresh = render(<Capability T={T} />);
    const out = { note: effectiveNote(fresh.container), text: fresh.container.textContent ?? '' };
    fresh.unmount();
    return out;
  }

  it('停在能力页直接改 spcValueCol(不经 SPC 页):测量列与能力数据口径切换到 A', () => {
    setup();
    const live = render(<Capability T={T} />);
    expect(effectiveNote(live.container)).toBe('当前生效:测量列「B」');
    act(() => { useApp.setState({ spcValueCol: 'A' }); });
    // 修复前:页面仍显示「B」的分析
    expect(effectiveNote(live.container)).toBe('当前生效:测量列「A」');
    expect(live.container.textContent).toBe(freshText().text);
  });

  it('「选项 → 重置界面偏好」(resetUiPreferences)后与全新挂载一致(角色待配置)', () => {
    setup();
    const live = render(<Capability T={T} />);
    expect(live.container.textContent).toContain('能力评估');
    act(() => { resetUiPreferences(); });
    const fresh = freshText();
    expect(fresh.text).toContain('过程能力分析未运行');
    expect(live.container.textContent).toBe(fresh.text);
  });

  it('改 spcDataLayout / spcSubgroupCol 也失效(与壳层依赖清单一致)', () => {
    setup();
    const live = render(<Capability T={T} />);
    act(() => { useApp.setState({ spcDataLayout: 'rows', spcValueCol: null }); });
    expect(live.container.textContent).toBe(freshText().text);
    act(() => { useApp.setState({ spcDataLayout: 'individuals', spcValueCol: 'A', spcSubgroupCol: 'numeric:B' }); });
    expect(live.container.textContent).toBe(freshText().text);
  });

  it('CAPABILITY_ROLE_FIELDS 覆盖 resolveCapabilityMeasurementData 从 app store 读取的全部字段(三种子组模式)', () => {
    setup();
    const real = useApp.getState;
    const read = new Set<string>();
    vi.spyOn(useApp, 'getState').mockImplementation(() => new Proxy(real(), {
      get(target, key, receiver) {
        if (typeof key === 'string') read.add(key);
        return Reflect.get(target, key, receiver);
      },
    }));
    const { model, textCols } = useData.getState();
    for (const patch of [
      { capSubgroupMode: 'spc' as const },
      { capSubgroupMode: 'const' as const, capValueCol: 'A', capSubgroupSize: 4 },
      { capSubgroupMode: 'stacked' as const, capValueCol: 'A', capSubgroupIdCol: 'B' },
    ]) {
      useApp.setState(patch);
      resolveCapabilityMeasurementData(model, textCols);
    }
    vi.restoreAllMocks();
    expect(read.size).toBeGreaterThan(0);
    const fields = new Set<string>(CAPABILITY_ROLE_FIELDS);
    expect([...read].filter((key) => !fields.has(key))).toEqual([]);
  });
});

// ------------------------------------------------------------------ (3) 回看比较 title
describe('(3) 回看:严格轮换强 ID,摘要相同、图型不同也提示', () => {
  it('v1.42 auto 下 X̄-R「过程受控」、现回落 I-MR「过程受控」→ 提示带图型变化;列表 title 不改写', async () => {
    const batches = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3];
    const values = [9.8, 10.1, 10.0, 10.2, 9.9, 10.1, 10.0, 10.2, 9.8, 10.1, 10.0, 10.2];
    useData.getState().importMatrix('轮换批次', ['批次', '测量值'], batches.map((b, i) => [b, values[i]]));
    useApp.setState({ page: 'spc', spcDataLayout: 'auto', spcType: 'xbar-r', lsl: 9, tgt: 10, usl: 11 });
    // 前提:现在按新口径回落 I-MR,且角色说明带 CORE-01 口径说明
    const now = prepareSpcData(useData.getState().model, useData.getState().textCols, {
      layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: [],
    });
    expect(now.layout).toBe('individuals');
    expect(now.note).toContain('口径说明');
    const fresh = useAnalyses.getState().saveCurrent()!;
    expect(fresh.title).toBe('I-MR 控制图');

    // v1.42 口径:同号批次按值合并 → k=3、n=4 的 X̄-R
    const merged = [1, 2, 3].map((b) => batches.flatMap((x, i) => (x === b ? [values[i]] : [])));
    useData.getState().importMatrix('v1.42合并口径', ['测量1', '测量2', '测量3', '测量4'], merged);
    useApp.setState({ spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null });
    const old = useAnalyses.getState().saveCurrent()!;
    expect(old.title).toBe('X̄-R 控制图');
    // 复审场景:摘要相同(同为受控),只有图型不同
    expect([old.metric, old.status]).toEqual([fresh.metric, fresh.status]);

    const legacy: SavedAnalysis = { ...fresh, id: 'v142-rotation', title: old.title, metric: old.metric, status: old.status };
    useAnalyses.setState({ saved: [legacy], lastError: null });
    useApp.setState({ toast: null });
    await expect(useAnalyses.getState().restore(legacy.id)).resolves.toBe(true);
    const toast = useApp.getState().toast ?? '';
    // 修复前:toast 为 null(只比较 metric/status)
    expect(toast).toContain('口径已更新');
    expect(toast).toContain('图型「X̄-R 控制图 → I-MR 控制图」');
    expect(toast).toContain('「批次」');
    expect(toast).toContain('值一变即开新子组');
    expect(toast).toContain('保存时的图型与摘要');
    expect(useAnalyses.getState().saved[0]).toMatchObject({ title: 'X̄-R 控制图', metric: fresh.metric });
  });

  it('title/metric/status 全同(新版保存的记录)时仍不打扰', async () => {
    const batches = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3];
    useData.getState().importMatrix('轮换批次', ['批次', '测量值'], batches.map((b, i) => [b, 10 + (i % 5) / 10]));
    useApp.setState({ page: 'spc', spcDataLayout: 'auto' });
    const fresh = useAnalyses.getState().saveCurrent()!;
    useAnalyses.setState({ saved: [fresh], lastError: null });
    useApp.setState({ toast: null });
    await expect(useAnalyses.getState().restore(fresh.id)).resolves.toBe(true);
    expect(useApp.getState().toast ?? '').not.toContain('口径已更新');
  });
});

// ------------------------------------------------------------------ (4) README 与报错如实
describe('(4) 段长不等:auto 与显式堆叠同报错并附处理办法;README/帮助如实', () => {
  const BATCH = [1, 1, 2, 1, 2, 2, 3, 3, 4, 3, 4, 4];
  const VALUES = BATCH.map((_, i) => 10 + ((i * 7) % 5) / 10);

  it('强 ID「批次」1,1,2,1,2,2,3,3,4,3,4,4:auto 返回 layout=null 并报组内样本量不一致 + 排序/唯一 ID 建议', () => {
    useData.getState().importMatrix('段长不等', ['批次', '测量值'], BATCH.map((b, i) => [b, VALUES[i]]));
    const { model, textCols } = useData.getState();
    for (const selection of [
      { layout: 'auto' as const, valueColumn: null, subgroupColumn: null },
      { layout: 'stacked' as const, valueColumn: '测量值', subgroupColumn: 'numeric:批次' },
    ]) {
      const prepared = prepareSpcData(model, textCols, { ...selection, pendingCells: [] });
      expect(prepared.model, selection.layout).toBeNull();
      expect(prepared.error).toContain('组内样本量不一致');
      // 修复前:报错只有「需等大小子组」,没有处理办法
      expect(prepared.error).toMatch(/按采集时间\/子组排序/);
      expect(prepared.error).toContain('日期-子组');
      expect(prepared.error).toContain('单值列：I-MR');
    }
  });

  it('兜底标签列(表中唯一文本列)同形态:auto 同样报错并附建议,不回落 I-MR', () => {
    const ops = BATCH.map((b) => `甲${b}`);
    useData.getState().importMatrix('文本兜底', ['测量值'], VALUES.map((v) => [v]), [{ name: '标记', values: ops, sourceIndex: 0 }]);
    const { model, textCols } = useData.getState();
    const prepared = prepareSpcData(model, textCols, { layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: [] });
    expect(prepared.model).toBeNull();
    expect(prepared.error).toContain('组内样本量不一致');
    expect(prepared.error).toContain('日期-子组');
  });

  it('ID 从不相邻重复(严格轮换):auto 回落 I-MR;显式堆叠报「从不相邻出现」并附处理办法', () => {
    const rotation = [1, 2, 3, 1, 2, 3, 1, 2, 3];
    useData.getState().importMatrix('轮换', ['批次', '测量值'], rotation.map((b, i) => [b, 10 + i / 10]));
    const { model, textCols } = useData.getState();
    const auto = prepareSpcData(model, textCols, { layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: [] });
    expect(auto.layout).toBe('individuals');
    const stacked = prepareSpcData(model, textCols, { layout: 'stacked', valueColumn: '测量值', subgroupColumn: 'numeric:批次', pendingCells: [] });
    expect(stacked.error).toContain('从不相邻出现');
    expect(stacked.error).toContain('日期-子组');
  });

  it('段长相同但 n 越界(n=12)也附处理办法', () => {
    const ids = [...Array(12).fill(1), ...Array(12).fill(2)];
    useData.getState().importMatrix('n越界', ['批次', '测量值'], ids.map((b, i) => [b, 10 + (i % 7) / 10]));
    const { model, textCols } = useData.getState();
    const prepared = prepareSpcData(model, textCols, { layout: 'stacked', valueColumn: '测量值', subgroupColumn: 'numeric:批次', pendingCells: [] });
    expect(prepared.error).toContain('n=12');
    expect(prepared.error).toContain('单值列：I-MR');
  });

  it('README CORE-01「自动识别的图型」如实区分两种情况,不再称段长不等时 auto 回落 I-MR', () => {
    const line = readme.split('\n').find((l) => l.startsWith('- **自动识别的图型**'));
    expect(line).toBeDefined();
    // 修复前的错误表述
    expect(line).not.toMatch(/各段大小不等或 n 不在 2–10，自动模式不再把该列当作子组，改按单值 I-MR/);
    expect(line).not.toContain('已知限制');
    expect(line).toMatch(/没有任何相邻重复.*改按单值 I-MR/);
    expect(line).toMatch(/有相邻重复，但各段大小不等或段大小 n 不在 2–10.*自动模式与显式「堆叠」都会报「组内样本量不一致」或 n 越界，\*\*不会\*\*回落 I-MR/);
    expect(line).toContain('1,1,2,1,2,2,3,3,4,3,4,4');
    expect(line).toMatch(/强 ID 列与自动兜底选中的标签列.*都一样/);
    expect(line).toContain('日期-子组');
    const records = readme.split('\n').find((l) => l.startsWith('- **旧报告与旧记录**'));
    expect(records).toContain('图型「X̄-R 控制图 → I-MR 控制图」');
  });

  it('帮助中心「数据操作」同步说明:段长不等时不回落 I-MR(渲染真实 HelpModal)', () => {
    render(<HelpModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '数据操作' }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/ID 从不相邻重复[^。]*单值 I-MR/);
    expect(text).toMatch(/各段大小不等[^。]*组内样本量不一致[^。]*不回落 I-MR/);
  });
});
