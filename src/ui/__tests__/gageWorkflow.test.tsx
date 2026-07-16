/** Gage R&R 页面、保存恢复与专项导出的同源闭环。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { GageRR } from '../pages/SimplePages';
import { chartTokens } from '../tokens';

const ROWS = [
  [10.00], [10.10], [10.20], [10.10],
  [20.00], [20.20], [20.10], [20.30],
];
const TEXT = [
  { name: '部件', values: ['P1', 'P1', 'P1', 'P1', 'P2', 'P2', 'P2', 'P2'] },
  { name: '操作员', values: ['O1', 'O1', 'O2', 'O2', 'O1', 'O1', 'O2', 'O2'] },
];

function importStudy(pendingCells: Array<{ row: number; col: number }> = []) {
  useData.getState().importMatrix('量具研究.csv', ['测量值'], ROWS, TEXT, pendingCells);
  useApp.setState({
    page: 'gagerr', gageUseReal: true, gageValueName: '测量值', gagePartName: '部件', gageOperatorName: '操作员',
  });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'dashboard', lsl: 0, usl: 30, lslOn: true, uslOn: true,
    gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
  });
});

describe('Gage R&R 当前研究闭环', () => {
  it('有效 2×2×2 导入研究在页面与专项报告均使用真实数据', () => {
    importStudy();
    const text = render(createElement(GageRR, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('导入数据');
    expect(text).not.toContain('演示研究');
    expect(text).toContain('合计 Gage R&R');

    const report = buildActiveAnalysisReport();
    expect(report).toMatchObject({ kind: 'gagerr', usesWorksheet: true });
    expect(report?.subtitle).toContain('测量值 · 部件 部件 · 操作员 操作员 · 2×2×2');
    expect(report?.warnings).toHaveLength(0);
    expect(report?.tables.find((table) => table.title.includes('原始观测'))?.rows).toHaveLength(8);
    expect(report?.charts).toHaveLength(1);
  });

  it('待录入或无效交叉设计明确阻断，不静默回落演示结果', () => {
    importStudy([{ row: 0, col: 0 }]);
    const text = render(createElement(GageRR, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('Gage R&R 尚未运行');
    expect(text).toContain('1 个待录入');
    expect(text).toContain('不会静默回落到演示研究');
    const report = buildActiveAnalysisReport();
    expect(report?.summary.join(' ')).toContain('未运行');
    expect(report?.warnings.join(' ')).toContain('1 个待录入');
    expect(report?.charts).toHaveLength(0);

    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved).toMatchObject({ status: '未分析', datasetName: '量具研究.csv' });
    expect(saved.snapshot).toMatchObject({ gageRequestedReal: true, gageSourceReal: false });
    expect(saved.snapshot.sourceDataKey || saved.snapshot.sourceData).toBeTruthy();
    useData.getState().importMatrix('后来.csv', ['X'], [[1], [2], [3]]);
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe('量具研究.csv');
    expect(useData.getState().pendingCells).toEqual([{ row: 0, col: 0 }]);
  });

  it('真实工作表缺少第二个类别列时也阻断，并可显式取消真实模式查看示例', () => {
    useData.getState().importMatrix(
      '缺操作员.csv', ['测量值'], [[10], [11], [20], [21]],
      [{ name: '部件', values: ['P1', 'P1', 'P2', 'P2'] }],
    );
    useApp.setState({ page: 'gagerr', gageUseReal: true });
    const view = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('Gage R&R 尚未运行');
    expect(view.container.textContent).toContain('还需要 2 个类别列');
    expect(view.container.textContent).toContain('数字 ID 或文本');
    expect(buildActiveAnalysisReport()?.summary.join(' ')).toContain('未运行');

    useApp.setState({ gageUseReal: false });
    expect(buildActiveAnalysisReport()?.warnings.join(' ')).toContain('内置交叉');
  });

  it('用户明确取消真实研究时，页面、保存摘要和导出都标记内置示例', () => {
    importStudy();
    useApp.setState({ gageUseReal: false });
    const text = render(createElement(GageRR, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('演示研究');
    const report = buildActiveAnalysisReport();
    expect(report).toMatchObject({ usesWorksheet: false });
    expect(report?.subtitle).toContain('非用户数据');
    expect(report?.warnings.join(' ')).toContain('内置交叉');
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toMatchObject({ status: '演示', datasetName: '内置交叉 Gage R&R 研究' });
    expect(saved?.snapshot.gageSourceReal).toBe(false);
  });

  it('数字编码的部件/操作员可作为类别角色，不会被展平成测量值', () => {
    useData.getState().importMatrix(
      '数字ID量具研究.csv',
      ['测量值', '部件ID', '操作员ID'],
      [
        [10.0, 101, 1], [10.1, 101, 1], [10.2, 101, 2], [10.1, 101, 2],
        [20.0, 205, 1], [20.2, 205, 1], [20.1, 205, 2], [20.3, 205, 2],
      ],
    );
    useApp.setState({
      page: 'gagerr', gageUseReal: true, gageValueName: '测量值', gagePartName: '部件ID', gageOperatorName: '操作员ID',
    });
    const view = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('部件ID (数字 ID)');
    expect(view.container.textContent).toContain('操作员ID (数字 ID)');
    expect(view.container.textContent).toContain('导入数据');
    expect(view.container.textContent).not.toContain('Gage R&R 尚未运行');
    const report = buildActiveAnalysisReport();
    expect(report).toMatchObject({ usesWorksheet: true });
    expect(report?.subtitle).toContain('测量值 · 部件 部件ID · 操作员 操作员ID');
    expect(report?.tables[0].rows[0]).toEqual(['101', '1', 1, '10.00000000']);
  });

  it('单侧规格不会伪造公差宽度：GRR 继续计算，页面/报告 %公差都明确不可计算', () => {
    importStudy();
    useApp.setState({ lslOn: true, uslOn: false, lsl: 0, usl: 30 });
    const view = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('合计 Gage R&R');
    expect(view.container.textContent).not.toContain('Gage R&R 尚未运行');
    expect(view.container.textContent).toContain('% 公差明确不计算');

    const report = buildActiveAnalysisReport();
    expect(report?.warnings.join(' ')).toContain('% 公差不可计算');
    const componentTable = report?.tables.find((table) => table.title === '方差分量与研究变异');
    expect(componentTable?.rows.every((row) => row[4] === '—')).toBe(true);
    expect(componentTable?.note).toContain('未提供双侧公差宽度');
    expect(useAnalyses.getState().saveCurrent()).toMatchObject({ status: '可接受' });
  });

  it('真实研究保存后精确恢复数据与列角色，不受后来数据覆盖', () => {
    importStudy();
    useApp.setState({ lsl: 9, usl: 21 });
    const before = buildActiveAnalysisReport();
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.snapshot).toMatchObject({
      gageUseReal: true, gageValueName: '测量值', gagePartName: '部件', gageOperatorName: '操作员', gageRequestedReal: true, gageSourceReal: true,
      lsl: 9, usl: 21, lslOn: true, uslOn: true,
    });
    useData.getState().importMatrix('后来.csv', ['X'], [[1], [2], [3]]);
    useApp.setState({ lsl: -100, usl: 100, lslOn: false, uslOn: true, gageValueName: null, gagePartName: null, gageOperatorName: null });
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe('量具研究.csv');
    expect(useData.getState().model.subs.map((row) => row.vals)).toEqual(ROWS);
    expect(useData.getState().textCols).toEqual(TEXT);
    expect(useApp.getState()).toMatchObject({
      page: 'gagerr', gageUseReal: true, gageValueName: '测量值', gagePartName: '部件', gageOperatorName: '操作员',
      lsl: 9, usl: 21, lslOn: true, uslOn: true,
    });
    expect(buildActiveAnalysisReport()?.tables.find((table) => table.title === '方差分量与研究变异')?.note)
      .toBe(before?.tables.find((table) => table.title === '方差分量与研究变异')?.note);
  });
});
