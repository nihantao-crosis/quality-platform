/**
 * fix2609l · G22b-core(第 6 批跨组小尾巴)。全部走真实生产函数 / 真实组件 / 真实 store。
 * (1)  鱼骨图写入失败仅在内存时纳入离开拦截(registerUnpersistedStateProbe);
 * (6)  跨窗口 AQL 账本提示「N 条批次记录」只数批次;
 * (5/Aql) AQL 页批量 N、不合格品数改 type=text + 严格整数解析 + 可见原因;解除暂停写转移记录;
 * (11) 记录链审计 legacy 时，AQL 页与 AQL 专项报告展示 notes;
 * (13) projectName 长度上限(setProjectName / 水合截断 / 校验硬上限);
 * (14) 通用 Excel 数据 sheet 均值/极差与统计摘要均值/σ 带数字格式;axisScale 亚 ulp 跨度按常数展开;
 *      DOE 报告 Adj SS/MS/F、t、标准化残差不再印浮点噪声。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessSpcCharts, DEFAULT_RULE_K, freshSwitchStatus, isAqlBatchRecord, isAqlTransitionRecord, recordInspection,
  setSwitchConditions, type SwitchStatus,
} from '../../core';
import { buildActiveAnalysisExport } from '../../platform/activeAnalysisReport';
import { MAX_PROJECT_NAME_CHARS, projectStoreValidationError } from '../../platform/project';
import { buildXlsx } from '../../platform/xlsxExport';
import { AQL_STATE_STORAGE_KEY, DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, unpersistedStateLabels, useData } from '../../store/dataStore';
import { clearFishboneState, cloneFishbone, FISHBONE_DEFAULT, FISHBONE_STORAGE_KEY, saveFishboneState } from '../../store/fishboneStore';
import { coordinateDomain, createPowerOfTwoAxis, niceCoordinateTicks } from '../charts/axisScale';
import { Aql } from '../pages/Aql';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 2) + (clock += 60_000)).toISOString();
const batch = (status: SwitchStatus, nonconforming: number, batchId: string) => recordInspection(status, {
  lot: 1000, level: 'II', aql: 1.0, regime: 'percent', nonconforming, batchId, inspector: '检验员甲', inspectedAt: at(),
});
function suspendedStatus(): SwitchStatus {
  let status = batch(batch(freshSwitchStatus(), 5, 'B1'), 5, 'B2');
  for (let i = 1; i <= 5; i += 1) status = batch(status, 5, `R${i}`);
  expect(status.suspended).toBe(true);
  return status;
}
/** v1.42 形态旧账本:正常 10 批接收(得分 30)→ 人工转放宽，但账本里没有转移记录 → 审计 legacy。 */
function legacyReducedStatus(): SwitchStatus {
  let status = freshSwitchStatus();
  for (let i = 1; i <= 10; i += 1) status = batch(status, 0, `N${i}`);
  status = setSwitchConditions(status, { productionSteady: true, reducedApproved: true }, { operator: '主管', at: at() });
  expect(status.state).toBe('reduced');
  return { ...status, records: status.records.filter(isAqlBatchRecord) };
}
const aqlBase = { aqlLot: 1000, aqlLevel: 'II' as const, aqlAQL: 1.0, aqlRegime: 'percent' as const };

beforeEach(() => {
  cleanup();
  cancelPendingDatasetWork();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard', modal: null, toast: null, openMenu: null, doeTab: 'analyze', aqlLedgerFault: null,
    ...aqlBase, aqlSwitch: freshSwitchStatus(),
    spcType: 'xbar-r', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcRules: { ...DEFAULT_SPC_RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearFishboneState();
});

describe('(1) STORE-10 残余:鱼骨图纳入离开拦截', () => {
  it('鱼骨图写 localStorage 失败只留在内存时，unpersistedStateLabels 含「鱼骨图」;清除后撤销', () => {
    const native = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === FISHBONE_STORAGE_KEY) throw new DOMException('quota', 'QuotaExceededError');
      return native.call(this, key, value);
    });
    const data = cloneFishbone(FISHBONE_DEFAULT);
    data.problem = '孔径超差';
    expect(() => saveFishboneState(data, false)).toThrow();
    expect(unpersistedStateLabels()).toContain('鱼骨图');
    clearFishboneState();
    expect(unpersistedStateLabels()).not.toContain('鱼骨图');
  });
});

