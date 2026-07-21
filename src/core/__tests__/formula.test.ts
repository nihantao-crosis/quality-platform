/** 公式引擎:算术/优先级/列引用/函数/聚合/错误。 */
import { describe, it, expect } from 'vitest';
import { evalFormula, FormulaError, type FormulaCtx } from '../formula';

const ctx = (): FormulaCtx => ({
  // C1 = [1,2,3,4], C2 = [10,20,30,40]
  columns: [[1, 2, 3, 4], [10, 20, 30, 40]],
  colNames: ['直径', '厚度 (mm)'],
  rowCount: 4,
});

const ev = (expr: string) => evalFormula(expr, ctx()).values;

describe('算术与优先级', () => {
  it('常量加法广播到每行', () => {
    expect(ev('1 + 2')).toEqual([3, 3, 3, 3]);
  });
  it('乘除高于加减', () => {
    expect(ev('1 + 2 * 3')).toEqual([7, 7, 7, 7]);
  });
  it('括号改变优先级', () => {
    expect(ev('(1 + 2) * 3')).toEqual([9, 9, 9, 9]);
  });
  it('幂右结合', () => {
    // 2^3^2 = 2^(3^2) = 2^9 = 512
    expect(ev('2 ^ 3 ^ 2')).toEqual([512, 512, 512, 512]);
  });
  it('一元负号', () => {
    expect(ev('-C1')).toEqual([-1, -2, -3, -4]);
  });
  it('× ÷ 符号被规范化', () => {
    expect(ev('C1 × 2')).toEqual([2, 4, 6, 8]);
    expect(ev('C2 ÷ 10')).toEqual([1, 2, 3, 4]);
  });
});

describe('列引用', () => {
  it('C1/C2 逐行取值', () => {
    expect(ev('C1 + C2')).toEqual([11, 22, 33, 44]);
  });
  it('列均值 (C1+C2)/2', () => {
    expect(ev('(C1 + C2) / 2')).toEqual([5.5, 11, 16.5, 22]);
  });
  it('引号引用列名(含空格/中文)', () => {
    expect(ev("'厚度 (mm)' - '直径'")).toEqual([9, 18, 27, 36]);
  });
  it('记录引用到的列索引', () => {
    expect(evalFormula('C2 - C1', ctx()).refs).toEqual([0, 1]);
  });
});

describe('逐元素函数', () => {
  it('sqrt', () => {
    expect(evalFormula('sqrt(C1)', { columns: [[1, 4, 9, 16]], colNames: ['x'], rowCount: 4 }).values).toEqual([1, 2, 3, 4]);
  });
  it('abs 与 sq', () => {
    expect(ev('abs(-C1)')).toEqual([1, 2, 3, 4]);
    expect(ev('sq(C1)')).toEqual([1, 4, 9, 16]);
  });
  it('ln(e) = 1', () => {
    expect(ev('ln(e)')[0]).toBeCloseTo(1, 12);
  });
});

