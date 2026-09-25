import { describe, expect, it } from 'vitest';
import { buildAnovaGroups, buildAnovaInput, oneWayAnova } from '../anova';

const names = ['Dose', 'Y'];
const rows = [[1, 5], [1, 9], [2, 6], [2, 10]];
const textCols = [{ name: '设备', values: ['A', 'B', 'A', 'B'] }];

describe('F-01 ANOVA 实际角色与分组同源', () => {
  it('仅切换模式时旧 Dose 选择回落实际文本设备列，标签和 P 同步变化', () => {
    const numeric = buildAnovaInput('numfactor', names, rows, textCols, 'Y', 'Dose');
    const stacked = buildAnovaInput('stacked', names, rows, textCols, 'Y', 'Dose');
    expect(numeric.roles).toMatchObject({ responseName: 'Y', factorName: 'Dose', factorIdx: 0 });
    expect(stacked.roles).toMatchObject({ responseName: 'Y', factorName: '设备', factorTextIdx: 0 });
    expect(numeric.groups?.map((group) => group.vals)).toEqual([[5, 9], [6, 10]]);
    expect(stacked.groups?.map((group) => group.vals)).toEqual([[5, 6], [9, 10]]);
    expect(oneWayAnova(numeric.groups!.map((group) => group.vals))).toMatchObject({ fStat: 0.125 });
    expect(oneWayAnova(numeric.groups!.map((group) => group.vals)).pValue).toBeCloseTo(0.757464374963, 10);
    expect(oneWayAnova(stacked.groups!.map((group) => group.vals))).toMatchObject({ fStat: 32 });
    expect(oneWayAnova(stacked.groups!.map((group) => group.vals)).pValue).toBeCloseTo(0.029857499855, 10);
    expect(buildAnovaGroups('stacked', names, rows, textCols, 'Y', 'Dose')).toEqual(stacked.groups);
  });

  it('失效响应、被排除的 DOE 文本列和显式有效文本选择都按实际列返回标签', () => {
    const texts = [
      { name: '点类型', values: ['因子点', '因子点', '中心点', '中心点'] },
      ...textCols,
      { name: '批次', values: ['L1', 'L1', 'L2', 'L2'] },
    ];
    const fallback = buildAnovaInput('stacked', names, rows, texts, '已删除响应', '点类型');
    expect(fallback.roles).toMatchObject({ responseName: 'Y', factorName: '设备', factorTextIdx: 0 });
    expect(fallback.groups?.map((group) => group.name)).toEqual(['A', 'B']);
    const explicit = buildAnovaInput('stacked', names, rows, texts, 'Y', '批次');
    expect(explicit.roles).toMatchObject({ factorName: '批次', factorTextIdx: 1 });
    expect(explicit.groups?.map((group) => group.vals)).toEqual([[5, 9], [6, 10]]);
  });

  it('宽表角色为测量列/测量值；有效但不能重复分组的数值选择不被静默替换', () => {
    const wide = buildAnovaInput('wide', names, rows, textCols, 'Y', 'Dose');
    expect(wide.roles).toMatchObject({ responseName: '测量值', factorName: '测量列' });
    expect(wide.groups?.map((group) => group.name)).toEqual(names);
    const invalid = buildAnovaInput('numfactor', ['Dose', 'Unique', 'Y'], rows.map((row, i) => [row[0], i, row[1]]), textCols, 'Y', 'Unique');
    expect(invalid.roles.factorName).toBe('Unique');
    expect(invalid.groups).toBeNull();
  });
});