describe('(6) 跨窗口 AQL 账本提示只数批次', () => {
  it('另一窗口写入含状态转移记录的账本 → 提示「10 条批次记录、1 条状态转移记录」', () => {
    const resumed = setSwitchConditions(
      (() => { let s = freshSwitchStatus(); for (let i = 1; i <= 10; i += 1) s = batch(s, 0, `N${i}`); return s; })(),
      { productionSteady: true, reducedApproved: true }, { operator: '主管', at: at() },
    );
    expect(resumed.records.filter(isAqlTransitionRecord)).toHaveLength(1);
    const value = JSON.stringify({ ...aqlBase, aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: resumed });
    const oldValue = localStorage.getItem(AQL_STATE_STORAGE_KEY);
    localStorage.setItem(AQL_STATE_STORAGE_KEY, value);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: AQL_STATE_STORAGE_KEY, oldValue, newValue: value, storageArea: localStorage }));
    });
    expect(useApp.getState().aqlSwitch.records).toHaveLength(11);
    // 修复前:「11 条批次记录」(把转移条目算成批次)
    expect(useApp.getState().toast).toBe('另一窗口更新了 AQL 责任账本（10 条批次记录、1 条状态转移记录），已同步到本窗口');
  });
});

describe('(Aql 参数框) type=text + 严格整数解析 + 可见原因', () => {
  it('不合格品数:「1,000」「3件」给出原因并禁止提交;全角「０」按 0 接受', () => {
    render(<Aql T={T} />);
    const input = screen.getByLabelText('实际不合格品数') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(screen.getByLabelText('批次号'), { target: { value: 'LOT-1' } });
    fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检' } });
    const submit = screen.getByRole('button', { name: '记录本批并执行转移判定' });

    fireEvent.change(input, { target: { value: '3件' } });
    expect(screen.getByText(/「3件」含单位或多余字符「件」/)).toBeTruthy();
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { value: '1,000' } });
    expect(screen.getByText(/「1,000」含逗号/)).toBeTruthy();
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: '０' } });
    expect(screen.queryByText(/含逗号|多余字符/)).toBeNull();
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    expect(useApp.getState().aqlSwitch.records[0]).toMatchObject({ batchId: 'LOT-1', nonconforming: 0, decision: 'accepted' });
  });

  it('批量 N:「12.5件」显示原因且沿用旧批量;「3,200.0」按千分位接受', () => {
    render(<Aql T={T} />);
    const lot = screen.getByLabelText('批量 N') as HTMLInputElement;
    expect(lot.getAttribute('type')).toBe('text');
    fireEvent.focus(lot);
    fireEvent.change(lot, { target: { value: '12.5件' } });
    expect(screen.getByText(/「12\.5件」含单位或多余字符.*当前仍使用 1,000/)).toBeTruthy();
    expect(useApp.getState().aqlLot).toBe(1000);
    fireEvent.change(lot, { target: { value: '3,200.0' } });
    expect(useApp.getState().aqlLot).toBe(3200);
  });
});

describe('(6/14 UI) 解除暂停写入责任账本', () => {
  it('暂停面板填写确认人后恢复加严 → 追加 resume-tightened 转移记录(操作人=确认人)', () => {
    useApp.setState({ aqlSwitch: suspendedStatus() });
    render(<Aql T={T} />);
    fireEvent.change(screen.getByLabelText('恢复加严确认人'), { target: { value: '质量主管' } });
    fireEvent.click(screen.getByRole('button', { name: '已确认纠正有效，恢复加严检验' }));
    const sw = useApp.getState().aqlSwitch;
    expect(sw).toMatchObject({ state: 'tightened', suspended: false });
    const last = sw.records[sw.records.length - 1];
    expect(last).toMatchObject({ kind: 'transition', action: 'resume-tightened', inspector: '质量主管' });
  });
});

