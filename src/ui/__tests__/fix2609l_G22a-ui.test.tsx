/**
 * 2026-09 全面审查第 6 批 G22a-ui:各修复组自报的跨组小尾巴(界面/文档部分)。
 * (2)  帮助中心「撤销/重做」不再写死「20 层」,改为内存预算 + 菜单显示实际步数;
 * (3)  Ctrl+Z/Ctrl+Y 在项目导出快照期间被拒绝(fix2609m A2,不再排队),toast 如实写「请稍后重试」;
 * (4)  错误卡「恢复演示数据集并重试」在替换闸门拒绝时给出可读提示,不再抛出未捕获异常;
 * (5)  DOE 两水平/分数因子低高水平、MSA 过程公差、能力规格限/子组大小、SPC 判异 K 值改为
 *      type=text + 严格解析 + 可见原因;
 * (7)  总览判异有界通道的口径核对:有界 total(展开口径)≠ 总览现用的触发点条数,本批未切换、待拍板;
 * (10/11) README/帮助补:桌面关窗确认、数据集库损坏自动保全、AQL 账本记录链一致性核对;
 * (12) 导入未持久化提示与选项页「释放空间」口径统一;
 * (13) 清除本地数据后显式 bumpFishboneRevision;侧栏项目名输入框 maxLength;
 * (14) 页面统计卡片与报告层 reportNum 同源(小量级数据不再显示 0.0000)。
 * 全部走真实组件 / 真实 store / 真实生产函数;只模拟存储配额与本机库。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { platform, type DatasetDb, type DatasetSnapshot } from '../../platform/adapter';
import { buildProjectJsonFull } from '../../platform/project';
import { reportNum } from '../../platform/reportLabels';
import { useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, settlePendingDatasetWrites, useData } from '../../store/dataStore';
import {
  DEFAULT_RULES, DEFAULT_RULE_K, evalRules, evaluateSpcChartRules, expandSpcRuleItems, prepareSpcData,
} from '../../core';
import { ErrorBoundary, recoverDemoDataset } from '../ErrorBoundary';
import { HelpModal } from '../shell/HelpModal';
import { SideNav } from '../shell/SideNav';
import { Modals } from '../shell/Modals';
import { LOCAL_SPACE_RELEASE_HINT } from '../shell/OptionsModal';
import { GageRR } from '../pages/SimplePages';
import { Capability } from '../pages/Capability';
import { Spc } from '../pages/Spc';
import { Summary } from '../pages/Summary';
import { Doe } from '../pages/Doe';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);
/** 与 Dashboard.tsx 的 DASHBOARD_ALERT_ROWS 相同(总览告警区渲染条数)。 */
const DASHBOARD_ALERT_ROWS = 8;
const readme = readFileSync('README.md', 'utf8');
const nativeSetItem = Storage.prototype.setItem;

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

function snapshotDb(snapshot: Promise<DatasetSnapshot>): DatasetDb & { readSnapshot: ReturnType<typeof vi.fn> } {
  return {
    async put() {},
    async insert() { return true; },
    async get() { return null; },
    async list() { return []; },
    async remove() { return false; },
    async clear(opId) { return { opId, committed: true, removed: 0 }; },
    async clearStatus() { return null; },
    async stats() { return { count: 0, total_bytes: 0, path: ':memory:' }; },
    readSnapshot: vi.fn(() => snapshot),
  };
}

/** 最近列表写入超过 limit 字符即配额失败(构造替换闸门的真实触发条件)。 */
function failLargeRecents(limit: number) {
  Storage.prototype.setItem = function quota(key: string, value: string) {
    if (key === 'qp-recents-v1' && value.length > limit) throw new DOMException('quota', 'QuotaExceededError');
    return nativeSetItem.call(this, key, value);
  };
}

/** KvRows / 统计表行:按标签取同一行的值文本。 */
function rowValue(root: HTMLElement, label: string): string {
  const cell = within(root).getAllByText(label, { selector: 'span' }).find((el) => el.nextElementSibling?.tagName === 'SPAN');
  expect(cell, `缺少「${label}」行`).toBeDefined();
  return cell!.nextElementSibling!.textContent ?? '';
}

