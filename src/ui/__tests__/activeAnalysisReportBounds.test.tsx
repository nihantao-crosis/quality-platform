/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { computeVarModel } from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { MAX_SPC_REPORT_DETAIL_ROWS } from '../../platform/reportLabels';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

const LARGE_ROW_COUNT = MAX_SPC_REPORT_DETAIL_ROWS + 5;

function installLargeTwoColumnWorksheet(): void {
  const rows = Array.from({ length: LARGE_ROW_COUNT }, (_, index) => {
    const a = index + 1;
    return [a, 2 * a + (index % 5) / 10];
  });
  useData.setState({
    model: computeVarModel('report-bounds.csv', ['A', 'B'], rows),
    textCols: [],
    pendingCells: [],
  });
}

function table(title: string) {
  const report = buildActiveAnalysisReport();
  const result = report?.tables.find((candidate) => candidate.title === title);
  if (!result) throw new Error(`缺少生产报告表：${title}`);
  return result;
}

afterEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
});

describe('buildActiveAnalysisReport 大表展示载荷有界', () => {
  it('描述统计仍用全量观测计算，原始观测表只物化前 2 万行', () => {
    installLargeTwoColumnWorksheet();
    useApp.setState({ page: 'summary', activeVar: 'A' });

    const report = buildActiveAnalysisReport();
    const source = table('用于汇总的原始观测');
    expect(report?.kind).toBe('summary');
    expect(report?.subtitle).toContain(`N=${LARGE_ROW_COUNT}`);
    expect(source.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(source.totalRows).toBe(LARGE_ROW_COUNT);
    expect(source.rows[source.rows.length - 1]).toEqual([MAX_SPC_REPORT_DETAIL_ROWS, '20000.0000000000']);
  }, 60_000);

  it('ANOVA wide 的有界归并保持原工作表行序，并保留真实观测总数', () => {
    installLargeTwoColumnWorksheet();
    useApp.setState({
      page: 'anova', hypoTab: 'anova', anovaMode: 'wide',
      anovaRespName: null, anovaFactorName: null, anovaShowDemo: false,
    });

    const report = buildActiveAnalysisReport();
    const source = table('用于 ANOVA 的原始观测');
    const residuals = report?.tables.find((candidate) => candidate.title === '残差诊断数据');
    expect(report?.kind).toBe('anova');
    expect(source.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(source.totalRows).toBe(LARGE_ROW_COUNT * 2);
    expect(source.rows.slice(0, 4)).toEqual([
      [1, 'A', '1.00000000'],
      [1, 'B', '2.00000000'],
      [2, 'A', '2.00000000'],
      [2, 'B', '4.10000000'],
    ]);
    expect(source.rows[source.rows.length - 2]?.slice(0, 2)).toEqual([10_000, 'A']);
    expect(source.rows[source.rows.length - 1]?.slice(0, 2)).toEqual([10_000, 'B']);
    expect(residuals?.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(residuals?.totalRows).toBe(LARGE_ROW_COUNT * 2);
  }, 60_000);

  it('单样本 t 的检验统计量基于全量 N，原始样本表有界', () => {
    installLargeTwoColumnWorksheet();
    useApp.setState({ page: 'anova', hypoTab: 't1', t1ColName: 'A', t1Mu0: 10_000 });

    const report = buildActiveAnalysisReport();
    const source = table('原始样本');
    const result = report?.tables.find((candidate) => candidate.title === '检验结果');
    expect(report?.kind).toBe('t1');
    expect(source.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(source.totalRows).toBe(LARGE_ROW_COUNT);
    expect(result?.rows[0]?.[0]).toBe(LARGE_ROW_COUNT);
  }, 60_000);

  it('双样本 t 保留两组真实总数，不会为了导出截断统计输入', () => {
    installLargeTwoColumnWorksheet();
    useApp.setState({ page: 'anova', hypoTab: 't2', t2ColAName: 'A', t2ColBName: 'B' });

    const report = buildActiveAnalysisReport();
    const source = table('原始样本');
    expect(report?.kind).toBe('t2');
    expect(source.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(source.totalRows).toBe(LARGE_ROW_COUNT * 2);
    expect(source.rows[0]).toEqual(['A', 1, '1.00000000']);
    expect(source.rows[source.rows.length - 1]?.slice(0, 2)).toEqual(['A', MAX_SPC_REPORT_DETAIL_ROWS]);
    expect(report?.subtitle).toBe('A vs B');
  }, 60_000);

  it('回归报告的 N 与全量工作表一致，仅限制原始 X/Y 展示载荷', () => {
    installLargeTwoColumnWorksheet();
    useApp.setState({ page: 'anova', hypoTab: 'reg', regXName: 'A', regYName: 'B' });

    const report = buildActiveAnalysisReport();
    const source = table('原始 X/Y 观测');
    const result = report?.tables.find((candidate) => candidate.title === '回归统计');
    expect(report?.kind).toBe('reg');
    expect(source.rows).toHaveLength(MAX_SPC_REPORT_DETAIL_ROWS);
    expect(source.totalRows).toBe(LARGE_ROW_COUNT);
    expect(result?.rows[0]?.[0]).toBe(LARGE_ROW_COUNT);
  }, 60_000);
});

describe('其他生产报告的 totalRows 接线', () => {
  it('ANOVA 无工作表行号时仍按「组内序号/因子/响应」列序输出', () => {
    useData.getState().resetDemo();
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaShowDemo: false });

    const source = table('用于 ANOVA 的原始观测');
    expect(typeof source.rows[0]?.[0]).toBe('number');
    expect(typeof source.rows[0]?.[1]).toBe('string');
    expect(source.totalRows).toBe(source.rows.length);
  });

  it('DOE 设计矩阵、帕累托两表与 Gage 原始观测都带逻辑总行数', () => {
    useData.setState({
      model: computeVarModel('doe.csv', ['A', 'B', 'Y'], [
        [-1, -1, 10], [1, -1, 20], [-1, 1, 12], [1, 1, 22],
      ]),
      textCols: [], pendingCells: [],
    });
    useApp.setState({
      page: 'doe', doeTab: 'analyze', doeFactorCols: ['A', 'B'], doeRespCol: 'Y',
      doeModelTerms: null, doeIncludeCurvature: false,
    });
    const doe = buildActiveAnalysisReport();
    const design = doe?.tables.find((candidate) => candidate.title === '设计矩阵、拟合与残差');
    expect(doe?.kind).toBe('doe');
    expect(design?.rows).toHaveLength(4);
    expect(design?.totalRows).toBe(4);

    useData.setState({
      paretoModel: {
        name: '接线帕累托',
        rows: [{ name: 'A', count: 5 }, { name: 'B', count: 3 }, { name: 'C', count: 1 }],
      },
    });
    useApp.setState({ page: 'pareto', paretoView: 'pareto', paretoShowDemo: false });
    const pareto = buildActiveAnalysisReport();
    expect(pareto?.tables.find((candidate) => candidate.title === '导入的原始缺陷数据')?.totalRows).toBe(3);
    expect(pareto?.tables.find((candidate) => candidate.title === '缺陷频数与累计贡献')?.totalRows).toBe(3);

    useApp.setState({ page: 'gagerr', gageUseReal: false });
    const gage = buildActiveAnalysisReport();
    const observations = gage?.tables.find((candidate) => candidate.title === '演示交叉研究原始观测');
    expect(gage?.kind).toBe('gagerr');
    expect(observations?.totalRows).toBe(observations?.rows.length);
    expect(observations?.totalRows).toBeGreaterThan(0);
  });
});
