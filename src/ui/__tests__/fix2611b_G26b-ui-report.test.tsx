/**
 * fix2611b G26b-ui-report:第 9 批复审 P3 收尾(界面与专项报告)。
 * B1 量具图具名 group(图内表头/读数对读屏可读);B2 描述性统计箱线图具体名称;
 * B3 分组箱线图窗口截断时名称以图表类型开头;B4 能力专项报告术语同源;
 * B5 DOE 别名/可估计性封顶 + 分类建议 + 关系列中文;B7 README 措辞。
 * 全部走真实生产函数(真实引擎产出的设计/别名、真实页面组件、真实报告构建)。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFOUNDED_NOTE_TERM_CAP, CONTROL_CONSTANTS, computeGagePanelData, computeGageRR, GAGE_TOLERANCE,
  gageStudyData, generateFractionalFactorialDesign, type GageObservation,
} from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { CAPABILITY_TERMS } from '../../platform/reportLabels';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import {
  GageByOperatorPanel, GageByPartPanel, GageInteractionPanel, GageRPanel, GageReportFigure, GageXbarPanel,
  gageBarCategories,
} from '../charts/gagePanels';
import { BoxPlot } from '../charts/misc';
import { Doe } from '../pages/Doe';
import { Summary } from '../pages/Summary';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard', activeVar: '',
    doeTab: 'analyze', doeFactorCols: null, doeRespCol: null, doeModelTerms: null, doeIncludeCurvature: true,
  });
});

describe('B1 量具图:具名 group,图内表头与读数对读屏可读', () => {
  const observations: GageObservation[] = gageStudyData();
  const result = computeGageRR(observations, { mode: 'width', value: GAGE_TOLERANCE });
  const panel = computeGagePanelData(observations, CONTROL_CONSTANTS[result.trialCount] ?? null);
  const partLabels = Array.from({ length: panel.partCount }, (_, i) => `P${i + 1}`);
  const operatorLabels = Array.from({ length: panel.operatorCount }, (_, i) => `O${i + 1}`);
  const props = { T, panel, partLabels, operatorLabels };

  it('GageReportFigure:role=group + 具体名称,表头文字不在 role=img 子树内', () => {
    const { container } = render(createElement(GageReportFigure, {
      ...props, cats: gageBarCategories(result), valueName: '直径', gaugeName: '卡尺-07', studyDate: '2026-11-14',
    }));
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('group');
    expect(svg.getAttribute('aria-label')).toBe('量具研究 · 直径 的量具 R&R（方差分析）报告');
    expect(container.querySelector('[role="img"]'), '量具图任何层级都不得被压成 role=img').toBeNull();
    const header = [...container.querySelectorAll('text')].find((node) => node.textContent === '量具名称：卡尺-07');
    expect(header, '表头文字未渲染').toBeTruthy();
    expect(header!.closest('[role="img"]')).toBeNull();
    expect(header!.closest('[role="group"]')).toBe(svg);
  });

  it('5 个独立面板同样是具名 group,UCL/中心线读数可读', () => {
    const panels: Array<[string, ReturnType<typeof createElement>]> = [
      ['量具研究 · 极差（R）控制图', createElement(GageRPanel, props)],
      ['量具研究 · 均值（X̄）控制图', createElement(GageXbarPanel, props)],
      ['量具研究 · 按部件的测量值', createElement(GageByPartPanel, props)],
      ['量具研究 · 按操作员的测量值', createElement(GageByOperatorPanel, props)],
      ['量具研究 · 部件 × 操作员交互作用', createElement(GageInteractionPanel, props)],
    ];
    for (const [name, element] of panels) {
      cleanup();
      const { container } = render(element);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('role'), name).toBe('group');
      expect(svg.getAttribute('aria-label'), name).toBe(name);
      expect(container.querySelector('[role="img"]'), name).toBeNull();
      expect(svg.querySelectorAll('text').length, `${name} 无图内文字`).toBeGreaterThan(0);
    }
  });
});

describe('B2 描述性统计页箱线图具体名称', () => {
  it('常规数据(无离群抽样):箱线图带「箱线图 · 列名」名称,刻度文字可读', () => {
    useData.getState().importMatrix('直径.csv', ['直径'], [[1], [2], [3], [4], [5], [6], [7]]);
    useApp.setState({ page: 'summary', activeVar: '直径' });
    const { container } = render(createElement(Summary, { T }));
    const box = [...container.querySelectorAll('svg')].find((svg) => (svg.getAttribute('viewBox') ?? '') === '0 0 640 74');
    expect(box, '未找到箱线图').toBeTruthy();
    expect(box!.getAttribute('aria-label')).toBe('箱线图 · 直径');
    expect(box!.getAttribute('role')).toBe('group');
  });

  it('离群观测被抽样时仍以「箱线图 · 列名」开头并写明总数', () => {
    const data = [...Array.from({ length: 3000 }, () => 10), ...Array.from({ length: 900 }, (_, i) => 5000 + i)];
    useData.getState().importMatrix('离群.csv', ['测量'], data.map((value) => [value]));
    useApp.setState({ page: 'summary', activeVar: '测量' });
    const { container } = render(createElement(Summary, { T }));
    const box = [...container.querySelectorAll('svg')].find((svg) => (svg.getAttribute('viewBox') ?? '') === '0 0 640 74');
    expect(box!.getAttribute('aria-label')).toMatch(/^箱线图 · 测量；共 900 个离群观测，图上抽样显示 \d+ 个$/);
  });
});

describe('B3 分组箱线图窗口截断时名称以图表类型开头', () => {
  it('60 组只显示 12 组:名称为「箱线图；显示第 1–12 组…」,与个体值图/区间图同形制', () => {
    const groups = Array.from({ length: 60 }, (_, i) => ({ name: `G${i + 1}`, vals: [1, 2, 3, 4 + i] }));
    const { container } = render(createElement(BoxPlot, { T, groups }));
    const label = container.querySelector('svg')!.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^箱线图；显示第 1–12 组，共 60 组；/);
  });

  it('离群抽样 + 窗口截断同时出现时,只在开头出现一次图表类型', () => {
    const big = [...Array.from({ length: 3000 }, () => 10), ...Array.from({ length: 900 }, (_, i) => 5000 + i)];
    const groups = Array.from({ length: 13 }, (_, i) => ({ name: `G${i + 1}`, vals: i === 0 ? big : [1, 2, 3] }));
    const { container } = render(createElement(BoxPlot, { T, groups }));
    const label = container.querySelector('svg')!.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^箱线图；/);
    expect(label.match(/箱线图/g)).toHaveLength(1);
    expect(label).toContain('G1 共 900 个离群观测');
    expect(label).toContain('显示第 1–12 组，共 13 组');
  });
});

describe('B4 能力专项报告术语与通用导出同源', () => {
  it('「能力与性能指标」表头写 CAPABILITY_TERMS.sigmaLevel(西格玛水平),不写「σ水平」', () => {
    useApp.setState({ page: 'capability' });
    const report = buildActiveAnalysisReport();
    const table = report?.tables.find((entry) => entry.title === '能力与性能指标');
    expect(table, '能力专项报告缺少能力指标表').toBeTruthy();
    expect(table!.headers).toContain(CAPABILITY_TERMS.sigmaLevel);
    expect(table!.headers).not.toContain('σ水平');
  });
});

/** 2^(7−4) 分式设计(真实生成器),5 因子以上默认主效应 + 二因子交互入模 → 21 个交互项与主效应别名。 */
function importFraction74() {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const design = generateFractionalFactorialDesign(names.map((name) => ({ name, low: -1, high: 1 })), 4, { randomize: false });
  const colNames = design.colNames.map((name, index) => index === design.responseCol ? 'Y' : name);
  const rows = design.rows.map((row, r) => row.map((value, index) => index === design.responseCol ? 10 + ((r * 37) % 11) : value));
  useData.getState().importMatrix('DOE2^(7-4)', colNames, rows, design.textCols);
  useApp.setState({ page: 'doe', doeTab: 'analyze', doeFactorCols: names, doeRespCol: 'Y', doeModelTerms: null });
}

