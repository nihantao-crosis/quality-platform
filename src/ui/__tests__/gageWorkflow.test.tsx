/** Gage R&R 页面、保存恢复与专项导出的同源闭环。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
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
    gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
    gageTolMode: 'auto', gageTolValue: null, gageStandard: 'factory',
  });
});

describe('Gage R&R 当前研究闭环', () => {
  it('量具追溯字段可直接填写，并由状态与报告使用同一份值', () => {
    importStudy();
    const view = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    fireEvent.change(view.getByLabelText('量具名称'), { target: { value: '数显千分尺-01' } });
    fireEvent.change(view.getByLabelText('报表人'), { target: { value: '张工' } });
    fireEvent.change(view.getByLabelText('研究日期'), { target: { value: '2026-07-21' } });
    fireEvent.change(view.getByLabelText('量具备注'), { target: { value: '产线 A 首件研究' } });
    expect(useApp.getState()).toMatchObject({
      gageGaugeName: '数显千分尺-01', gageReportBy: '张工',
      gageStudyDate: '2026-07-21', gageNotes: '产线 A 首件研究',
    });
    const info = buildActiveAnalysisReport()?.tables.find((table) => table.title === '量具研究信息');
    expect(info?.rows[0]).toEqual([
      '数显千分尺-01', '张工', '2026-07-21', expect.any(String), '产线 A 首件研究',
    ]);
  });

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
    expect(report?.charts).toHaveLength(1); // v1.40.1:单张 Minitab 式整图
    expect(report?.charts[0].title).toContain('量具 R&R(ANOVA) 图形报告');
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
    expect(report?.tables.find((table) => table.title.includes('原始观测'))?.rows[0])
      .toEqual(['101', '1', 1, '10.00000000']);
  });

  it('单侧规格按 Minitab 单边口径计算 %公差(v1.40);公差模式 none 时明确不计算', () => {
    importStudy();
    useApp.setState({ lslOn: true, uslOn: false, lsl: 0, usl: 30, gageTolMode: 'auto' });
    const view = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('合计 Gage R&R');
    expect(view.container.textContent).not.toContain('Gage R&R 尚未运行');
    // auto + 仅 LSL → 单侧下限口径:%公差=3×SD/(总均值−LSL),不再显示“不可计算”
    const report = buildActiveAnalysisReport();
    const componentTable = report?.tables.find((table) => table.title === '方差分量与研究变异');
    expect(componentTable?.note).toContain('过程公差下限');
    expect(componentTable?.note).toContain('3×SD');
    expect(componentTable?.rows.every((row) => row[6] !== '—')).toBe(true);

    cleanup();
    useApp.setState({ gageTolMode: 'none' });
    const view2 = render(createElement(GageRR, { T: chartTokens('经典', true) }));
    expect(view2.container.textContent).toContain('% 公差明确不计算');
    const report2 = buildActiveAnalysisReport();
    expect(report2?.warnings.join(' ')).toContain('% 公差不可计算');
    const table2 = report2?.tables.find((table) => table.title === '方差分量与研究变异');
    expect(table2?.rows.every((row) => row[6] === '—')).toBe(true);
    expect(table2?.note).toContain('未提供过程公差');
    expect(useAnalyses.getState().saveCurrent()).toMatchObject({ status: '理想' }); // 工厂口径默认:GRR≈1.6% 且无公差→仅按 %SV 判为理想
  });

  it('v1.39 旧快照回放:无公差口径/判定标准字段时按保存时行为固化(双侧宽度+AIAG),不继承当前设置', () => {
    importStudy();
    useApp.setState({ lsl: 9, usl: 21, lslOn: true, uslOn: true });
    const saved = useAnalyses.getState().saveCurrent()!;
    // 模拟 v1.39 快照:删除 v1.40 新增的三个字段(旧记录本来就没有)
    useAnalyses.setState({
      saved: useAnalyses.getState().saved.map((entry) => {
        if (entry.id !== saved.id) return entry;
        const snapshot = { ...entry.snapshot } as Record<string, unknown>;
        delete snapshot.gageTolMode;
        delete snapshot.gageTolValue;
        delete snapshot.gageStandard;
        return { ...entry, snapshot: snapshot as typeof entry.snapshot };
      }),
    });
    // 当前会话切换成完全不同的口径,回放不得继承当前设置
    useApp.setState({ gageTolMode: 'upper', gageTolValue: 100, gageStandard: 'factory' });
    useAnalyses.getState().restore(saved.id);
    expect(useApp.getState()).toMatchObject({ gageTolMode: 'width', gageTolValue: 12, gageStandard: 'aiag' });
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