beforeEach(() => {
  cleanup();
  platform.datasetDb = null;
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    modal: null, openMenu: null, toast: null, busyOverlay: null, page: 'dashboard',
    spcRuleK: { ...DEFAULT_RULE_K }, spcRules: { ...DEFAULT_RULES }, spcType: 'xbar-r', spcStageCol: null,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcSigmaMethod: 'classic',
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
  });
});

afterEach(async () => {
  cleanup();
  Storage.prototype.setItem = nativeSetItem;
  cancelPendingDatasetWork();
  await settlePendingDatasetWrites();
  platform.datasetDb = null;
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ (2)(10)(11) 帮助 / README
describe('(2)(10)(11) 帮助中心与 README 的说明与实际行为一致', () => {
  it('(2) 撤销/重做不再写死「20 层」:按内存预算,菜单显示实际可撤销步数', () => {
    render(<HelpModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '数据操作' }));
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('20 层');
    expect(text).toContain('按内存预算');
    expect(text).toContain('菜单显示实际可撤销步数');
  });

  it('(10) 帮助与 README 说明桌面端关窗确认与数据集库损坏自动保全', () => {
    render(<HelpModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '数据集库(本机)' }));
    const help = document.body.textContent ?? '';
    for (const text of [help, readme]) {
      expect(text).toMatch(/关窗.*Cmd\+Q.*未持久化.*确认/);
      expect(text).toContain('datasets.db.corrupt-<时间戳>');
      expect(text).toContain('空库继续');
    }
  });

  it('(11) 帮助与 README 说明 AQL 账本具备记录链一致性核对(不是防篡改签名)', () => {
    render(<HelpModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '抽样检验 AQL' }));
    const help = document.body.textContent ?? '';
    for (const text of [help, readme]) {
      expect(text).toContain('记录链一致性核对');
      expect(text).toContain('不是防篡改签名');
    }
  });

  it('(5) README「手工数值输入」不再把已改造的参数框列为已知限制', () => {
    const line = readme.split('\n').find((l) => l.startsWith('- **手工数值输入**'));
    expect(line).toBeDefined();
    for (const entry of ['DOE 两水平全因子/分数因子的低/高水平', 'MSA 过程公差', '能力分析的规格限与子组大小', 'SPC 判异准则 K 值']) {
      expect(line).toContain(entry);
    }
    expect(line).not.toMatch(/已知限制：DOE 两水平全因子\/分数因子的低\/高水平、MSA 过程公差/);
  });
});

// ------------------------------------------------------------------ (3) Ctrl+Z 在导出期间被拒绝
describe('(3) 项目导出快照期间 Ctrl+Z / Ctrl+Y 的提示', () => {
  it('快照期间撤销被拒绝(fix2609m A2,不再暂存):toast 写「请稍后重试」而不是「已撤销」/「已暂存」;快照完成后不重放', async () => {
    useData.getState().importMatrix('录入表.csv', ['x', 'y'], [[1, 2], [3, 4], [5, 6]]);
    useData.getState().updateCell(0, 0, 42);
    const snapshot = deferred<DatasetSnapshot>();
    const db = snapshotDb(snapshot.promise);
    platform.datasetDb = db;
    useApp.setState({ page: 'worksheet' });
    render(<App />);
    const exporting = buildProjectJsonFull('1.43.0');
    for (let i = 0; i < 50 && db.readSnapshot.mock.calls.length === 0; i++) await Promise.resolve();
    expect(db.readSnapshot).toHaveBeenCalled();

    const seen: Array<string | null> = [];
    try {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      seen.push(useApp.getState().toast);
    } finally {
      snapshot.resolve({ revision: 1, datasets: [] });
      await exporting;
      await Promise.resolve();
    }
    expect(seen[0]).toMatch(/撤销未执行.*请稍后重试/);
    expect(seen[0]).not.toContain('已撤销上一次数据编辑');
    expect(seen[0]).not.toContain('已暂存');
    // 被拒绝的撤销不排队，快照完成后编辑仍在
    expect(useData.getState().model.subs[0].vals[0]).toBe(42);

    // 无导出时照常提示已撤销/已重做
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(useApp.getState().toast).toBe('已撤销上一次数据编辑');
    expect(useData.getState().model.subs[0].vals[0]).toBe(1);
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(useApp.getState().toast).toBe('已重做数据编辑');
  });
});