describe('(11) 记录链审计 legacy notes 展示', () => {
  it('AQL 页常驻提示 legacy notes', () => {
    useApp.setState({ aqlSwitch: legacyReducedStatus() });
    render(<Aql T={T} />);
    const note = screen.getByRole('note', { name: '责任账本记录链核对' });
    expect(note.textContent).toMatch(/历史账本未含转移记录：1 处人工状态转移/);
  });

  it('AQL 专项报告 warnings 披露 legacy notes;记录链完整时不出现', () => {
    useApp.setState({ page: 'aql', aqlSwitch: legacyReducedStatus() });
    const legacy = buildActiveAnalysisExport().report!;
    expect(legacy.kind).toBe('aql');
    expect(legacy.warnings.join('\n')).toMatch(/责任账本记录链核对（旧账本兼容）：历史账本未含转移记录：1 处人工状态转移/);
    useApp.setState({ aqlSwitch: batch(freshSwitchStatus(), 0, 'OK-1') });
    expect(buildActiveAnalysisExport().report!.warnings.join('\n')).not.toMatch(/记录链核对/);
  });
});

describe('(13) projectName 长度上限', () => {
  it('setProjectName 截到上限且不留半个代理对', () => {
    expect(MAX_PROJECT_NAME_CHARS).toBe(120);
    useApp.getState().setProjectName(`  ${'项'.repeat(300)}  `);
    expect(useApp.getState().projectName).toBe('项'.repeat(120));
    useApp.getState().setProjectName(`a${'😀'.repeat(100)}`);
    const name = useApp.getState().projectName;
    expect(name.length).toBeLessThanOrEqual(120);
    expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
  });

  it('水合:旧版超长项目名截断后接受;超过硬上限的载荷按损坏拒绝', async () => {
    const long = '旧'.repeat(300);
    expect(projectStoreValidationError('qp-prefs-v1', { version: 3, state: { projectName: long } })).toBeNull();
    expect(projectStoreValidationError('qp-prefs-v1', { version: 3, state: { projectName: 'x'.repeat(5000) } }))
      .toMatch(/projectName 过长/);
    localStorage.setItem('qp-prefs-v1', JSON.stringify({ version: 3, state: { projectName: long } }));
    await useApp.persist.rehydrate();
    expect(useApp.getState().projectName).toBe('旧'.repeat(120));
  });
});