describe('聚合函数(广播为常量)', () => {
  it('mean(C1)=2.5 广播', () => {
    expect(ev('mean(C1)')).toEqual([2.5, 2.5, 2.5, 2.5]);
  });
  it('z 分数 (C1-mean)/std', () => {
    // C1 mean=2.5, std(样本)=1.290994...
    const z = ev('(C1 - mean(C1)) / std(C1)');
    expect(z[0]).toBeCloseTo(-1.161895, 5);
    expect(z[3]).toBeCloseTo(1.161895, 5);
  });
  it('min/max/sum/range/median/n', () => {
    expect(ev('min(C1)')[0]).toBe(1);
    expect(ev('max(C1)')[0]).toBe(4);
    expect(ev('sum(C1)')[0]).toBe(10);
    expect(ev('range(C1)')[0]).toBe(3);
    expect(ev('median(C1)')[0]).toBe(2.5);
    expect(ev('n(C1)')[0]).toBe(4);
  });
  it('聚合可作用于表达式 mean(C1+C2)', () => {
    expect(ev('mean(C1 + C2)')[0]).toBe((11 + 22 + 33 + 44) / 4);
  });
  it('大基准微扰下 MEAN/STD/VAR 使用稳定样本口径且不随行序改变', () => {
    const base = 1e9;
    const low = base - 5e-6;
    const high = base + 5e-6;
    const blocked = [...Array(50).fill(low), ...Array(450).fill(high)] as number[];
    const reversed = [...blocked].reverse();
    const formulaCtx = (values: number[]): FormulaCtx => ({
      columns: [values], colNames: ['微扰'], rowCount: values.length,
    });
    const read = (name: 'mean' | 'std' | 'var', values: number[]) =>
      evalFormula(`${name}(C1)`, formulaCtx(values)).values[0];
    const expectedSd = 3.007082684410897e-6;
    expect(read('mean', blocked)).toBe(read('mean', reversed));
    expect(read('std', blocked)).toBeCloseTo(expectedSd, 15);
    expect(Math.abs(read('std', blocked) - read('std', reversed)) / expectedSd).toBeLessThan(1e-12);
    expect(read('var', blocked)).toBeCloseTo(expectedSd ** 2, 24);
    expect(Math.abs(read('var', blocked) - read('var', reversed)) / (expectedSd ** 2)).toBeLessThan(1e-12);
  });
  it('SUM 在大数相消时不因中间溢出或行序丢失有限结果', () => {
    const sum = (values: number[]) => evalFormula('sum(C1)', {
      columns: [values], colNames: ['大数'], rowCount: values.length,
    }).values[0];
    expect(sum([1e308, 1e308, -1e308])).toBe(1e308);
    expect(sum([-1e308, 1e308, 1e308])).toBe(1e308);
    expect(sum([1e308, 1, -1e308])).toBeCloseTo(1, 12);
    expect(sum([-1e308, 1, 1e308])).toBeCloseTo(1, 12);
  });
});

describe('比较与逻辑', () => {
  it('大于返回 1/0', () => {
    expect(ev('C1 > 2')).toEqual([0, 0, 1, 1]);
  });
  it('>= 与 <=', () => {
    expect(ev('C1 >= 2')).toEqual([0, 1, 1, 1]);
    expect(ev('C1 <= 2')).toEqual([1, 1, 0, 0]);
  });
  it('等于 == 与 单 = 同义', () => {
    expect(ev('C1 == 3')).toEqual([0, 0, 1, 0]);
    expect(ev('C1 = 3')).toEqual([0, 0, 1, 0]);
  });
  it('不等 <> 与 !=', () => {
    expect(ev('C1 <> 3')).toEqual([1, 1, 0, 1]);
    expect(ev('C1 != 3')).toEqual([1, 1, 0, 1]);
  });
  it('and 短路为交集', () => {
    // C1>=2 and C1<=3 → 行2,3
    expect(ev('C1 >= 2 and C1 <= 3')).toEqual([0, 1, 1, 0]);
  });
  it('or 为并集', () => {
    expect(ev('C1 < 2 or C1 > 3')).toEqual([1, 0, 0, 1]);
  });
  it('not 取反', () => {
    expect(ev('not (C1 > 2)')).toEqual([1, 1, 0, 0]);
  });
  it('比较优先级低于算术', () => {
    // C1 + 1 > 3 → (C1+1)>3 → C1>2
    expect(ev('C1 + 1 > 3')).toEqual([0, 0, 1, 1]);
  });
  it('and 优先级低于比较,or 低于 and', () => {
    // C1>1 or C1>2 and C1<2 → C1>1 or (C1>2 and C1<2) → C1>1
    expect(ev('C1 > 1 or C1 > 2 and C1 < 2')).toEqual([0, 1, 1, 1]);
  });
});

describe('错误处理', () => {
  const bad = (expr: string) => {
    try { evalFormula(expr, ctx()); return null; }
    catch (e) { return e instanceof FormulaError ? e.message : 'other'; }
  };
  it('空公式报错', () => { expect(bad('')).toContain('为空'); });
  it('未知函数报错', () => { expect(bad('foo(C1)')).toContain('未知函数'); });
  it('越界列引用报错', () => { expect(bad('C9')).toContain('不存在'); });
  it('未知列名报错', () => { expect(bad("'不存在的列'")).toContain('未找到列'); });
  it('括号不匹配报错', () => { expect(bad('(C1 + 2')).toBeTruthy(); });
  it('多余内容报错', () => { expect(bad('C1 C2')).toContain('多余'); });
  it('未知名称(无括号函数)报错', () => { expect(bad('mean')).toContain('未知名称'); });
});
