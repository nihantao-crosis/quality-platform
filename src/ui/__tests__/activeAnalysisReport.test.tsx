/** 当前页面 → 专项报表载荷的端到端角色/数据一致性。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildActiveAnalysisExport, buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp, type SpcType } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { saveFishboneState } from '../../store/fishboneStore';
import { freshSwitchStatus } from '../../core';

const DOE_ROWS = [
  [0.09, 28, 1180],
  [0.09, 32, 1380],
  [0.045, 32, 690],
  [0.045, 28, 530],
  [0.068, 30, 970],
  [0.068, 30, 940],
  [0.068, 30, 980],
];

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard',
    aqlLot: 2000,
    aqlLevel: 'II',
    aqlAQL: 1,
    aqlRegime: 'percent',
    aqlSwitch: freshSwitchStatus(),
    anovaMode: 'stacked',
    anovaRespName: null,
    anovaFactorName: null,
    anovaShowDemo: false,
    t1ColName: null,
    t1Mu0: null,
    t2ColAName: null,
    t2ColBName: null,
    regXName: null,
    regYName: null,
    doeTab: 'analyze',
    doeFactorCols: null,
    doeRespCol: null,
    doeModelTerms: null,
    doeIncludeCurvature: true,
    spcType: 'xbar-r',
    spcDataLayout: 'auto',
    spcValueCol: null,
    spcSubgroupCol: null,
    spcStageCol: null,
    capabilityBins: 13,
    gageUseReal: true,
    gageValueName: null,
    gagePartName: null,
    gageOperatorName: null,
    hypoTab: 'anova',
    paretoView: 'pareto',
    paretoMergeOther: true,
    paretoThreshold: 0.95,
    paretoShowDemo: false,
  });
});

describe('buildActiveAnalysisReport', () => {
  it('出厂 ANOVA / DOE 演示导出与页面一致且显式标记非用户数据', () => {
    useApp.setState({ page: 'anova', hypoTab: 'anova' });
    const anova = buildActiveAnalysisReport();
    expect(anova?.subtitle).toContain('非用户数据');
    expect(anova?.subtitle).toContain('直径 vs 设备');
    expect(anova?.warnings.join(' ')).toContain('演示研究');

    useApp.setState({ page: 'doe' });
    const doe = buildActiveAnalysisReport();
    expect(doe?.subtitle).toContain('非用户数据');
    expect(doe?.tables.find((table) => table.title === '演示设计矩阵')?.rows).toHaveLength(8);
    expect(doe?.warnings.join(' ')).toContain('演示数据');
  });

  it('AQL 导出正式主表、方案与批次记录结构', () => {
    useApp.setState({ page: 'aql' });
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('aql');
    expect(report?.subtitle).toContain('GB/T 2828.1-2012');
    expect(report?.summary.join(' ')).toContain('n=125');
    const trace = report?.tables.find((table) => table.title === '实际批次检验与追溯记录');
    expect(trace?.headers).toEqual(expect.arrayContaining(['批量 N', '水平', 'AQL', '质量表示', '主表', '初始字码', '执行字码', '全检', '得分']));
  });

  it('低 AQL 的 per100 专项报告导出泊松 OC 图，不回落二项或省略图表', () => {
    useApp.setState({ page: 'aql', aqlAQL: 1, aqlRegime: 'per100' });
    const report = buildActiveAnalysisReport();
    expect(report?.subtitle).toContain('每百单位不合格数');
    expect(report?.charts).toHaveLength(1);
    expect(report?.charts[0].title).toContain('每百单位不合格数');
    expect(report?.charts[0].svg).toContain('泊松');
    expect(report?.charts[0].svg).toContain('每百单位不合格数');
  });

  it('ANOVA 从原始因子表自动推断真实因子/响应，不导出演示或异量纲宽表', () => {
    useData.getState().importMatrix('ANOVA人工反馈', ['过盈量', '轴硬度', '压入力'], DOE_ROWS);
    useApp.setState({ page: 'anova', hypoTab: 'anova' });
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('anova');
    expect(report?.subtitle).toContain('压入力 vs 过盈量');
    expect(report?.tables.find((table) => table.title === '方差分析表')?.headers).toContain('MS');
    expect(report?.charts.map((chart) => chart.title)).toContain('个体值图');
  });

  it('ANOVA 示例标志只在无有效模式时生效，真实模式优先且导出一致', () => {
    useData.getState().importMatrix('真实ANOVA', ['因子', '响应'], [[1, 10], [1, 11], [2, 20], [2, 21]]);
    useApp.setState({
      page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor', anovaFactorName: '因子', anovaRespName: '响应',
      anovaShowDemo: true,
    });
    const report = buildActiveAnalysisReport();
    expect(report?.subtitle).toContain('响应 vs 因子');
    expect(report?.subtitle).not.toContain('内置演示');
    expect(report?.warnings.join(' ')).not.toContain('演示研究');
  });

  it('t1/t2/回归专项报告忠实使用当前列选择、目标值并拦截占位数据', () => {
    useData.getState().importMatrix('假设检验', ['A', 'B', 'C'], [[1, 10, 2], [2, 20, 4], [3, 30, 6], [4, 40, 8]]);
    useApp.setState({ page: 'anova', hypoTab: 't1', t1ColName: 'B', t1Mu0: 25 });
    expect(buildActiveAnalysisReport()).toMatchObject({ kind: 't1', subtitle: expect.stringContaining('B vs 目标 μ₀=25') });

    useApp.setState({ hypoTab: 't2', t2ColAName: 'C', t2ColBName: 'A' });
    expect(buildActiveAnalysisReport()).toMatchObject({ kind: 't2', subtitle: 'C vs A' });

    useApp.setState({ hypoTab: 'reg', regXName: 'A', regYName: 'C' });
    expect(buildActiveAnalysisReport()).toMatchObject({ kind: 'reg', subtitle: 'C vs A' });

    useData.getState().importMatrix('回归待录入', ['A', 'C'], [[1, 2], [2, 0], [3, 6]], [], [{ row: 1, col: 1 }]);
    useApp.setState({ hypoTab: 'reg', regXName: 'A', regYName: 'C' });
    const blocked = buildActiveAnalysisReport();
    expect(blocked?.summary.join(' ')).toContain('未运行');
    expect(blocked?.warnings.join(' ')).toContain('1 个待录入');
  });

  it('DOE 创建页不导出旧分析，切回分析页才生成当前 DOE 结论', () => {
    useData.getState().importMatrix('DOE分析', ['A', 'B', 'Y'], [[-1, -1, 10], [1, -1, 20], [-1, 1, 12], [1, 1, 22]]);
    useApp.setState({ page: 'doe', doeFactorCols: ['A', 'B'], doeRespCol: 'Y', doeTab: 'create' });
    const create = buildActiveAnalysisReport();
    expect(create?.summary.join(' ')).toContain('未运行');
    expect(create?.warnings.join(' ')).toContain('创建页');
    expect(create?.charts).toHaveLength(0);

    useApp.setState({ doeTab: 'analyze' });
    expect(buildActiveAnalysisReport()?.summary.join(' ')).not.toContain('未运行');
  });

  it('P 图专项报告逐批导出样本量与变控制限，不伪造固定 n', () => {
    useData.getState().importCounts('p', 'P逐批.csv', [1, 4, 2], [10, 40, 20]);
    useApp.setState({ page: 'spc', spcType: 'p' });
    const report = buildActiveAnalysisReport();
    const raw = report?.tables.find((table) => table.title === '用于 P 控制图的原始计数数据');
    expect(raw?.headers).toEqual(['样本', '不合格品数', '检验数', '不良率', 'LCL', 'UCL']);
    expect(raw?.rows.map((row) => row[2])).toEqual([10, 40, 20]);
    expect(new Set(raw?.rows.map((row) => row[5])).size).toBeGreaterThan(1);
    expect(raw?.note).toContain('每批 nᵢ');
    expect(report?.tables.find((table) => table.title === '控制限')?.rows[0]).toContain('逐批见原始计数表');

    const exported = buildActiveAnalysisExport();
    expect(exported.model.colNames).toEqual(['不良数', '样本量']);
    expect(exported.model.subs.map((subgroup) => subgroup.vals)).toEqual([[1, 10], [4, 40], [2, 20]]);
  });

  it('ANOVA 专项保留文本因子与原始响应，并排除 DOE 输出文本列', () => {
    useData.getState().importMatrix(
      'ANOVA长表',
      ['压入力'],
      [[10], [11], [20], [21]],
      [
        { name: 'DOE模型项', values: ['A', 'B', 'A×B', '曲率'] },
        { name: '设备', values: ['A', 'A', 'B', 'B'] },
      ],
    );
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'stacked' });
    const report = buildActiveAnalysisReport();
    expect(report?.subtitle).toContain('压入力 vs 设备');
    expect(report?.subtitle).not.toContain('DOE模型项');
    const raw = report?.tables.find((table) => table.title === '用于 ANOVA 的原始观测');
    expect(raw?.headers).toEqual(['工作表行', '设备', '压入力']);
    expect(raw?.rows).toEqual([[1, 'A', '10.00000000'], [2, 'A', '11.00000000'], [3, 'B', '20.00000000'], [4, 'B', '21.00000000']]);
  });

  it('ANOVA 异量纲宽表与无效分组导出明确未运行，不伪造 F/P', () => {
    useData.getState().importMatrix('ANOVA异量纲', ['过盈量', '轴硬度', '压入力'], DOE_ROWS);
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'wide' });
    const report = buildActiveAnalysisReport();
    expect(report?.summary.join(' ')).toContain('未运行');
    expect(report?.warnings.join(' ')).toContain('量纲悬殊');
    expect(report?.tables).toHaveLength(0);
    expect(report?.charts).toHaveLength(0);
  });

  it('ANOVA 使用列有待录入单元格时导出同样拦截占位 0', () => {
    useData.getState().importMatrix(
      'ANOVA待录入', ['因子', '响应'], [[1, 0], [1, 10], [2, 20], [2, 22]], [], [{ row: 0, col: 1 }],
    );
    useApp.setState({ page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor', anovaFactorName: '因子', anovaRespName: '响应' });
    const report = buildActiveAnalysisReport();
    expect(report?.summary.join(' ')).toContain('未运行');
    expect(report?.warnings.join(' ')).toContain('1 个待录入');
    expect(report?.tables).toHaveLength(0);
  });

  it('DOE 报告包含效应、设计元数据、拟合和标准化残差', () => {
    useData.getState().importMatrix('DOE人工反馈', ['过盈量', '轴硬度', '压入力'], DOE_ROWS);
    useApp.setState({ page: 'doe' });
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('doe');
    expect(report?.tables.map((table) => table.title)).toContain('效应与系数');
    const design = report?.tables.find((table) => table.title === '设计矩阵、拟合与残差');
    expect(design?.headers).toContain('标准化残差');
    expect(design?.rows).toHaveLength(7);
  });

  it('DOE 专项追溯表识别 Minitab StdOrder/RunOrder/Blocks/PtType 元数据别名', () => {
    useData.getState().importMatrix(
      'Minitab DOE',
      ['StdOrder', 'RunOrder', 'Blocks', 'PtType', 'A', 'B', 'Y'],
      [
        [4, 1, 1, 1, 1, 1, 40],
        [1, 2, 1, 1, -1, -1, 10],
        [3, 3, 2, 1, -1, 1, 30],
        [2, 4, 2, 1, 1, -1, 20],
      ],
    );
    useApp.setState({ page: 'doe', doeFactorCols: ['A', 'B'], doeRespCol: 'Y' });
    const report = buildActiveAnalysisReport();
    const design = report?.tables.find((table) => table.title === '设计矩阵、拟合与残差');
    expect(design?.rows.map((row) => row.slice(1, 5))).toEqual([
      [4, 1, 1, '因子点'], [1, 2, 1, '因子点'], [3, 3, 2, '因子点'], [2, 4, 2, '因子点'],
    ]);
    expect(report?.summary.join(' ')).toContain('2 个区组');
    expect(report?.tables.find((table) => table.title === '效应与系数')?.rows.some((row) => String(row[0]).startsWith('区组['))).toBe(true);
  });

  it('DOE 待录入响应在导出端同样拦截，不把占位 0 当实测值', () => {
    useData.getState().importMatrix(
      'DOE待录入',
      ['因子A', '因子B', '响应'],
      [[-1, -1, 0], [1, -1, 12], [-1, 1, 13], [1, 1, 15]],
      [],
      [{ row: 0, col: 2 }],
    );
    useApp.setState({ page: 'doe', doeFactorCols: ['因子A', '因子B'], doeRespCol: '响应' });
    const report = buildActiveAnalysisReport();
    expect(report?.summary.join(' ')).toContain('未运行');
    expect(report?.warnings.join(' ')).toContain('1 个待录入');
    expect(report?.charts).toHaveLength(0);
  });

  it('SPC 报告自动排除数值“子组”列，按正确 n=5 生成 Xbar-R', () => {
    useData.getState().importMatrix('Xbar人工反馈', ['子组', '测量1', '测量2', '测量3', '测量4', '测量5'], [
      [1, 25.00, 25.02, 24.99, 25.01, 25.00],
      [2, 25.01, 25.03, 25.00, 25.02, 25.01],
      [3, 24.99, 25.00, 25.01, 24.98, 25.00],
      [4, 25.02, 25.01, 25.03, 25.00, 25.02],
    ]);
    useApp.setState({ page: 'spc' });
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('spc');
    expect(report?.subtitle).toContain('n=5');
    expect(report?.summary.join(' ')).toContain('「子组」仅作子组标签');
    expect(report?.charts.map((chart) => chart.title).join(' ')).toContain('极差控制图');
    expect(buildActiveAnalysisExport().model.n).toBe(5);
  });

  it('所有 SPC 图型都有当前分析专项报告，不回落通用能力报告', () => {
    useData.getState().importMatrix('SPC多图型', ['测量1', '测量2', '测量3'], [
      [10, 11, 9], [10.2, 10.8, 9.4], [9.8, 10.5, 9.2], [10.1, 10.9, 9.5],
      [10.3, 11.1, 9.7], [9.9, 10.7, 9.3], [10.2, 10.6, 9.6], [10, 10.8, 9.4],
    ]);
    useApp.setState({ page: 'spc', spcDataLayout: 'rows' });
    const expected: Array<[SpcType, string]> = [
      ['xbar-s', 'X̄-S'], ['i-mr', 'I-MR'], ['ewma', 'EWMA'], ['cusum', 'CUSUM'], ['p', 'P 控制图'], ['c', 'C 控制图'],
    ];
    for (const [spcType, title] of expected) {
      useApp.setState({ spcType });
      const report = buildActiveAnalysisReport();
      expect(report?.kind).toBe('spc');
      expect(report?.title).toContain(title);
      expect(report?.charts.length).toBeGreaterThan(0);
    }
  });

  it('P/C 报告保留逐点原始计数，可复算比例与控制限', () => {
    useApp.setState({ page: 'spc', spcType: 'p' });
    const p = buildActiveAnalysisReport();
    const pRaw = p?.tables.find((table) => table.title.includes('原始计数'));
    expect(pRaw?.headers).toEqual(['样本', '不合格品数', '检验数', '不良率', 'LCL', 'UCL']);
    expect(pRaw?.rows.length).toBeGreaterThan(0);

    useApp.setState({ spcType: 'c' });
    const c = buildActiveAnalysisReport();
    expect(c?.tables.find((table) => table.title.includes('原始计数'))?.headers).toEqual(['单位', '缺陷数']);
  });

  it('长表 SPC 专项保留真实子组 ID，不用顺序号覆盖批次标签', () => {
    useData.getState().importMatrix(
      'SPC长表', ['测量值'], [[10], [11], [9], [20], [19], [21]],
      [{ name: '批次', values: ['L1', 'L1', 'L1', 'L2', 'L2', 'L2'] }],
    );
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcDataLayout: 'stacked', spcValueCol: '测量值', spcSubgroupCol: '批次' });
    const report = buildActiveAnalysisReport();
    const source = report?.tables.find((table) => table.title.includes('解析子组数据'));
    expect(source?.rows.map((row) => row[0])).toEqual(['L1', 'L2']);
    expect(source?.rows.map((row) => row.slice(1))).toEqual([['10.00000000', '11.00000000', '9.00000000'], ['20.00000000', '19.00000000', '21.00000000']]);
  });

  it('单列数据在默认 Xbar-R 选择下与页面一致自动按 I-MR 导出', () => {
    useData.getState().importMatrix('单列单值', ['压入力'], [
      [1180], [1210], [1195], [1225], [1203], [1178], [1218], [1190], [1207], [1214],
    ]);
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcDataLayout: 'auto' });
    const report = buildActiveAnalysisReport();
    expect(report?.title).toContain('I-MR');
    expect(report?.summary.join(' ')).not.toContain('未运行');
    expect(report?.charts.map((chart) => chart.title).join(' ')).toContain('移动极差图');
  });

  it('分阶段 Xbar-R 报告逐段列出控制限，不混用全局限值', () => {
    useData.getState().importMatrix(
      '分阶段SPC',
      ['测量1', '测量2', '测量3'],
      [[10, 11, 9], [10.2, 10.8, 9.4], [20, 21, 19], [20.2, 20.8, 19.4]],
      [{ name: '阶段', values: ['改进前', '改进前', '改进后', '改进后'] }],
    );
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcDataLayout: 'rows', spcStageCol: '阶段' });
    const report = buildActiveAnalysisReport();
    const limits = report?.tables.find((table) => table.title === '控制限');
    expect(limits?.rows).toHaveLength(4);
    expect(limits?.rows.map((row) => row[0])).toEqual(['X̄ · 改进前', 'R · 改进前', 'X̄ · 改进后', 'R · 改进后']);
    expect(limits?.rows[0][1]).not.toEqual(limits?.rows[2][1]);
  });

  it('单点阶段的专项报告明确未运行且不生成控制图', () => {
    useData.getState().importMatrix(
      '非法阶段SPC', ['测量1', '测量2'], [[10, 11], [10, 11], [100, 101], [10, 11], [10, 11]],
      [{ name: '阶段', values: ['基线', '基线', '异常点', '改善后', '改善后'] }],
    );
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcDataLayout: 'rows', spcStageCol: '阶段' });
    const report = buildActiveAnalysisReport();
    expect(report?.title).toContain('分阶段未运行');
    expect(report?.warnings.join(' ')).toContain('只有 1 个点');
    expect(report?.charts).toHaveLength(0);
  });

  it('帕累托报告使用导入数据、累计占比和其他合并设置', () => {
    useData.getState().importPareto('柏拉图人工反馈', [
      { name: '不良A', count: 35 }, { name: '不良B', count: 15 }, { name: '不良C', count: 36 },
      { name: '不良D', count: 68 }, { name: '不良E', count: 30 }, { name: '不良F', count: 65 },
    ]);
    useApp.setState({ page: 'pareto', paretoView: 'pareto' });
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('pareto');
    expect(report?.subtitle).toContain('柏拉图人工反馈');
    expect(report?.tables.find((table) => table.title === '缺陷频数与累计贡献')?.headers).toContain('累计占比');
    expect(report?.charts[0].svg).toContain('不良D');
    expect(report?.tables.find((table) => table.title.includes('原始缺陷'))?.rows).toHaveLength(6);
  });

  it('帕累托无数据时不假装完成分析，明确选择示例后才导出并标记示例', () => {
    useData.setState({ paretoModel: null });
    useApp.setState({ page: 'pareto', paretoView: 'pareto', paretoShowDemo: false });
    const empty = buildActiveAnalysisReport();
    expect(empty?.summary.join(' ')).toContain('未运行');
    expect(empty?.charts).toHaveLength(0);

    useApp.setState({ paretoShowDemo: true });
    const demo = buildActiveAnalysisReport();
    expect(demo?.subtitle).toContain('非用户数据');
    expect(demo?.warnings.join(' ')).toContain('内置示例');
    expect(demo?.charts.length).toBe(1);
  });

  it('鱼骨图默认示例明确标注，用户编辑数据则完整导出 6M 清单', () => {
    useApp.setState({ page: 'pareto', paretoView: 'fishbone' });
    const demo = buildActiveAnalysisReport();
    expect(demo?.kind).toBe('fishbone');
    expect(demo?.warnings.join(' ')).toContain('内置“尺寸超差”示例');

    saveFishboneState({
      problem: '压装开裂',
      categories: [
        { name: '人 (Man)', causes: ['培训不足'] }, { name: '机 (Machine)', causes: ['压力波动'] },
        { name: '料 (Material)', causes: ['硬度偏高'] }, { name: '法 (Method)', causes: ['速度过快'] },
        { name: '环 (Environment)', causes: [] }, { name: '测 (Measurement)', causes: ['传感器漂移'] },
      ],
    }, false);
    const report = buildActiveAnalysisReport();
    expect(report?.subtitle).toContain('问题：压装开裂');
    expect(report?.warnings.join(' ')).not.toContain('内置');
    expect(report?.tables.find((table) => table.title.includes('6M'))?.rows).toEqual(expect.arrayContaining([
      ['人 (Man)', 1, '培训不足'], ['环 (Environment)', '—', '尚未录入'],
    ]));
    expect(report?.charts).toHaveLength(1);
  });
});
