/** @vitest-environment jsdom */
/** 批次716-R2:Codex v1.36 验收确认缺陷的防回归(P0 规格绑定/P2 P图截断/P2 动态文案/P1 列序)。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { useApp } from '../../store/appStore';
import { useData, resolveCapabilityMeasurementData, rememberSpecForCapabilityMeasurement, syncSpecForCapabilityMeasurement, capabilitySpecKey } from '../../store/dataStore';
import {
  capabilityInputError, evalLimitedRules, ruleKDesc, DEFAULT_RULE_K,
  parseMatrix, worksheetDisplayOrder,
} from '../../core';
import { Worksheet } from '../pages/Worksheet';
import { useAnalyses } from '../../store/analyses';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    spcRuleK: { ...DEFAULT_RULE_K },
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
  });
});

/** 量纲悬殊双列:压入力(N 级)与过盈量(mm 级),复现 Codex P0 场景。 */
function importDisparate() {
  useData.getState().importMatrix('压装工序', ['压入力', '过盈量'],
    [[812, 0.055], [905, 0.061], [1010, 0.076], [860, 0.058], [950, 0.068], [880, 0.062]], []);
}

describe('P0:能力规格绑定能力口径', () => {
  it('切换能力测量列后 sync 把规格换成新特性的 μ±4σ 建议,不再沿用旧量纲规格', () => {
    importDisparate();
    // 模拟旧口径规格(压入力量纲)
    useApp.setState({ lsl: 500, tgt: 900, usl: 1400, lslOn: true, uslOn: true });
    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量' });
    const changed = syncSpecForCapabilityMeasurement();
    expect(changed).toBe(true);
    const app = useApp.getState();
    // μ±4σ 建议应落在过盈量量纲(0.0x 级),绝不再是 500~1400
    expect(app.usl).toBeLessThan(1);
    expect(app.lsl).toBeGreaterThan(-1);
    const prepared = resolveCapabilityMeasurementData(useData.getState().model, useData.getState().textCols);
    expect(prepared.error).toBeUndefined();
    expect(capabilityInputError(prepared.model!.all, prepared.model!.sigmaWithin, { lsl: app.lsl, tgt: app.tgt, usl: app.usl })).toBeNull();
  });

  it('该特性有记忆规格时优先恢复记忆,而非重建议', () => {
    importDisparate();
    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量' });
    rememberSpecForCapabilityMeasurement(useData.getState().model, useData.getState().textCols,
      { lsl: 0.045, tgt: 0.0675, usl: 0.09, lslOn: true, uslOn: true });
    useApp.setState({ lsl: 500, tgt: 900, usl: 1400 });
    expect(syncSpecForCapabilityMeasurement()).toBe(true);
    const app = useApp.getState();
    expect(app.lsl).toBe(0.045);
    expect(app.usl).toBe(0.09);
  });

  it('量纲哨兵:规格与数据相距超过 1000σ 时 capabilityInputError 拦截,不再产出虚假 Cpk', () => {
    importDisparate();
    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量' });
    const prepared = resolveCapabilityMeasurementData(useData.getState().model, useData.getState().textCols);
    // 绕过 sync(模拟任何遗漏路径):过盈量数据配压入力规格
    const err = capabilityInputError(prepared.model!.all, prepared.model!.sigmaWithin, { lsl: 500, tgt: 900, usl: 1400 });
    expect(err).toContain('1000 倍标准差');
    // 正常规格不被误拦
    expect(capabilityInputError(prepared.model!.all, prepared.model!.sigmaWithin, { lsl: 0.04, tgt: 0.065, usl: 0.1 })).toBeNull();
  });

  it('能力页编辑规格写能力口径的记忆键,不污染 SPC 测量列的键', () => {
    importDisparate();
    useApp.setState({ spcDataLayout: 'individuals', spcValueCol: '压入力', capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量' });
    rememberSpecForCapabilityMeasurement(useData.getState().model, useData.getState().textCols,
      { lsl: 0.05, tgt: 0.065, usl: 0.08, lslOn: true, uslOn: true });
    const map = JSON.parse(localStorage.getItem('qp-specs-v1') ?? '{}') as Record<string, { usl: number }>;
    const keys = Object.keys(map);
    expect(keys.some((k) => k.includes(encodeURIComponent('过盈量')))).toBe(true);
    expect(keys.some((k) => k.includes(encodeURIComponent('压入力')))).toBe(false);
  });
});

describe('P2:P 图 UCL 截断到 1 时自定义 K1 不误报(Codex 探针)', () => {
  const rules = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
  it('p̄=0.9,n=10:UCL 截断为 1,p=1 在真 2σ 内不应报;真越界仍报', () => {
    const pbar = 0.9;
    const sigma = Math.sqrt(pbar * (1 - pbar) / 10); // 0.0948683
    const ucl = Math.min(1, pbar + 3 * sigma); // 截断为 1
    const lcl = Math.max(0, pbar - 3 * sigma); // 0.6154(未截断,为真 3σ 距)
    // 修复后 σ̂ 取 max(ucl−cl, cl−lcl)/3 = 真 σ;p=1 距中心 0.1 ≈ 1.05σ < 2σ → 不报
    const okSide = evalLimitedRules([1, 1, 1], pbar, ucl, lcl, rules, { ...DEFAULT_RULE_K, k1: 2 });
    expect(okSide.viol.size).toBe(0);
    // 下侧同理:p=0.75(−1.58σ)不报;p=0.6(−3.16σ)超 2σ 应报
    const low = evalLimitedRules([0.75, 0.6], pbar, ucl, lcl, rules, { ...DEFAULT_RULE_K, k1: 2 });
    expect([...low.viol]).toEqual([1]);
  });
});

describe('P2:判异说明文案随 K 动态', () => {
  it('K 非标准时 ruleKDesc 输出实际参数,标准时逐字沿用', () => {
    expect(ruleKDesc(2, { ...DEFAULT_RULE_K, k2: 7 })).toBe('连续 7 点落在中心线同一侧');
    expect(ruleKDesc(2, DEFAULT_RULE_K)).toBe('连续 9 点落在中心线同一侧');
    expect(ruleKDesc(5, { ...DEFAULT_RULE_K, k5: 3 })).toBe('相邻 4 点中有 3 点落在同侧 2σ 区之外');
  });
});

describe('P1:MSA 工作表按导入原列序交错显示', () => {
  it('parseMatrix 记录文本列 sourceIndex(保留列内的原位)', () => {
    const parsed = parseMatrix('部件\t测试人\t螺钉高度\n1\t邹德玉\t10.1\n2\t邹德玉\t10.2\n3\t邹德玉\t10.0');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.colNames).toEqual(['部件', '螺钉高度']);
    expect(parsed.textCols[0].name).toBe('测试人');
    expect(parsed.textCols[0].sourceIndex).toBe(1);
  });

  it('worksheetDisplayOrder 交错还原;缺 sourceIndex 回落数值在前', () => {
    expect(worksheetDisplayOrder(2, [{ name: '测试人', values: [], sourceIndex: 1 }])).toEqual([
      { kind: 'numeric', index: 0 }, { kind: 'text', index: 0 }, { kind: 'numeric', index: 1 },
    ]);
    expect(worksheetDisplayOrder(2, [{ name: '测试人', values: [] }])).toEqual([
      { kind: 'numeric', index: 0 }, { kind: 'numeric', index: 1 }, { kind: 'text', index: 0 },
    ]);
    // 后加的数值列(超出原位信息)排在数值序尾部
    expect(worksheetDisplayOrder(3, [{ name: 'T', values: [], sourceIndex: 0 }])).toEqual([
      { kind: 'text', index: 0 }, { kind: 'numeric', index: 0 }, { kind: 'numeric', index: 1 }, { kind: 'numeric', index: 2 },
    ]);
  });

  it('工作表按 部件/测试人/螺钉高度 原序渲染表头,行号槽无标题(716-R3 P1-1 收口)', () => {
    const parsed = parseMatrix('部件\t测试人\t螺钉高度\n1\t邹德玉\t10.1\n2\t邹德玉\t10.2\n3\t邹德玉\t10.0');
    if ('error' in parsed) throw new Error(parsed.error);
    useData.getState().importMatrix('工厂GRR', parsed.colNames, parsed.rows, parsed.textCols);
    const html = render(createElement(Worksheet)).container.innerHTML;
    const iPart = html.indexOf('部件');
    const iOp = html.indexOf('测试人');
    const iHeight = html.indexOf('螺钉高度');
    expect(iPart).toBeGreaterThan(-1);
    expect(iPart).toBeLessThan(iOp);
    expect(iOp).toBeLessThan(iHeight);
    // 716-R3 P1-1(人工审核 PPT 10 页):重复的 ID/行 数据列已删除,行号槽为 Minitab 式无标题;
    // 原断言「显示>行</th>」随该收口作废,行式子组口径的「子组」语义由行号槽表头承载。
    expect(html).not.toContain('>行</th>');
    expect(html).not.toContain('>子组</th>');
  });
});

// ================= 对抗自查(wf_3ca15ddc)确认缺陷的防回归 =================
import { textReport } from '../../platform/report';
import { Capability } from '../pages/Capability';

describe('自查F1:Box-Cox 变换域触发哨兵只跳过补充卡,不炸整页', () => {
  it('重右偏数据 + 近零 LSL:能力页正常渲染主结果,无未捕获异常', () => {
    // 指数间隔的强右偏正数据(AD 必拒绝正态,bestLambda 为负):负 λ 会把 LSL=1e-6 映射成巨值
    const vals = [0.5, 0.55, 0.6, 0.62, 0.65, 0.7, 0.72, 0.75, 0.8, 0.9, 1.1, 1.5, 2.5, 4, 7, 12, 20, 35, 60, 100];
    useData.getState().importMatrix('右偏', ['厚度'], vals.map((v) => [v]), []);
    useApp.setState({ spcDataLayout: 'individuals', spcValueCol: '厚度', lsl: 1e-6, tgt: 50, usl: 300, lslOn: true, uslOn: true });
    const { container } = render(createElement(Capability, { T: { name: '经典', classic: true, bg: '#fff', grid: 'transparent', frame: '#c4c9d0', axis: '#262626', text: '#1a1a1a', center: '#000', limit: '#d21f26', limitDash: undefined, point: '#2A4B8D', line: '#2A4B8D', spec: '#c026a6', bar: '#7FA0C4', bar2: '#5b9bd5', bar3: '#a9c9ec', curve: '#d21f26', curve2: '#c026a6', sw: 1.6, r: 3.4, dash: '5 4' } }));
    // 主结果与规格编辑器都在(页面没有被 ErrorBoundary 吞掉)
    expect(container.innerHTML).toContain('规格限');
    expect(container.innerHTML).toContain('Cpk');
  });
});

describe('自查F2:legacy 导出在哨兵状态下能力章节写「未运行」,不整份失败', () => {
  it('textReport 规格量纲误配 → 不抛异常,含未运行说明,其余章节仍在', () => {
    useData.getState().importMatrix('螺钉', ['高度'], [[10.1], [10.2], [10.0], [10.15], [10.05], [10.12]], []);
    const M = useData.getState().model;
    const text = textReport(M, { lsl: 500, tgt: 900, usl: 1400 });
    expect(text).toContain('能力分析未运行');
    expect(text).toContain('1000 倍标准差');
    expect(text).toContain('SPC');
  });

  it('仅 R 图失控时通用报告先报变异未受控，不再同时写「过程受控」', () => {
    const rows = Array.from({ length: 24 }, () => [9, 11]);
    rows.push([0, 20]);
    useData.getState().importMatrix('R-only.csv', ['x1', 'x2'], rows, []);
    const text = textReport(useData.getState().model, { lsl: 0, tgt: 10, usl: 20 });
    expect(text).toMatch(/R 图检出 \d+ 个异常点，过程变异尚未受控/);
    expect(text).not.toContain('未检出失控点，过程受控');
  });

  it('仅 MR 图存在模式异常时也不会把 I 图无异常写成整体受控', () => {
    const values: number[] = Array.from({ length: 25 }, (_, index) => index % 2 === 0 ? -1 : 1);
    values[10] = -3.5;
    values[11] = 3.5;
    useData.getState().importMatrix('MR-only.csv', ['位移'], values.map((value) => [value]), []);
    const text = textReport(useData.getState().model, { lsl: -10, tgt: 0, usl: 10 });
    expect(text).toMatch(/MR 图检出 \d+ 个异常点，过程变异尚未受控/);
    expect(text).toContain('暂不解释 I 图');
    expect(text).not.toContain('未检出失控点，过程受控');
  });
});

describe('自查F3:删除数值列后文本列相对显示序不漂移', () => {
  it('[高度,测试人,直径] 删「高度」→ 显示序仍是 测试人 在 直径 前', () => {
    const parsed = parseMatrix('高度\t测试人\t直径\n10.1\t张\t5.1\n10.2\t李\t5.2\n10.0\t王\t5.0');
    if ('error' in parsed) throw new Error(parsed.error);
    useData.getState().importMatrix('三列', parsed.colNames, parsed.rows, parsed.textCols);
    useData.getState().deleteColumn(0);
    const d = useData.getState();
    expect(d.model.colNames).toEqual(['直径']);
    expect(worksheetDisplayOrder(1, d.textCols)).toEqual([
      { kind: 'text', index: 0 }, { kind: 'numeric', index: 0 },
    ]);
  });
});

describe('自查F4:历史回放不丢 sourceIndex', () => {
  it('保存→切数据集→回放,textCols.sourceIndex 保留,列序不回落', async () => {
    const parsed = parseMatrix('部件\t测试人\t螺钉高度\n1\t邹\t10.1\n2\t邹\t10.2\n3\t邹\t10.0');
    if ('error' in parsed) throw new Error(parsed.error);
    useData.getState().importMatrix('装配', parsed.colNames, parsed.rows, parsed.textCols);
    useApp.setState({ page: 'capability', spcDataLayout: 'individuals', spcValueCol: '螺钉高度' });
    useAnalyses.getState().saveCurrent();
    const saved = useAnalyses.getState().saved[0];
    useData.getState().importMatrix('别的', ['x'], [[1], [2], [3]], []);
    await useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe('装配');
    expect(useData.getState().textCols[0].sourceIndex).toBe(1);
  });
});

describe('自查F5:口径零变化的点击不冲掉当前规格;legacy 数据集名记忆兼容', () => {
  it('重复点击当前模式(键不变)→ 规格保持;capabilitySpecKey 前后一致', () => {
    importDisparate();
    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量' });
    const d = useData.getState();
    const key1 = capabilitySpecKey(d.model, d.textCols);
    // 该特性记忆一份与当前不同的规格,模拟回放快照后的分叉状态
    rememberSpecForCapabilityMeasurement(d.model, d.textCols, { lsl: 0.05, tgt: 0.065, usl: 0.08, lslOn: true, uslOn: true });
    useApp.setState({ lsl: 0.052, tgt: 0.066, usl: 0.081 }); // 快照规格
    useApp.getState().setCapabilitySubgroup({ capSubgroupMode: 'const' }); // 零变化补丁
    const key2 = capabilitySpecKey(useData.getState().model, useData.getState().textCols);
    expect(key2).toBe(key1); // 键不变 → 页面 updateSubgroup 不会调 sync,快照规格不被冲
    expect(useApp.getState().usl).toBe(0.081);
  });

  it('spc 默认口径下 sync 兼容读取 legacy(按数据集名)记忆', () => {
    useData.getState().importMatrix('旧件', ['孔径'], [[8.01], [8.02], [7.99], [8.0], [8.03], [7.98]], []);
    useApp.setState({ capSubgroupMode: 'spc', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, lsl: 0, tgt: 1, usl: 2 });
    localStorage.setItem('qp-specs-v1', JSON.stringify({ 旧件: { lsl: 7.9, tgt: 8.0, usl: 8.1 } }));
    expect(syncSpecForCapabilityMeasurement()).toBe(true);
    expect(useApp.getState().usl).toBe(8.1); // 用 legacy 记忆,而非 μ±4σ 建议
  });
});

describe('自查F6:非行式口径下行操作文案统一为「行」', () => {
  it('删行按钮 aria-label 与添加按钮均显示「行」', () => {
    const parsed = parseMatrix('部件\t测试人\t螺钉高度\n1\t邹\t10.1\n2\t邹\t10.2\n3\t邹\t10.0');
    if ('error' in parsed) throw new Error(parsed.error);
    useData.getState().importMatrix('工厂GRR2', parsed.colNames, parsed.rows, parsed.textCols);
    const html = render(createElement(Worksheet)).container.innerHTML;
    expect(html).toContain('删除行 1');
    expect(html).toContain('＋ 行');
    expect(html).not.toContain('删除子组');
  });
});