// ------------------------------------------------------------------ (4) 错误卡恢复演示数据集
describe('(4) 错误卡「恢复演示数据集并重试」遇替换闸门拒绝', () => {
  const bigRows = Array.from({ length: 400 }, (_, i) => [i + 0.123456, i * 2 + 0.654321]);
  function Bomb(): never { throw new Error('页面渲染炸了'); }

  it('闸门抛错时不再抛出未捕获异常,错误卡就地显示可读原因,数据集保持不变', () => {
    failLargeRecents(5000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows);
    expect(useData.getState().recentsUnpersisted).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    let thrown: unknown = null;
    try {
      fireEvent.click(screen.getByRole('button', { name: '恢复演示数据集并重试' }));
    } catch (error) { thrown = error; }
    expect(thrown).toBeNull();
    const alert = screen.getAllByRole('alert').find((el) => el.textContent?.includes('未能恢复演示数据集'));
    expect(alert?.textContent).toContain('最近数据集列表尚未保存');
    expect(useData.getState().model.name).toBe('大表.csv');
  });

  it('壳层错误卡共用的 recoverDemoDataset:成功返回 null,闸门拒绝返回原因', () => {
    failLargeRecents(5000);
    useData.getState().importMatrix('大表.csv', ['x', 'y'], bigRows);
    const blocked = recoverDemoDataset();
    expect(blocked).toContain('未能恢复演示数据集');
    expect(blocked).toContain('最近数据集列表尚未保存');
    Storage.prototype.setItem = nativeSetItem;
    expect(recoverDemoDataset()).toBeNull();
    expect(useData.getState().model.isDemo).toBe(true);
  });
});