function aliasRow(container: HTMLElement): string {
  const row = [...container.querySelectorAll('div')]
    .find((node) => node.firstElementChild?.tagName === 'B' && node.firstElementChild.textContent === '别名/可估计性：');
  expect(row, '未找到「别名/可估计性」行').toBeTruthy();
  return row!.textContent ?? '';
}

describe('B5 DOE 别名/可估计性:封顶、分类建议、关系列中文', () => {
  it('2^(7−4) 页面别名行最多列 6 项并写明总数,建议与结论同类(生成元别名 → 提高分辨率/折叠)', () => {
    importFraction74();
    const { container } = render(createElement(Doe, { T }));
    const text = aliasRow(container);
    expect((text.match(/ = /g) ?? []).length).toBeLessThanOrEqual(CONFOUNDED_NOTE_TERM_CAP);
    expect(text).toContain('等共 21 项');
    expect(text).toContain('提高设计分辨率或折叠设计');
    expect(text, '生成元别名不得一律建议「增加运行」').not.toContain('可增加运行或减少模型项解除别名');
    expect(text).not.toContain('区组');
  });

  it('专项报告:剔除提示同样封顶;别名表关系列为中文(相同/相反),不出现英文原值', () => {
    importFraction74();
    const report = buildActiveAnalysisReport();
    const warning = report?.warnings.find((entry) => entry.includes('别名'));
    expect(warning).toBeTruthy();
    expect((warning!.match(/ = /g) ?? []).length).toBeLessThanOrEqual(CONFOUNDED_NOTE_TERM_CAP);
    expect(warning).toContain('等共 21 项');
    expect(warning).toContain('提高设计分辨率或折叠设计');
    const table = report?.tables.find((entry) => entry.title === '别名与可估计性');
    expect(table?.rows).toHaveLength(21);
    const relations = new Set(table!.rows.map((row) => String(row[2])));
    for (const relation of relations) expect(['相同', '相反']).toContain(relation);
    expect(JSON.stringify(report)).not.toMatch(/"(same|opposite|linear-dependent)"/);
  });

  it('所选模型项全部与区组混杂:报告与页面同源,关系列标「与区组混杂」,建议减少区组数/增加仿行', () => {
    const factorA = [-1, 1, -1, 1, -1, 1, -1, 1];
    const factorB = [-1, -1, 1, 1, -1, -1, 1, 1];
    useData.getState().importMatrix(
      'DOE退化模型', ['区组', 'A', 'B', 'Y'],
      factorA.map((value, row) => [value < 0 ? 1 : 2, value, factorB[row], 50 + 5 * factorB[row] + row * 0.1]),
    );
    useApp.setState({ page: 'doe', doeFactorCols: ['A', 'B'], doeRespCol: 'Y', doeModelTerms: ['A'], doeIncludeCurvature: false });
    const report = buildActiveAnalysisReport();
    const reportText = [...(report?.summary ?? []), ...(report?.warnings ?? [])].join('\n');
    expect(reportText).toContain('所选模型项全部不可独立估计');
    expect(reportText).toContain('以上均与区组混杂');
    expect(reportText).toContain('减少区组数或增加仿行');
    const pageText = render(createElement(Doe, { T })).container.textContent ?? '';
    expect(pageText).toContain('以上均与区组混杂');
    expect(pageText, '页面与报告同源').toContain(reportText.split('\n').find((line) => line.includes('可估计性诊断'))!.replace(/^.*?(可估计性诊断：)/, '$1'));
    expect(pageText).toContain('减少区组数或增加仿行');
  });
});

describe('B7 README「2026-11 遗留项整改要点」措辞与事实一致', () => {
  const readme = readFileSync(resolve(__dirname, '../../../README.md'), 'utf8');
  const start = readme.indexOf('### 2026-11 遗留项整改要点');
  const section = readme.slice(start, readme.indexOf('\n## ', start));

  it('小节开头如实说明本批处理范围,「仍未处理」指向附录 F', () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toContain('本批处理了其中的发版门禁、数值稳定、导出与界面类事项');
    expect(section).not.toContain('本批修掉其中可由代码解决的部分');
    const pending = section.split('\n').find((line) => line.startsWith('- **仍未处理**'));
    expect(pending).toMatch(/附录 F/);
  });

  it('保存项目入口列全四处(含壳层错误页),读屏名称不再虚构「统计图表」兜底名', () => {
    expect(section).not.toContain('三个入口');
    expect(section).toMatch(/工具栏、快捷键、菜单与.*「保存项目文件」按钮四个入口/);
    expect(section).not.toContain('不再统一叫「统计图表」');
    expect(section).toContain('此前多数图表没有读屏名称');
  });
});