describe('(14) 通用 Excel 数值格式 / 坐标轴 / DOE 浮点噪声', () => {
  function workbookFor(scale: number) {
    const rows = Array.from({ length: 20 }, (_, g) => Array.from({ length: 5 }, (_, j) => (4.7 + (((g * 7 + j * 3) % 11) - 5) * 0.01) * scale));
    useData.getState().importMatrix('小量级.csv', ['m1', 'm2', 'm3', 'm4', 'm5'], rows);
    const { model, capabilityModel } = buildActiveAnalysisExport();
    const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');
    const bytes = buildXlsx(model, { lsl: 4.5 * scale, tgt: 4.7 * scale, usl: 4.9 * scale }, assessment, undefined, capabilityModel);
    return { model, workbook: XLSX.read(bytes, { type: 'array', cellNF: true }) };
  }

  it('数据 sheet 子组均值/极差与统计摘要均值/σ 带数字格式(常规定点、小量级指数),值仍是原始 double', () => {
    const { model, workbook } = workbookFor(1);
    const data = workbook.Sheets['数据'];
    const header = XLSX.utils.sheet_to_json<string[]>(data, { header: 1 })[0];
    const meanCol = XLSX.utils.encode_col(header.indexOf('均值'));
    const rangeCol = XLSX.utils.encode_col(header.indexOf('极差'));
    expect(data[`${meanCol}2`].z).toBe('0.0000');
    expect(data[`${meanCol}2`].v).toBe(model.subs[0].mean);
    expect(data[`${rangeCol}2`].z).toBe('0.0000');
    const summary = XLSX.utils.sheet_to_json<Array<string | number>>(workbook.Sheets['统计摘要'], { header: 1 });
    const meanRow = summary.findIndex((row) => row[0] === '能力口径均值');
    expect(workbook.Sheets['统计摘要'][`B${meanRow + 1}`].z).toBe('0.00000');

    const tiny = workbookFor(1e-9);
    const tinyMean = tiny.workbook.Sheets['数据'][`${meanCol}2`];
    expect(tinyMean.z).toBe('0.000E+00');
    expect(tinyMean.v).toBe(tiny.model.subs[0].mean);
  });

  it('coordinateDomain:1 ulp 跨度按常数序列展开(与 niceTicks 守卫同口径),刻度可读', () => {
    const values = [0.1, 0.10000000000000002];
    const axis = createPowerOfTwoAxis(values);
    const domain = coordinateDomain(axis, values, { padding: 0.05, constantRelative: 0.1 });
    // 修复前:[0.1, 0.10000000000000002](1 ulp 宽)
    expect(domain[1] - domain[0]).toBeGreaterThan(1e-3);
    expect(domain[0]).toBeLessThan(0.1);
    expect(domain[1]).toBeGreaterThan(0.10000000000000002);
    // 刻度是圆整值,不再是两个只差 1 ulp 的端点
    expect(niceCoordinateTicks(axis, domain).map((tick) => tick.value)).toEqual([0, 1]);
    // 常规非常数序列不受影响
    const ordinary = coordinateDomain(createPowerOfTwoAxis([1, 2]), [1, 2], { padding: 0.05 });
    expect(ordinary).toEqual([0.95, 2.05]);
  });

  const lcg = (seed: number) => { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; };
  const noiseCells = () => {
    const { report } = buildActiveAnalysisExport();
    return report!.tables.flatMap((table) => table.rows.flatMap((row) => row.map(String))).filter((cell) => /e-1\d/.test(cell));
  };

  it('一般全因子:完全可加数据的 A×B Adj SS/MS/F 不印成 1e-17 量级科学计数', () => {
    const rand = lcg(8);
    const rows: number[][] = [];
    for (const a of [1, 2, 3]) for (const b of [1, 2]) {
      const base = Number((0.1 * a + 0.7 * b).toFixed(1));
      const d = Number((rand() * 0.3).toFixed(1));
      rows.push([a, b, base + d], [a, b, base - d]);
    }
    useData.getState().importMatrix('一般全因子.csv', ['A', 'B', 'Y'], rows);
    useApp.setState({ page: 'doe', doeTab: 'analyze', doeFactorCols: ['A', 'B'], doeRespCol: 'Y' });
    expect(noiseCells()).toEqual([]);
    const anova = buildActiveAnalysisExport().report!.tables[0];
    const ab = anova.rows.find((row) => row[0] === 'A×B')!;
    expect(ab.slice(2, 5)).toEqual(['0.0000', '0.0000', '0.00']);
  });

  it('两水平全因子:零交互效应的 t 与标准化残差不印成 1e-15 量级科学计数', () => {
    const rand = lcg(1);
    const rows: number[][] = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const y = 10.1 + 0.3 * a + 0.7 * b;
      const d = Number((rand() * 0.3).toFixed(1));
      rows.push([a, b, Number((y + d).toFixed(1))], [a, b, Number((y - d).toFixed(1))]);
    }
    useData.getState().importMatrix('两水平.csv', ['A', 'B', 'Y'], rows);
    useApp.setState({ page: 'doe', doeTab: 'analyze', doeFactorCols: ['A', 'B'], doeRespCol: 'Y' });
    expect(noiseCells()).toEqual([]);
    const coef = buildActiveAnalysisExport().report!.tables.find((table) => table.title === '效应与系数')!;
    expect(coef.rows.find((row) => row[0] === 'A×B')![3]).toBe('0.0000');
  });
});