// ------------------------------------------------------------------ (5) 参数框严格解析
describe('(5) 参数框改为 type=text + 严格解析 + 可见原因', () => {
  it('DOE 两水平全因子低/高水平:「12.5mm」被拒并说明原因,千分位「1,000.5」按提示读入', () => {
    useApp.setState({ page: 'doe', doeTab: 'create' });
    const before = useData.getState().model.name;
    render(<App />);
    const low = screen.getByLabelText('两水平全因子因子 1 低水平') as HTMLInputElement;
    const high = screen.getByLabelText('两水平全因子因子 1 高水平') as HTMLInputElement;
    expect(low.type).toBe('text');
    expect(high.type).toBe('text');

    fireEvent.change(low, { target: { value: '12.5mm' } });
    expect(low.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('含单位或多余字符'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
    expect(useApp.getState().toast).toMatch(/因子「过盈量」低水平无效：「12\.5mm」含单位或多余字符/);
    expect(useData.getState().model.name).toBe(before);

    fireEvent.change(low, { target: { value: '0.04' } });
    fireEvent.change(high, { target: { value: '1,000.5' } });
    expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('已按千分位读作 1000.5'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
    const model = useData.getState().model;
    expect(model.name).toMatch(/^DOE设计_/);
    const factorCol = model.colNames.indexOf('过盈量');
    expect(model.subs.some((s) => s.vals[factorCol] === 1000.5)).toBe(true);
    expect(model.subs.some((s) => s.vals[factorCol] === 0.04)).toBe(true);
  });

  it('DOE 分数因子页共用同一低/高水平输入(type=text)', () => {
    useApp.setState({ page: 'doe', doeTab: 'create' });
    render(<Doe T={T} />);
    fireEvent.click(screen.getByRole('button', { name: '分数因子 2^(k−p)' }));
    const low = screen.getByLabelText('分数因子因子 3 低水平') as HTMLInputElement;
    expect(low.type).toBe('text');
    fireEvent.change(low, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
    expect(useApp.getState().toast).toContain('因子「因子C」低水平无效：未填写');
  });

  it('MSA 过程公差:非法串保留并显示原因,store 仍按上一次有效值;清空写 null', () => {
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
    expect(input.type).toBe('text');
    fireEvent.change(input, { target: { value: '0.5mm' } });
    expect(useApp.getState().gageTolValue).toBe(1);
    expect(input.value).toBe('0.5mm');
    const alert = screen.getAllByRole('alert').find((el) => el.textContent?.includes('过程公差数值无效'));
    expect(alert?.textContent).toContain('未修改，仍按编辑前的值 1'); // fix2609m G23c C1 措辞
    fireEvent.change(input, { target: { value: '0.4' } });
    expect(useApp.getState().gageTolValue).toBe(0.4);
    fireEvent.change(input, { target: { value: '' } });
    expect(useApp.getState().gageTolValue).toBeNull();
  });

  it('能力规格限:「24.9mm」「1e999」被拒并显示原因;子组大小「3.6」不再被四舍五入成 4', () => {
    const random = lcg(11);
    const rows = Array.from({ length: 25 }, () => Array.from({ length: 5 }, () => Math.round((25 + (random() - 0.5) * 0.06) * 10000) / 10000));
    useData.getState().importMatrix('能力.csv', ['C1', 'C2', 'C3', 'C4', 'C5'], rows);
    useApp.setState({ page: 'capability', lsl: 24.9, tgt: 25, usl: 25.1, lslOn: true, uslOn: true, spcDataLayout: 'rows' });
    render(<Capability T={T} />);
    const lsl = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    expect(lsl.type).toBe('text');
    fireEvent.change(lsl, { target: { value: '24.9mm' } });
    expect(useApp.getState().lsl).toBe(24.9);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('LSL 下限无效'))).toBe(true);
    fireEvent.change(lsl, { target: { value: '1e999' } });
    expect(useApp.getState().lsl).toBe(24.9);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('超出可表示的数值范围'))).toBe(true);
    fireEvent.change(lsl, { target: { value: '24.85' } });
    expect(useApp.getState().lsl).toBe(24.85);

    act(() => { useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 5 }); });
    const size = screen.getByLabelText('子组大小') as HTMLInputElement;
    expect(size.type).toBe('text');
    fireEvent.change(size, { target: { value: '3.6' } });
    fireEvent.blur(size);
    expect(useApp.getState().capSubgroupSize).toBe(5);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('不是整数'))).toBe(true);
    fireEvent.change(size, { target: { value: '11' } });
    fireEvent.blur(size);
    expect(useApp.getState().capSubgroupSize).toBe(5);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('超出允许范围 2–10'))).toBe(true);
    fireEvent.change(size, { target: { value: '４' } }); // 全角数字归一
    fireEvent.blur(size);
    expect(useApp.getState().capSubgroupSize).toBe(4);
  });

  it('SPC 判异 K 值:越界/非整数不再静默回落标准值,保留当前 K 并显示原因', () => {
    useApp.setState({ page: 'spc', spcRuleK: { ...DEFAULT_RULE_K, k2: 7 } });
    render(<Spc T={T} />);
    const k2 = screen.getByLabelText(/准则 2 参数 K2/) as HTMLInputElement;
    expect(k2.type).toBe('text');
    fireEvent.change(k2, { target: { value: '50' } });
    fireEvent.blur(k2);
    // 修复前:normalizeRuleK 把越界值静默回落为标准值 9,用户以为设了 50
    expect(useApp.getState().spcRuleK.k2).toBe(7);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('超出 [2, 30] 范围'))).toBe(true);
    fireEvent.change(k2, { target: { value: '8.5' } });
    fireEvent.blur(k2);
    expect(useApp.getState().spcRuleK.k2).toBe(7);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('K2 必须是整数'))).toBe(true);
    fireEvent.change(k2, { target: { value: '8' } });
    fireEvent.blur(k2);
    expect(useApp.getState().spcRuleK.k2).toBe(8);

    const k1 = screen.getByLabelText(/准则 1 参数 K1/) as HTMLInputElement;
    fireEvent.change(k1, { target: { value: '2.5σ' } });
    fireEvent.blur(k1);
    expect(useApp.getState().spcRuleK.k1).toBe(3);
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('含单位或多余字符'))).toBe(true);
    fireEvent.change(k1, { target: { value: '2.5' } });
    fireEvent.keyDown(k1, { key: 'Enter' });
    fireEvent.blur(k1);
    expect(useApp.getState().spcRuleK.k1).toBe(2.5);
  });
});

