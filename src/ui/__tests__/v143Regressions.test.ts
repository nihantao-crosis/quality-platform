/** v1.43.0 双审整改批:对抗审查指出的零覆盖行为修复补回归(审查建议 ③)。
 * @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from 'vitest';
import { computeVarModel, prepareGageStudy, computeCapability } from '../../core';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
});

describe('MSA 角色并列弃权(不再按列序猜)', () => {
  it('两个同水平数类别列 + 未手选 → 拒绝并引导,而非静默把操作员当部件', () => {
    // G1/G2 各 3 水平、名称无角色关键词、完全交叉 → 推荐并列弃权
    const rows: number[][] = [];
    const g1: string[] = []; const g2: string[] = [];
    for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) for (let r = 0; r < 3; r++) {
      rows.push([10 + a * 0.5 + b * 0.1 + r * 0.01]);
      g1.push(String(a)); g2.push(String(b));
    }
    const model = computeVarModel('并列.csv', ['读数'], rows);
    const textCols = [
      { name: 'G1', values: g1, sourceIndex: 0 },
      { name: 'G2', values: g2, sourceIndex: 1 },
    ];
    const result = prepareGageStudy(model, textCols, { valueColumn: '读数', partColumn: null, operatorColumn: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('请选择');
    expect(result.reason).toContain('不会按列序默认');
  });
});

describe('数据矩阵写入口有限性屏障', () => {
  it('importMatrix 拒绝含 Infinity/NaN 的行(防「今天落盘明天整店隔离」)', () => {
    expect(() => useData.getState().importMatrix('坏.csv', ['x'], [[1], [Infinity], [3]]))
      .toThrow(/非有限数值/);
    expect(() => useData.getState().importMatrix('坏2.csv', ['x'], [[1], [Number.NaN], [3]]))
      .toThrow(/非有限数值/);
    // 合法数据不受影响
    useData.getState().importMatrix('好.csv', ['x'], [[1], [2], [3]]);
    expect(useData.getState().model.name).toBe('好.csv');
  });
});

describe('appendSubgroup 结构守卫(MES 流保护)', () => {
  it('列数不匹配或目标表带文本列时拒绝追加并停流', () => {
    useData.getState().importMatrix('结构.csv', ['a', 'b'], [[1, 2], [3, 4]], [
      { name: '组', values: ['甲', '乙'], sourceIndex: 2 },
    ]);
    useData.setState({ mesRunning: true });
    const before = useData.getState().model.k;
    useData.getState().appendSubgroup([5, 6]); // 列数匹配但有文本列 → 拒绝
    expect(useData.getState().model.k).toBe(before);
    expect(useData.getState().mesRunning).toBe(false);

    useData.getState().importMatrix('无文本.csv', ['a', 'b'], [[1, 2], [3, 4]]);
    useData.setState({ mesRunning: true });
    useData.getState().appendSubgroup([5, 6, 7]); // 列数不匹配 → 拒绝
    expect(useData.getState().model.k).toBe(2);
    expect(useData.getState().mesRunning).toBe(false);
    useData.getState().appendSubgroup([5, 6]); // 合法追加
    expect(useData.getState().model.k).toBe(3);
  });
});

describe('单侧 Cpm(Minitab 单侧式)', () => {
  it('仅 USL:Cpm = (USL−T)/(3τ);仅 LSL 对称', () => {
    // vals=[9,11],T=10 → τ=1 精确
    const upper = computeCapability([9, 11], 1, { lsl: null, tgt: 10, usl: 13 });
    expect(upper.cpm!).toBeCloseTo(1, 10);
    const lower = computeCapability([9, 11], 1, { lsl: 7, tgt: 10, usl: null });
    expect(lower.cpm!).toBeCloseTo(1, 10);
    expect(upper.cp).toBeNull();
    expect(upper.pp).toBeNull();
  });
});
