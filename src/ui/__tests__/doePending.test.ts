/** DOE 待录入状态：与数值/列名分离，重命名后仍阻断，实测 0 可明确完成。 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import {
  generateFactorialDesign, resolveDoeColumns, detectFactorial, analyzeFactorial, buildDoeWorksheetOutput,
} from '../../core';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { Doe } from '../pages/Doe';
import { chartTokens } from '../tokens';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
  useApp.setState({ doeTab: 'analyze', doeFactorCols: null, doeRespCol: null, doeModelTerms: null, doeIncludeCurvature: true });
});

describe('DOE 创建→录入→分析→存储端到端', () => {
  it('显著交互存在时页面枚举完整模型角点，不误按主效应独立推荐', () => {
    const A = [-1, 1, -1, 1, -1, 1, -1, 1];
    const B = [-1, -1, 1, 1, -1, -1, 1, 1];
    const response = A.map((a, index) => a + B[index] - 10 * a * B[index]);
    useData.getState().importMatrix('DOE交互优化', ['A', 'B', 'Y'], A.map((a, index) => [a, B[index], response[index]]));
    useApp.setState({ page: 'doe', doeFactorCols: ['A', 'B'], doeRespCol: 'Y' });
    const text = render(createElement(Doe, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('已综合显著交互作用');
    expect(text).toContain('无唯一最优组合');
    expect(text).toContain('A=1.000000(高)');
    expect(text).toContain('B=-1.000000(低)');
    expect(text).toContain('A=-1.000000(低)');
    expect(text).toContain('B=1.000000(高)');
    expect(text).not.toContain('A=1.000000(高)、B=1.000000(高)');
  });

  it('所选模型项全部与区组混杂时明确标成未运行，不伪报“无显著项”', () => {
    const factorA = [-1, 1, -1, 1, -1, 1, -1, 1];
    const factorB = [-1, -1, 1, 1, -1, -1, 1, 1];
    const blocks = factorA.map((value) => value < 0 ? 1 : 2); // A 与区组完全混杂
    const response = factorB.map((value, row) => 50 + 5 * value + row * 0.1);
    useData.getState().importMatrix(
      'DOE退化模型', ['区组', 'A', 'B', 'Y'],
      factorA.map((value, row) => [blocks[row], value, factorB[row], response[row]]),
    );
    useApp.setState({
      page: 'doe', doeFactorCols: ['A', 'B'], doeRespCol: 'Y',
      doeModelTerms: ['A'], doeIncludeCurvature: false,
    });
    const text = render(createElement(Doe, { T: chartTokens('经典', true) })).container.textContent ?? '';
    expect(text).toContain('当前模型没有可独立估计的因子效应，分析未运行');
    expect(text).toContain('A 与 已保留模型项的线性组合 线性相关');
    expect(text).not.toContain('未发现显著');
    expect(text).not.toContain('将存储项写回工作表');
  });

  it('精确 7 行设计的元数据、响应、拟合/效应/残差/系数/标准化残差全部落盘', () => {
    const design = generateFactorialDesign(
      [{ name: '过盈量', low: 0.045, high: 0.09 }, { name: '轴硬度', low: 28, high: 32 }],
      { centerPoints: 3, blocks: 1, randomize: true, seed: 20260713 },
    );
    useData.getState().importMatrix(
      'DOE精确7行', design.colNames, design.rows, design.textCols,
      design.rows.map((_, row) => ({ row, col: design.responseCol })),
    );
    expect(useData.getState().model.colNames.slice(0, 3)).toEqual(['标准序', '运行序', '区组']);
    expect(useData.getState().textCols.find((column) => column.name === '点类型')?.values.filter((value) => value === '中心点')).toHaveLength(3);

    // 原始 DOE PPT 的标准序→响应：角点 1..4，随后 3 个中心点 5..7。
    const responseByStandardOrder: Record<number, number> = {
      1: 530, 2: 1180, 3: 690, 4: 1380, 5: 970, 6: 940, 7: 980,
    };
    design.rows.forEach((row, rowIndex) => {
      useData.getState().updateCell(rowIndex, design.responseCol, responseByStandardOrder[row[0]]);
    });
    expect(useData.getState().pendingCells).toHaveLength(0);

    const current = useData.getState().model;
    const { factorIdx, respIdx } = resolveDoeColumns(current.colNames, null, null);
    expect(factorIdx.map((index) => current.colNames[index])).toEqual(['过盈量', '轴硬度']);
    expect(current.colNames[respIdx]).toBe('响应(待录入)');
    const detected = detectFactorial(
      factorIdx.map((index) => ({ name: current.colNames[index], values: current.subs.map((row) => row.vals[index]) })),
      current.subs.map((row) => row.vals[respIdx]),
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const output = buildDoeWorksheetOutput(result);
    useData.getState().writeAnalysisColumns(output.numericColumns, output.textColumns);
    useData.getState().writeAnalysisColumns(output.numericColumns, output.textColumns); // 重复操作应覆盖同名列

    const stored = useData.getState();
    expect(stored.model.colNames).toEqual(expect.arrayContaining(['DOE拟合值', 'DOE残差', 'DOE标准化残差']));
    expect(stored.model.colNames.filter((name) => name === 'DOE拟合值')).toHaveLength(1);
    expect(stored.textCols.map((column) => column.name)).toEqual(expect.arrayContaining(['点类型', 'DOE模型项', 'DOE效应', 'DOE系数']));
    const fitIndex = stored.model.colNames.indexOf('DOE拟合值');
    expect(stored.model.subs.map((row) => row.vals[fitIndex])).toEqual(result.fits);
    const persisted = JSON.parse(localStorage.getItem('qp-dataset-v1')!);
    expect(persisted.colNames).toEqual(stored.model.colNames);
    expect(persisted.textCols.find((column: { name: string }) => column.name === 'DOE效应')).toBeDefined();

    useApp.setState({
      page: 'doe', doeFactorCols: ['过盈量', '轴硬度'], doeRespCol: '响应(待录入)',
      doeModelTerms: ['过盈量', '轴硬度'], doeIncludeCurvature: false,
    });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.status).toBe('已分析');
    expect(saved?.datasetName).toBe('DOE精确7行');
    expect(saved?.snapshot.doeModelTerms).toEqual(['过盈量', '轴硬度']);
    expect(saved?.snapshot.doeIncludeCurvature).toBe(false);
    useApp.setState({ doeModelTerms: null, doeIncludeCurvature: true });
    useAnalyses.getState().restore(saved!.id);
    expect(useApp.getState().doeModelTerms).toEqual(['过盈量', '轴硬度']);
    expect(useApp.getState().doeIncludeCurvature).toBe(false);
  });

  it('旧版 DOE 快照缺少原数据时阻止回看，不继承或覆盖当前页面', () => {
    useAnalyses.setState({
      saved: [{
        id: 'legacy-doe', kind: 'doe', title: '旧 DOE', datasetName: useData.getState().model.name,
        metric: '已分析', status: '已分析', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { doeView: 'main', doeFactorCols: null, doeRespCol: null },
      }],
    });
    useApp.setState({ doeModelTerms: ['A'], doeIncludeCurvature: false });
    useAnalyses.getState().restore('legacy-doe');
    expect(useApp.getState().doeModelTerms).toEqual(['A']);
    expect(useApp.getState().doeIncludeCurvature).toBe(false);
    expect(useApp.getState().toast).toContain('数据快照缺失');
  });
});

function importPendingDesign() {
  const d = generateFactorialDesign(
    [{ name: '过盈量', low: 0.045, high: 0.09 }, { name: '轴硬度', low: 28, high: 32 }],
    { centerPoints: 3, randomize: false },
  );
  const responseCol = d.colNames.length - 1;
  useData.getState().importMatrix(
    'DOE待录入', d.colNames, d.rows, [],
    d.rows.map((_, row) => ({ row, col: responseCol })),
  );
  return { responseCol, rows: d.rows.length };
}

describe('DOE pendingCells', () => {
  it('重命名响应列后仍保留待录入状态，编辑为真实 0 也会完成该格', () => {
    const { responseCol, rows } = importPendingDesign();
    expect(useData.getState().pendingCells).toHaveLength(rows);

    useData.getState().renameColumn(responseCol, '压入力');
    expect(useData.getState().pendingCells).toHaveLength(rows);

    useData.getState().updateCell(0, responseCol, 0);
    expect(useData.getState().pendingCells).toHaveLength(rows - 1);
    expect(JSON.parse(localStorage.getItem('qp-dataset-v1')!).pendingCells).toHaveLength(rows - 1);
  });

  it('保存 DOE 摘要使用显式待录入状态，不再依赖“待录入”列名', () => {
    const { responseCol, rows } = importPendingDesign();
    useData.getState().updateCell(0, responseCol, 620);
    useData.getState().renameColumn(responseCol, '压入力');
    useApp.setState({
      page: 'doe', doeFactorCols: ['过盈量', '轴硬度'], doeRespCol: '压入力',
    });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.metric).toBe(`尚有 ${rows - 1} 行未录入`);
    expect(saved?.status).toBe('未分析');
  });

  it('复制行/列会复制待录入语义，0→0 查找替换不能清除标记', () => {
    const { rows } = importPendingDesign();
    useData.getState().addSubgroupRow();
    expect(useData.getState().pendingCells).toHaveLength(rows + 1);

    useData.getState().insertColumn();
    expect(useData.getState().pendingCells).toHaveLength((rows + 1) * 2);

    useData.getState().findReplace(0, 0, -1);
    expect(useData.getState().pendingCells).toHaveLength((rows + 1) * 2);
    useData.getState().findReplace(-0, 0, -1);
    expect(useData.getState().pendingCells).toHaveLength((rows + 1) * 2);
  });

  it('未完成录入时拒绝会把占位值当观测的派生操作', () => {
    importPendingDesign();
    expect(useData.getState().standardize()).toBeNull();
    expect(useData.getState().subsetByCondition('C1 > 0')).toMatchObject({ ok: false, error: expect.stringContaining('待录入') });
    expect(() => useData.getState().transposeDataset()).toThrow('待录入');
    expect(() => useData.getState().stackColumns()).toThrow('待录入');
    expect(useData.getState().addFormulaColumn('派生响应', 'C1 + C2')).toContain('待录入');
  });

  it('撤销同步 pending 到最近数据，导入新数据后不会跨数据集撤销', () => {
    const { responseCol, rows } = importPendingDesign();
    useData.getState().updateCell(0, responseCol, 620);
    expect(useData.getState().pendingCells).toHaveLength(rows - 1);

    expect(useData.getState().undoEdit()).toBe(true);
    expect(useData.getState().pendingCells).toHaveLength(rows);
    expect(useData.getState().recents[0].data?.pendingCells).toHaveLength(rows);

    useData.getState().importMatrix('新数据', ['x'], [[1], [2]]);
    expect(useData.getState().undoEdit()).toBe(false);
  });
});