// ------------------------------------------------------------------ (7) 总览有界判异(待拍板,未改)
describe('(7) 总览判异有界通道:口径核对(G8b 自报前置条件)', () => {
  /** 极差恒为 1(二进制精确)、均值在 10/12 间阶跃:R 图无判异,X̄ 图大量判异。 */
  function stepRows(): number[][] {
    return Array.from({ length: 60 }, (_, i) => [-0.5, -0.25, 0, 0.25, 0.5].map((d) => (i < 30 ? 10 : 12) + d));
  }

  it('有界统计 total 是「展开到实际标红点」的条数,不等于总览现用的窗口触发点条数 list.length——切换会改变告警计数', () => {
    useData.getState().importMatrix('阶跃.csv', ['C1', 'C2', 'C3', 'C4', 'C5'], stepRows());
    const SM = prepareSpcData(useData.getState().model, [], { layout: 'rows', valueColumn: null, subgroupColumn: null }).model!;
    const rules = { ...DEFAULT_RULES, r2: true };
    const full = evaluateSpcChartRules(SM, rules, DEFAULT_RULE_K, 'xbar-r', true, null);
    const expanded = expandSpcRuleItems(full.location.viol, full.location.list, 'X̄', DEFAULT_RULE_K);
    const bounded = evalRules(SM.subs.map((sg) => sg.mean), SM.xbarbar, (SM.uclX - SM.xbarbar) / 3, rules, DEFAULT_RULE_K,
      { pointRuleDetailLimit: DASHBOARD_ALERT_ROWS });
    // 有界通道与 SPC 页明细(展开口径)一致
    expect(bounded.pointRuleSummary!.total).toBe(expanded.length);
    // 但与总览当前的告警计数口径(窗口触发点)不同:准则 2 的 9 点窗口只记 1 条触发
    expect(bounded.pointRuleSummary!.total).toBeGreaterThan(full.location.list.length);
    // 总览页现状:告警计数仍按触发点口径(本批未改,待拍板)
    useApp.setState({ page: 'dashboard', spcDataLayout: 'rows', spcRules: rules });
    const view = render(<App />);
    const value = within(view.container).getByText('未处理告警').parentElement!.querySelector('.mono')!.textContent;
    expect(value).toBe(String(full.dispersion.list.length || full.location.list.length));
  });
});

