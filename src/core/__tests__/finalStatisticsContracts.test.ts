import { describe, expect, it } from 'vitest';
import {
  detectFactorial,
  detectGeneralFactorial,
  generateFactorialDesign,
  generateFractionalFactorialDesign,
  generateGeneralFactorialDesign,
  validateDoeFactorNames,
} from '../doe';
import { computeGageRR, type GageObservation } from '../gage';
import { linearRegression } from '../regression';

describe('DOE 因子名单一核心契约', () => {
  const factorValues = [
    [-1, 1, -1, 1, -1, 1, -1, 1],
    [-1, -1, 1, 1, -1, -1, 1, 1],
    [-1, -1, -1, -1, 1, 1, 1, 1],
  ];
  const response = [1, 2, 3, 4, 5, 6, 7, 8];

  it.each(['A×B', 'Block', '区组', '点类型', 'DOE拟合值', 'Fits1'])(
    '创建与分析共同拒绝结构/保留名 %s',
    (badName) => {
      const names = ['A', 'B', badName];
      const validation = validateDoeFactorNames(names);
      expect(validation.ok).toBe(false);
      if (!validation.ok) expect(validation.reason).toMatch(/保留|交互项/);

      const detected = detectFactorial(
        names.map((name, index) => ({ name, values: factorValues[index] })),
        response,
      );
      expect(detected.ok).toBe(false);
      if (!detected.ok) expect(detected.reason).toMatch(/保留|交互项/);

      const general = detectGeneralFactorial(
        names.map((name, index) => ({ name, values: factorValues[index] })),
        response,
      );
      expect(general.ok).toBe(false);

      const twoLevelDefs = names.map((name) => ({ name, low: 0, high: 1 }));
      expect(() => generateFactorialDesign(twoLevelDefs)).toThrow(/保留|交互项/);
      expect(() => generateFractionalFactorialDesign(twoLevelDefs, 1)).toThrow(/保留|交互项/);
      expect(() => generateGeneralFactorialDesign(
        names.map((name) => ({ name, levels: [0, 1, 2] })),
      )).toThrow(/保留|交互项/);
    },
  );

  it('合法的 3 因子创建后不会在分析端静默少因子', () => {
    const names = ['温度', '压力', '时间'];
    const generated = generateFactorialDesign(names.map((name) => ({ name, low: 0, high: 1 })));
    expect(generated.colNames).toEqual(['标准序', '运行序', '区组', ...names, '响应(待录入)']);
    const detected = detectFactorial(
      names.map((name, index) => ({ name, values: factorValues[index] })),
      response,
    );
    expect(detected.ok).toBe(true);
    if (detected.ok) expect(detected.design.factorNames).toEqual(names);
  });
});

describe('Gage 微小真实平方效应', () => {
  const study = (scale: number): GageObservation[] => {
    const out: GageObservation[] = [];
    for (let part = 0; part < 5; part++) {
      for (let operator = 0; operator < 2; operator++) {
        for (let trial = 0; trial < 3; trial++) {
          const interaction = (part % 2 === 0 ? 1 : -1) * (operator === 0 ? 1 : -1) * 1e-3;
          const repeat = (((part * 7 + operator * 3 + trial) % 5) - 2) * 4e-4;
          out.push({ part, operator, trial, value: (1000 + part * 1e4 + interaction + repeat) * scale });
        }
      }
    }
    return out;
  };

  it('保留交互且 ndc 有限，换单位不改变结论', () => {
    const base = computeGageRR(study(1), null);
    expect(base.interaction!.fStat).toBeCloseTo(13.0357, 3);
    expect(base.interaction!.retained).toBe(true);
    expect(Number.isFinite(base.ndc)).toBe(true);
    for (const scale of [1e-3, 1e3]) {
      const converted = computeGageRR(study(scale), null);
      expect(converted.interaction!.fStat).toBeCloseTo(base.interaction!.fStat, 4);
      expect(converted.interaction!.pValue).toBeCloseTo(base.interaction!.pValue, 5);
      expect(converted.interaction!.retained).toBe(base.interaction!.retained);
      expect(converted.ndc).toBe(base.ndc);
    }
  });

  it('仅原始单元格证明的结构零返回 ndc=Infinity', () => {
    const zero = study(1).map((observation) => ({
      ...observation,
      value: 1000 + observation.part * 1e4,
    }));
    const result = computeGageRR(zero, null);
    expect(result.interaction).toMatchObject({ fStat: 0, pValue: 1, retained: false });
    expect(result.ndc).toBe(Infinity);
    expect(result.components.find((component) => component.key === 'grr')!.variance).toBe(0);
  });
});

describe('回归单位还原下溢', () => {
  it('归一化斜率非零但原单位斜率下溢时明确拒绝', () => {
    expect(() => linearRegression(
      [1e100, 2e100, 3e100],
      [1e-300, 2e-300, 3e-300],
    )).toThrow(/斜率.*下溢.*缩放.*单位/);
  });

  it('斜率为零但非零标准误在原单位下溢时明确拒绝', () => {
    expect(() => linearRegression(
      [0, 1e100, 2e100],
      [1e-300, 2e-300, 1e-300],
    )).toThrow(/标准误.*下溢.*缩放.*单位/);
  });
});
