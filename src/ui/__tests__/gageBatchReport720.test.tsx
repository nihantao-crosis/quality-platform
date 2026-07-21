/** @vitest-environment jsdom */
/** 人工审核720：MSA 多响应页面/专项报告同源与失败隔离。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import {
  assessGage,
  computeGageRR,
  nf,
  prepareGageStudy,
} from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { GageRR } from '../pages/SimplePages';
import { chartTokens } from '../tokens';

interface MultiResponseFixture {
  columns: string[];
  rows: number[][];
  operators: string[];
}

function multiResponseFixture(extraResponses = 0): MultiResponseFixture {
  const baseResponses = ['响应A', '响应B', '响应坏'];
  const extras = Array.from({ length: extraResponses }, (_, index) => `响应${index + 4}`);
  const columns = ['部件', ...baseResponses, ...extras];
  const rows: number[][] = [];
  const operators: string[] = [];
  let rowIndex = 0;
  for (const [operatorIndex, operator] of ['张', '李'].entries()) {
    for (const part of [1, 2, 3]) {
      for (let trial = 0; trial < 2; trial++) {
        const responseA = 10 + part * 0.5 + operatorIndex * 0.02 + trial * 0.01;
        const responseB = 100 + part * 2 + operatorIndex * 0.3 + trial * 0.1;
        const responseBad = rowIndex === 0 ? Number.NaN : 20 + part + operatorIndex * 0.1 + trial * 0.05;
        rows.push([
          part,
          responseA,
          responseB,
          responseBad,
          ...extras.map((_, index) => 200 + index * 10 + part * (index + 1) + operatorIndex * 0.2 + trial * 0.03),
        ]);
        operators.push(operator);
        rowIndex++;
      }
    }
  }
  return { columns, rows, operators };
}

function importFixture(extraResponses = 0) {
  const fixture = multiResponseFixture(extraResponses);
  useData.getState().importMatrix(
    'MSA多响应.csv',
    fixture.columns,
    fixture.rows,
    [{ name: '测试人', values: fixture.operators }],
  );
  return fixture;
}

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'gagerr',
    gageUseReal: true,
    gageValueName: '响应A',
    gagePartName: '部件',
    gageOperatorName: '测试人',
    gageTolMode: 'width',
    gageTolValue: 10,
    gageStandard: 'factory',
    gageBatchCols: ['响应A', '响应B', '响应坏'],
    gageTolByCol: {
      '响应A': { mode: 'width', value: 10 },
      '响应B': { mode: 'width', value: 50 },
      '响应坏': { mode: 'none', value: null },
    },
    lsl: 0,
    usl: 200,
    lslOn: true,
    uslOn: true,
  });
});

afterEach(cleanup);

describe('MSA 批量响应专项报告(720)', () => {
  it('页面与报告逐列同源，报告补齐方差/6×SD与工厂+AIAG双判定', () => {
    importFixture();
    // 导入新工作表会按设计清空旧列名选择；用户明确选择当前响应后再查看完整图形报告。
    useApp.setState({
      gageValueName: '响应A', gagePartName: '部件', gageOperatorName: '测试人',
      gageTolMode: 'width', gageTolValue: 10,
      gageBatchCols: ['响应A', '响应B', '响应坏'],
      gageTolByCol: {
        '响应A': { mode: 'width', value: 10 },
        '响应B': { mode: 'width', value: 50 },
        '响应坏': { mode: 'none', value: null },
      },
    });
    const page = render(createElement(GageRR, { T: chartTokens('经典', true) })).container;
    const report = buildActiveAnalysisReport();
    const table = report?.tables.find((item) => item.title.startsWith('批量 GRR 逐响应明细'));

    expect(table?.headers).toEqual([
      '测量列', 'GRR 方差分量', 'GRR 标准差(SD)', '研究变异(6×SD)',
      '%研究变异', '%公差', 'ndc', '工厂判定', 'AIAG 对照', '计算状态',
    ]);
    expect(table?.rows).toHaveLength(3);

    const rowA = table!.rows.find((row) => row[0] === '响应A')!;
    const prepared = prepareGageStudy(useData.getState().model, useData.getState().textCols, {
      valueColumn: '响应A', partColumn: '部件', operatorColumn: '测试人',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const expected = computeGageRR(prepared.study.observations, { mode: 'width', value: 10 });
    const grr = expected.components.find((component) => component.key === 'grr')!;
    expect(rowA).toEqual([
      '响应A',
      nf(grr.variance, 8),
      nf(grr.sd, 6),
      nf(grr.studyVar, 6),
      nf(grr.pctStudyVar, 2),
      nf(grr.pctTolerance!, 2),
      String(expected.ndc),
      assessGage(expected, 'factory').label,
      assessGage(expected, 'aiag').label,
      '已计算',
    ]);

    // 页面批量行与报告的共同指标必须来自同一次逐列计算。
    const pageRowA = [...page.querySelectorAll('tr')].find((row) => row.querySelector('td')?.textContent === '响应A');
    const pageText = pageRowA?.textContent ?? '';
    for (const value of rowA.slice(4, 9)) expect(pageText).toContain(String(value));
    expect(report?.charts[0].note).toContain('仅对应当前测量响应“响应A”');
  });

  it('一列失败只标记该列；即使当前响应失败，其他选中响应的明细也不丢失', () => {
    importFixture();
    useApp.setState({
      gageValueName: '响应坏', gagePartName: '部件', gageOperatorName: '测试人',
      gageTolMode: 'none', gageTolValue: null,
      gageBatchCols: ['响应A', '响应B', '响应坏'],
      gageTolByCol: {
        '响应A': { mode: 'width', value: 10 },
        '响应B': { mode: 'width', value: 50 },
        '响应坏': { mode: 'none', value: null },
      },
    });
    const report = buildActiveAnalysisReport();
    expect(report?.summary.join(' ')).toContain('未运行');
    const table = report?.tables.find((item) => item.title.startsWith('批量 GRR 逐响应明细'));
    expect(table?.rows).toHaveLength(3);
    const statuses = Object.fromEntries(table!.rows.map((row) => [row[0], row[9]]));
    expect(statuses['响应A']).toBe('已计算');
    expect(statuses['响应B']).toBe('已计算');
    expect(String(statuses['响应坏'])).toContain('未计算');
  });

  it('审计报告不截断用户已选响应，超过 20 列仍逐列输出', () => {
    const fixture = importFixture(18); // 3 个基础响应 + 18 = 21
    const selected = fixture.columns.slice(1);
    useApp.setState({
      gageBatchCols: selected,
      gageTolByCol: Object.fromEntries(selected.map((name) => [name, { mode: 'none' as const, value: null }])),
    });
    const table = buildActiveAnalysisReport()?.tables.find((item) => item.title.startsWith('批量 GRR 逐响应明细'));
    expect(table?.rows).toHaveLength(21);
    expect(table?.rows.map((row) => row[0])).toEqual(selected);
  });

  it('页面/报告/持久化共用 64 列上限，超限选择不造成前列公差静默丢失', () => {
    const fixture = importFixture(63); // 66 个响应候选
    const selected = fixture.columns.slice(1);
    useApp.setState({ gagePartName: '部件', gageOperatorName: '测试人' });
    useApp.getState().setGageBatchCols(selected);
    const effectiveSelected = useApp.getState().gageBatchCols ?? [];
    expect(effectiveSelected).toHaveLength(64);
    useApp.setState({
      gageTolMode: 'width', gageTolValue: 10,
      gageTolByCol: Object.fromEntries(effectiveSelected.map((name) => [name, { mode: 'width' as const, value: 10 }])),
    });
    const table = buildActiveAnalysisReport()?.tables.find((item) => item.title.startsWith('批量 GRR 逐响应明细'));
    expect(table?.rows).toHaveLength(64);
    expect(table?.rows.map((row) => row[0])).toEqual(effectiveSelected);
  });
});
