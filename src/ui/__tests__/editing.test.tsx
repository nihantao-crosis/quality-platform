/**
 * 手工录入与图文报告测试。
 * @vitest-environment jsdom
 */
import { DEFAULT_SPC_RULES } from '../../store/appStore';
import { describe, it, expect, beforeEach } from 'vitest';
import { assessSpcCharts, DEFAULT_RULE_K } from '../../core';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { buildHtmlReport } from '../../platform/htmlReport';

// fix2609 TESTS-02:resetDemo 不清模块级已见名集合(knownDatasetNames 等)与 recents;
// 两处都复位,副本命名才与用例顺序无关(范式同 copyCollisionSafety.test.ts)。
beforeEach(() => {
  localStorage.clear();
  cancelPendingDatasetWork();
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
});

describe('工作表手工录入', () => {
  // fix2609 TESTS-02 顺序隔离哨兵:本条先生成一次「质检数据 (副本)」,下一条仍须拿到「(副本)」
  // 而非「(副本2)」——beforeEach 漏复位模块级已见名集合或 recents 时,默认顺序即转红。
  it('演示集加子组行同样转「副本」(副本命名不受前序用例残留影响)', () => {
    expect(useData.getState().model.isDemo).toBe(true);
    useData.getState().addSubgroupRow();
    expect(useData.getState().model.name).toBe('质检数据 (副本)');
    expect(useData.getState().model.isDemo).toBe(false);
  });
  it('编辑演示集单元格 → 转「副本」且统计重算', () => {
    const before = useData.getState().model;
    expect(before.isDemo).toBe(true);
    const oldMean = before.oMean;
    useData.getState().updateCell(0, 0, 99);
    const after = useData.getState().model;
    expect(after.name).toBe('质检数据 (副本)');
    expect(after.isDemo).toBe(false);
    expect(after.subs[0].vals[0]).toBe(99);
    expect(after.oMean).not.toBeCloseTo(oldMean, 6);
  });
  it('添加子组复制末行;删除行受 k≥2 保护', () => {
    const s = useData.getState();
    const k0 = s.model.k;
    const last = [...s.model.subs[k0 - 1].vals];
    s.addSubgroupRow();
    let m = useData.getState().model;
    expect(m.k).toBe(k0 + 1);
    expect(m.subs[k0].vals).toEqual(last);
    useData.getState().deleteRow(k0);
    m = useData.getState().model;
    expect(m.k).toBe(k0);
    // 删到只剩 2 行后再删无效
    useData.getState().importMatrix('t', ['a'], [[1], [2]]);
    useData.getState().deleteRow(0);
    expect(useData.getState().model.k).toBe(2);
  });
  it('非法值被拒绝,不产生变更', () => {
    const before = useData.getState().model;
    useData.getState().updateCell(0, 0, NaN);
    expect(useData.getState().model).toBe(before);
  });
  it('编辑导入集保留原名并进入最近列表', () => {
    useData.getState().importMatrix('产线A.csv', ['x', 'y'], [[1, 2], [3, 4], [5, 6]]);
    useData.getState().updateCell(1, 1, 42);
    const s = useData.getState();
    expect(s.model.name).toBe('产线A.csv');
    expect(s.model.subs[1].vals[1]).toBe(42);
    expect(s.recents[0].data!.rows[1][1]).toBe(42);
  });
});

describe('图文报告 (HTML)', () => {
  it('内嵌四张 SVG 图表与关键统计', () => {
    const M = useData.getState().model;
    const html = buildHtmlReport(M, { lsl: 24.9, tgt: 25.0, usl: 25.1 }, assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r'));
    // 通用报告必须同时给出位置图、离散图、直方图和正态概率图。
    expect((html.match(/<svg/g) ?? []).length).toBe(4);
    expect(html).toContain('质量分析报告');
    expect(html).toContain(M.name);
    expect(html).toContain('Cpk');
    expect(html).toContain('Anderson-Darling');
    expect(html).toContain('准则'); // 演示数据有失控点表
  });
});
