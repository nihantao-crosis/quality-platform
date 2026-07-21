/** @vitest-environment jsdom */
/** 批次716-R3 P1-2:GageRR 页默认角色用 recommendGageRoles 预填(工厂列序不再推荐反),
 * 推荐只预填、不覆盖用户手选;推荐生效时显示「自动推荐:…,请确认」小字。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { GageRR } from '../pages/SimplePages';
import { chartTokens } from '../tokens';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'gagerr', gageUseReal: true,
    gageValueName: null, gagePartName: null, gageOperatorName: null,
    lsl: 9, usl: 12, lslOn: true, uslOn: true,
  });
});

/** 工厂导入列序「部件、测试人、螺钉高度」(旧默认会把第一数值列「部件」当测量) */
function importFactory(operators: string[], parts: number, repeats: number) {
  const rows: number[][] = [];
  const operatorValues: string[] = [];
  for (const operator of operators) {
    for (let part = 1; part <= parts; part++) {
      for (let trial = 0; trial < repeats; trial++) {
        rows.push([part, 10 + part * 0.1 + trial * 0.01 + (operator === '李四' ? 0.02 : 0)]);
        operatorValues.push(operator);
      }
    }
  }
  useData.getState().importMatrix('工厂GRR.csv', ['部件', '螺钉高度'], rows,
    [{ name: '测试人', values: operatorValues, sourceIndex: 1 }]);
}

function importAllCategoryIds() {
  const rows: number[][] = [];
  for (const operator of [1, 2]) {
    for (const part of [1, 2, 3]) {
      for (let trial = 0; trial < 2; trial++) rows.push([part, operator, 10 + part]);
    }
  }
  useData.getState().importMatrix('全ID列.csv', ['部件ID', '操作员ID', '批次ID'], rows);
}

const renderPage = () => render(createElement(GageRR, { T: chartTokens('经典', true) })).container;

describe('GageRR 默认角色推荐(716-R3 P1-2)', () => {
  it('Codex 场景 2 操作员×3 部件×2 次:未手选任何角色也能按推荐直接算出 GRR,并显示推荐依据', () => {
    importFactory(['张三', '李四'], 3, 2);
    const container = renderPage();
    const text = container.textContent ?? '';
    // 推荐生效 → 真实数据直接计算,不再因「部件被当测量列」而报错
    expect(text).toContain('导入数据');
    expect(text).toContain('合计 Gage R&R');
    expect(text).not.toContain('Gage R&R 尚未运行');
    // 推荐处小字:自动推荐 + 依据摘要 + 请确认
    expect(text).toContain('自动推荐');
    expect(text).toContain('请确认');
    expect(text).toContain('螺钉高度');
    expect(text).toContain('测试人');
  });

  it('工厂 30 行单操作员场景:推荐 value=螺钉高度/part=部件/operator=测试人,按单因子退化模型直接计算(v1.40)', () => {
    importFactory(['邹德玉'], 10, 3);
    const container = renderPage();
    const text = container.textContent ?? '';
    // 推荐正确 + 单操作员合法:不再阻断,GRR=重复性、无再现性行
    expect(text).not.toContain('Gage R&R 尚未运行');
    expect(text).toContain('合计 Gage R&R');
    expect(text).toContain('单操作员研究');
    expect(text).toContain('不估计再现性');
    expect(text).toContain('自动推荐');
    expect(text).toContain('请确认');
  });

  it('用户手选过的角色绝不被推荐覆盖:显式三选后不再显示「自动推荐」,并按手选口径计算', () => {
    importFactory(['张三', '李四'], 3, 2);
    // 用户故意把部件/操作员对调(2 部件×3 操作员口径,交叉仍平衡,可计算)
    useApp.setState({ gageValueName: '螺钉高度', gagePartName: '测试人', gageOperatorName: '部件' });
    const container = renderPage();
    const text = container.textContent ?? '';
    expect(text).not.toContain('自动推荐');
    expect(text).toContain('合计 Gage R&R');
    // 下拉显示的是手选值而非推荐值:部件下拉=测试人,操作员下拉=部件
    const selects = [...container.querySelectorAll('select')];
    expect(selects).toHaveLength(4); // 测量/部件/操作员 + 过程公差口径(v1.40)

    const selectedText = (i: number) => selects[i].selectedOptions[0]?.textContent ?? '';
    expect(selectedText(0)).toBe('螺钉高度');
    expect(selectedText(1)).toContain('测试人');
    expect(selectedText(2)).toContain('部件');
  });

  it('部分手选:仅测量列手选时,部件/操作员仍用推荐预填并提示确认', () => {
    importFactory(['张三', '李四'], 3, 2);
    useApp.setState({ gageValueName: '螺钉高度' });
    const container = renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('合计 Gage R&R');
    expect(text).toContain('自动推荐');
    const selects = [...container.querySelectorAll('select')];
    const selectedText = (i: number) => selects[i].selectedOptions[0]?.textContent ?? '';
    expect(selectedText(1)).toContain('部件');
    expect(selectedText(2)).toContain('测试人');
  });

  it('全小整数/类别 ID 列不自动把第一列当测量值，UI 要求显式选择', () => {
    importAllCategoryIds();
    const container = renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('请选择测量列');
    expect(text).toContain('不会默认使用第一列');
    expect(text).toContain('Gage R&R 尚未运行');
    expect(text).not.toContain('合计 Gage R&R');

    const valueSelect = container.querySelector('select[aria-label="测量列"]') as HTMLSelectElement;
    expect(valueSelect).not.toBeNull();
    expect(valueSelect.value).toBe('-1');
    expect(valueSelect.selectedOptions[0]?.textContent).toBe('请选择测量列');

    // 手动选择后才写入角色状态；这也证明小整数测量仍可由用户明确指定。
    fireEvent.change(valueSelect, { target: { value: '2' } });
    expect(useApp.getState().gageValueName).toBe('批次ID');
    expect(valueSelect.value).toBe('2');
    expect(container.textContent).not.toContain('不会默认使用第一列');
  });
});
