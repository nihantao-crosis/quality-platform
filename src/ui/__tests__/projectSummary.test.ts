/**
 * 项目汇总报告 + 项目命名。
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildProjectSummary } from '../../platform/projectSummary';
import { useApp } from '../../store/appStore';
import type { SavedAnalysis } from '../../store/analyses';

const mk = (over: Partial<SavedAnalysis>): SavedAnalysis => ({
  id: 'x', kind: 'spc', title: 'X̄-R 控制图', datasetName: '质检数据.mtw',
  metric: '2 失控点', status: '需关注', statusColor: '#c22f2f', statusBg: '#fdecec',
  createdAt: Date.now(), snapshot: {}, ...over,
});

describe('项目汇总报告', () => {
  it('含项目名、计数卡、各分析行', () => {
    const html = buildProjectSummary('犇厂 2026-Q3', [
      mk({ id: 'a', kind: 'spc', title: 'X̄-R 控制图', datasetName: 'A.csv' }),
      mk({ id: 'b', kind: 'capability', title: '过程能力分析', datasetName: 'A.csv', metric: 'Cpk 1.36', status: '能力充足' }),
      mk({ id: 'c', kind: 'aql', title: '抽样检验 · AQL 方案', datasetName: 'B.csv', metric: 'n=20 Ac=1', status: '已生成' }),
    ]);
    expect(html).toContain('犇厂 2026-Q3');
    expect(html).toContain('X̄-R 控制图');
    expect(html).toContain('过程能力分析');
    expect(html).toContain('Cpk 1.36');
    // 3 条分析、2 个数据集、3 种类型
    expect(html).toMatch(/>3<\/div>\s*<div class="l">分析总数/);
    expect(html).toMatch(/>2<\/div>\s*<div class="l">涉及数据集/);
  });
  it('空项目给出提示,不报错', () => {
    const html = buildProjectSummary('空项目', []);
    expect(html).toContain('暂无已保存的分析');
    expect(html).toContain('空项目');
  });
  it('转义 HTML 特殊字符', () => {
    const html = buildProjectSummary('<x>&"', []);
    expect(html).toContain('&lt;x&gt;&amp;');
  });
});

describe('项目命名', () => {
  it('setProjectName 去空白;空串回落未命名', () => {
    useApp.getState().setProjectName('  产线甲  ');
    expect(useApp.getState().projectName).toBe('产线甲');
    useApp.getState().setProjectName('   ');
    expect(useApp.getState().projectName).toBe('未命名项目');
    useApp.getState().setProjectName('质检项目 2026-Q2'); // 复位
  });
});
