/** @vitest-environment jsdom */
/** 批次716-R1 对抗审查修复的防回归:能力子组口径快照/元数据列防线/K 值贯通报告。 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useApp } from '../../store/appStore';
import { useData, resolveCapabilityMeasurementData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { countCapabilityViolations, computeVarModel, DEFAULT_RULE_K, prepareSpcData, evalLimitedRules } from '../../core';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null, spcRuleK: { ...DEFAULT_RULE_K } });
});

describe('能力子组口径进快照(审查缺陷 S1)', () => {
  it('const 模式保存记录→改页面配置→恢复,capSubgroup* 随记录还原', async () => {
    useApp.setState({ page: 'capability', capSubgroupMode: 'const', capSubgroupSize: 4, capValueCol: '直径1' });
    useAnalyses.getState().saveCurrent();
    const saved = useAnalyses.getState().saved[0];
    expect(saved.snapshot.capSubgroupMode).toBe('const');
    expect(saved.snapshot.capSubgroupSize).toBe(4);
    expect(saved.snapshot.capValueCol).toBe('直径1');

    useApp.setState({ capSubgroupMode: 'stacked', capSubgroupSize: 9, capValueCol: null });
    await useAnalyses.getState().restore(saved.id);
    const app = useApp.getState();
    expect(app.capSubgroupMode).toBe('const');
    expect(app.capSubgroupSize).toBe(4);
    expect(app.capValueCol).toBe('直径1');
  });

  it('旧记录无 capSubgroup 字段 → 回放回落「沿用 SPC 角色」,不继承当前页面', async () => {
    useApp.setState({ page: 'capability' });
    useAnalyses.getState().saveCurrent();
    const saved = useAnalyses.getState().saved[0];
    // 模拟 v1.35 及以前的旧快照
    const legacy = { ...saved, snapshot: { ...saved.snapshot } };
    delete legacy.snapshot.capSubgroupMode;
    delete legacy.snapshot.capSubgroupSize;
    delete legacy.snapshot.capValueCol;
    delete legacy.snapshot.capSubgroupIdCol;
    useAnalyses.setState({ saved: [legacy] });

    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 3, capValueCol: '直径1' });
    await useAnalyses.getState().restore(legacy.id);
    const app = useApp.getState();
    expect(app.capSubgroupMode).toBe('spc');
    expect(app.capSubgroupSize).toBe(5);
    expect(app.capValueCol).toBeNull();
  });
});

describe('const 模式测量列防线(审查缺陷 S3)', () => {
  it('设计元数据列(标准序)不能作为能力测量值', () => {
    useData.getState().importMatrix('DOE表', ['标准序', '响应'], [[1, 10], [2, 11], [3, 9], [4, 12], [5, 10], [6, 11]], []);
    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '标准序' });
    const prepared = resolveCapabilityMeasurementData(useData.getState().model, useData.getState().textCols);
    expect(prepared.model).toBeNull();
    expect(prepared.error).toContain('设计元数据或分析输出列');
  });

  it('未选测量列且无 SPC 测量列 → 明确报错,不静默取第一列', () => {
    useData.getState().importMatrix('DOE表', ['标准序', '响应'], [[1, 10], [2, 11], [3, 9], [4, 12]], []);
    useApp.setState({ capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: null, spcValueCol: null });
    const prepared = resolveCapabilityMeasurementData(useData.getState().model, useData.getState().textCols);
    expect(prepared.model).toBeNull();
    expect(prepared.error).toContain('请先选择测量列');
  });
});

describe('stacked 子组 ID 解析(审查缺陷 S2)', () => {
  it('裸列名按列名回落解析;显式选择不存在的列则报错而非静默换列', () => {
    useData.getState().importMatrix(
      '长表', ['测量值', '批次'], [[10, 7], [11, 7], [9, 7], [20, 8], [19, 8], [21, 8]],
      [{ name: '班次', values: ['A', 'A', 'A', 'B', 'B', 'B'] }],
    );
    const d = useData.getState();
    // 裸文本列名可解析(历史/程序化调用兼容)
    const byName = prepareSpcData(d.model, d.textCols, { layout: 'stacked', valueColumn: '测量值', subgroupColumn: '班次', pendingCells: [] });
    expect(byName.error).toBeUndefined();
    expect(byName.model?.k).toBe(2);
    // 明确指定不存在的列必须报错,不能静默回落到强 ID 列「批次」
    const missing = prepareSpcData(d.model, d.textCols, { layout: 'stacked', valueColumn: '测量值', subgroupColumn: 'text:不存在', pendingCells: [] });
    expect(missing.error).toContain('不存在');
  });
});

describe('evalLimitedRules k1≠3 在钳位 LCL 图上的 σ̂(审查缺陷 C1)', () => {
  it('MR 型图(LCL=0)k1=2 时下侧不因 (cl−lcl)/3 低估 σ 而误报;上侧检测正常', () => {
    const rules = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
    // MR̄=1.128(σ=1),UCL=D4·MR̄≈3.685,LCL 钳位 0;真实 2σ 下界为负,下侧不可能越界
    const low = evalLimitedRules([0.3, 0.25, 0.35], 1.128, 3.685, 0, rules, { ...DEFAULT_RULE_K, k1: 2 });
    expect(low.viol.size).toBe(0);
    // 上侧 σ̂=(3.685−1.128)/3≈0.852,v=3.0 距中心 1.872 > 2σ̂≈1.705 → 应检出
    const high = evalLimitedRules([3.0], 1.128, 3.685, 0, rules, { ...DEFAULT_RULE_K, k1: 2 });
    expect(high.viol.size).toBe(1);
    // k1=3 默认路径仍按真实非对称限逐位判断(0.3 不越 LCL=0)
    const std = evalLimitedRules([0.3, 3.9], 1.128, 3.685, 0, rules);
    expect([...std.viol]).toEqual([1]);
  });
});

describe('countCapabilityViolations 接 K 值(审查缺陷 S5)', () => {
  it('k1 收紧后能力口径失控计数随之变化', () => {
    // 单值序列:一点在 2.5σ 附近(默认 3σ 不判,k1=2 判)
    const base = [10, 10.1, 9.9, 10.05, 9.95, 10, 10.1, 9.9, 10, 10.05, 9.95, 10, 10.4, 10, 9.95];
    const M = computeVarModel('k值能力', ['x'], base.map((v) => [v]));
    const rules = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
    const std = countCapabilityViolations(M, rules, DEFAULT_RULE_K);
    const tight = countCapabilityViolations(M, rules, { ...DEFAULT_RULE_K, k1: 1 });
    expect(tight).toBeGreaterThan(std);
  });
});
