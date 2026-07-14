/** 批次C:两轮外部审核确认缺陷的回归测试(纯函数部分)。 */
import { describe, it, expect } from 'vitest';
import { evalRules, parseCategoryCounts, buildAnovaGroups, detectFactorial, analyzeFactorial } from '../index';

describe('A3a · SPC 准则5(2 of 3 越 2σ):结果列表记在实际越界点上', () => {
  const OFF = { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
  it('[3,3,0] cl=0 σ=1 → 红点与列表都指向点 1、2(索引 0、1),不指向窗口末点', () => {
    const { viol, list } = evalRules([3, 3, 0], 0, 1, { ...OFF, r5: true });
    expect([...viol].sort((a, b) => a - b)).toEqual([0, 1]); // 实际越界点
    expect(viol.has(2)).toBe(false);                          // 窗口末点未越界,不应标红
    const idxs = list.filter((x) => x.rule === 5).map((x) => x.i).sort((a, b) => a - b);
    expect(idxs).toEqual([0, 1]);                             // 列表记在越界点(修复前记的是窗口末点 2)
  });
});

describe('A4 · 柏拉图解析器:唯一数值列即使是 1,2,3 也不当序号删', () => {
  it('A,1 / B,2 / C,3 正常解析为频数,不报"找不到频数"', () => {
    const r = parseCategoryCounts('A,1\nB,2\nC,3');
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([{ name: 'A', count: 1 }, { name: 'B', count: 2 }, { name: 'C', count: 3 }]);
    }
  });
  it('识别"频率"表头', () => {
    const r = parseCategoryCounts('类别,频率\n划伤,10\n毛刺,20');
    expect('rows' in r).toBe(true);
    if ('rows' in r) expect(r.rows).toEqual([{ name: '划伤', count: 10 }, { name: '毛刺', count: 20 }]);
  });
  it('真有序号列(3 列:序号,类别,频数)仍正确忽略序号', () => {
    const r = parseCategoryCounts('1,划伤,32\n2,毛刺,21\n3,缺料,9');
    expect('rows' in r).toBe(true);
    if ('rows' in r) expect(r.rows).toEqual([{ name: '划伤', count: 32 }, { name: '毛刺', count: 21 }, { name: '缺料', count: 9 }]);
  });
  it('递增频数列(10,20,30)不被误当序号——只有连续 1,2,3 才算序号', () => {
    // 类别,频数,序号:频数 10,20,30 递增但非连续序号;序号 1,2,3 才是序号列
    const r = parseCategoryCounts('A,10,1\nB,20,2\nC,30,3');
    expect('rows' in r).toBe(true);
    if ('rows' in r) expect(r.rows).toEqual([{ name: 'A', count: 10 }, { name: 'B', count: 20 }, { name: 'C', count: 30 }]);
  });
  it('带序号前缀的表头(序号,类别,频数)能剥离并正确解析', () => {
    const r = parseCategoryCounts('序号,类别,频数\n1,划伤,10\n2,污渍,20\n3,变形,30');
    expect('rows' in r).toBe(true);
    if ('rows' in r) expect(r.rows).toEqual([{ name: '划伤', count: 10 }, { name: '污渍', count: 20 }, { name: '变形', count: 30 }]);
  });
});

describe('A1 · buildAnovaGroups 三模式', () => {
  const colNames = ['过盈量', '轴硬度', '压入力'];
  const rows = [[0.045, 28, 620], [0.045, 28, 640], [0.09, 32, 1350], [0.09, 32, 1300]];
  it('numfactor:压入力 按 过盈量 水平分组', () => {
    const gs = buildAnovaGroups('numfactor', colNames, rows, [], '压入力', '过盈量');
    expect(gs).not.toBeNull();
    expect(gs!.map((g) => g.name)).toEqual(['过盈量=0.045', '过盈量=0.09']);
    expect(gs![0].vals).toEqual([620, 640]);
  });
  it('wide:各列一组', () => {
    const gs = buildAnovaGroups('wide', colNames, rows, [], null, null);
    expect(gs!.map((g) => g.name)).toEqual(colNames);
    expect(gs![2].vals).toEqual([620, 640, 1350, 1300]);
  });
  it('stacked:按文本列分组', () => {
    const textCols = [{ name: '设备', values: ['A', 'A', 'B', 'B'] }];
    const gs = buildAnovaGroups('stacked', colNames, rows, textCols, '压入力', '设备');
    expect(gs!.map((g) => g.name)).toEqual(['A', 'B']);
    expect(gs![1].vals).toEqual([1350, 1300]);
  });
  it('每组不足 2 观测 → null', () => {
    const gs = buildAnovaGroups('numfactor', colNames, [[0.045, 28, 620], [0.09, 32, 1350]], [], '压入力', '过盈量');
    expect(gs).toBeNull();
  });
});

describe('A8 · DOE 标准化残差(t 检验路径)', () => {
  it('有重复设计给出标准化残差,长度=行数、全有限', () => {
    const A = [0, 1, 0, 1, 0, 1, 0, 1];
    const B = [0, 0, 1, 1, 0, 0, 1, 1];
    const y = [10, 30, 12, 33, 11, 29, 13, 31];
    const r = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    expect(fr.method).toBe('ttest');
    expect(fr.stdResiduals).toBeDefined();
    expect(fr.stdResiduals!).toHaveLength(8);
    expect(fr.stdResiduals!.every((v) => Number.isFinite(v))).toBe(true);
  });
});