// ------------------------------------------------------------------ (12) 释放空间口径
describe('(12) 导入未持久化提示与选项页「释放空间」口径统一', () => {
  it('导入写不进浏览器存储时,提示给出移除最近数据集/已保存分析释放空间的出路(与选项页同一文案)', async () => {
    Storage.prototype.setItem = function quota(key: string, value: string) {
      if (key === 'qp-recents-v1' || key === 'qp-dataset-v1') throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    };
    render(<Modals />);
    act(() => useApp.setState({ modal: 'import', importTab: 'clip', importKind: 'var' }));
    fireEvent.change(screen.getByRole('dialog').querySelector('textarea')!, { target: { value: '值\n1\n2\n3' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const toast = useApp.getState().toast ?? '';
    expect(toast).toContain('尚未持久化');
    expect(toast).toContain(LOCAL_SPACE_RELEASE_HINT);
    expect(LOCAL_SPACE_RELEASE_HINT).toMatch(/最近数据集.*已保存分析.*释放/);
  });

  it('选项页常驻说明含同一释放空间出路', () => {
    useApp.setState({ modal: 'options' });
    render(<Modals />);
    expect(document.body.textContent).toContain(LOCAL_SPACE_RELEASE_HINT);
  });
});

// ------------------------------------------------------------------ (13) 鱼骨图刷新 / 项目名上限
describe('(13) 清库后显式刷新鱼骨图;侧栏项目名输入框限长', () => {
  it('清除本地数据成功后 fishboneRevision 递增(不依赖遮罩时序)', async () => {
    platform.datasetDb = snapshotDb(Promise.resolve({ revision: 1, datasets: [] }));
    useApp.setState({ modal: 'options', fishboneRevision: 0 });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '清除数据并恢复演示' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认彻底清除' }));
    await waitFor(() => expect(useApp.getState().toast).toContain('已恢复演示数据集'));
    expect(useApp.getState().fishboneRevision).toBeGreaterThan(0);
  });

  it('侧栏项目名编辑框 maxLength=120', () => {
    render(<SideNav />);
    const button = screen.getByTitle(/双击重命名项目/);
    fireEvent.doubleClick(button);
    const input = document.querySelector('.side-nav-project input') as HTMLInputElement;
    expect(input.maxLength).toBe(120);
  });
});

// ------------------------------------------------------------------ (14) 页面统计卡与 reportNum 同源
describe('(14) 页面统计卡与报告层 reportNum 同源', () => {
  /** SI 单位电容数据:4.7 nF 量级,σ≈几 pF。 */
  function importTinyScale() {
    const random = lcg(5);
    const rows = Array.from({ length: 25 }, () => Array.from({ length: 5 }, () => 4.7e-9 + (random() - 0.5) * 6e-11));
    useData.getState().importMatrix('电容.csv', ['C1', 'C2', 'C3', 'C4', 'C5'], rows);
    useApp.setState({ lsl: 4.5e-9, tgt: 4.7e-9, usl: 4.9e-9, lslOn: true, uslOn: true, spcDataLayout: 'rows' });
    return rows;
  }

  it('能力页「详细统计」:均值/σ 不再显示 0.0000,与 reportNum 同一口径', () => {
    const rows = importTinyScale();
    const all = rows.flat();
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    useApp.setState({ page: 'capability' });
    const view = render(<Capability T={T} />);
    const shown = rowValue(view.container, '样本均值 X̄');
    expect(shown).not.toBe('0.0000');
    expect(shown).toMatch(/e-9$/);
    expect(Number(shown)).toBeCloseTo(mean, 11);
    expect(rowValue(view.container, 'σ 整体')).toMatch(/e-11$/);
  });

  it('描述性统计页:均值/标准差按 reportNum 显示', () => {
    const rows = importTinyScale();
    useApp.setState({ page: 'summary', activeVar: 'C1' });
    const view = render(<Summary T={T} />);
    const col = rows.map((r) => r[0]);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    expect(rowValue(view.container, '均值')).toBe(reportNum(mean, 3));
    expect(rowValue(view.container, '标准差')).toMatch(/e-11$/);
  });

  it('SPC 页统计卡:σ̂ 按 reportNum 显示', () => {
    importTinyScale();
    useApp.setState({ page: 'spc', spcType: 'xbar-r' });
    const view = render(<Spc T={T} />);
    const sigma = rowValue(view.container, 'σ̂ (R̄/d₂)');
    expect(sigma).not.toBe('0.0000');
    expect(sigma).toMatch(/e-11$/);
  });

  it('DOE 效应与系数:小量级响应显示有效数字;常规量级的浮点噪声按 0 显示', () => {
    useData.getState().importMatrix('DOE微量', ['A', 'B', 'Y'], [
      [-1, -1, 1.0e-6], [1, -1, 1.2e-6], [-1, 1, 1.1e-6], [1, 1, 1.5e-6],
      [-1, -1, 1.02e-6], [1, -1, 1.21e-6], [-1, 1, 1.08e-6], [1, 1, 1.52e-6],
    ]);
    useApp.setState({ page: 'doe', doeTab: 'analyze', doeView: 'main', doeFactorCols: ['A', 'B'], doeRespCol: 'Y' });
    const view = render(<Doe T={T} />);
    const table = [...view.container.querySelectorAll('table')].find((t) => t.textContent?.includes('效应') && t.textContent?.includes('系数'))!;
    const effectCells = [...table.querySelectorAll('tbody tr')].map((tr) => tr.children[1].textContent);
    expect(effectCells.length).toBeGreaterThan(0);
    expect(effectCells.some((text) => text === '0.000')).toBe(false);
    expect(effectCells.every((text) => /e-7$|e-8$|e-9$/.test(text ?? ''))).toBe(true);
  });
});
