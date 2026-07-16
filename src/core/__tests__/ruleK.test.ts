/**
 * SPC 判异准则 K 值可编辑（对齐 Minitab Xbar-R 选项→检验,工厂第三轮反馈）。
 * ① 默认 K 与旧行为逐位一致;② k1 只改准则 1 检测阈;③ k2 游程长度;
 * ④ k5「K/K+1」联动窗口;⑤ normalizeRuleK 越界回落;⑥ 分析快照往返还原。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  evalRules, evalLimitedRules, normalizeRuleK, ruleKValueError, DEFAULT_RULE_K,
  type NelsonRules, type NelsonRuleK,
} from '../spc';
import { useApp, DEFAULT_SPC_RULES } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { useData } from '../../store/dataStore';

const off: NelsonRules = { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const sortedViol = (r: { viol: Set<number> }) => [...r.viol].sort((a, b) => a - b);

describe('① 默认 K 与旧行为逐位兼容', () => {
  it('准则 1/2/5:省略第 5 参、显式 DEFAULT_RULE_K、空 Partial 三者结果逐位一致', () => {
    const cases: Array<{ data: number[]; rules: NelsonRules }> = [
      { data: [0, 3.6, -0.5, 2.9], rules: { ...off, r1: true } },                       // 准则 1
      { data: [0.5, ...Array<number>(10).fill(1), -0.5], rules: { ...off, r2: true } }, // 准则 2:11 点同侧
      { data: [2.5, 2.5, 0, -2.5, -2.5, 0], rules: { ...off, r5: true } },              // 准则 5:2 of 3
    ];
    for (const { data, rules } of cases) {
      const legacy = evalRules(data, 0, 1, rules);
      const explicit = evalRules(data, 0, 1, rules, DEFAULT_RULE_K);
      const partial = evalRules(data, 0, 1, rules, {});
      expect(sortedViol(explicit)).toEqual(sortedViol(legacy));
      expect(explicit.list).toEqual(legacy.list);
      expect(sortedViol(partial)).toEqual(sortedViol(legacy));
      expect(partial.list).toEqual(legacy.list);
    }
  });

  it('evalLimitedRules 默认 K 与旧签名一致(含非对称控制限与逐点控制限)', () => {
    const legacy = evalLimitedRules([-0.1, 5, 10.1], 5, 10, 0, { ...off, r1: true, r3: true });
    const explicit = evalLimitedRules([-0.1, 5, 10.1], 5, 10, 0, { ...off, r1: true, r3: true }, DEFAULT_RULE_K);
    expect(sortedViol(explicit)).toEqual(sortedViol(legacy));
    expect(explicit.list).toEqual(legacy.list);
    expect(explicit.list[0].desc).toBe('1 点超出该图的 3σ 控制限');
  });
});

describe('② k1 只影响准则 1 的检测阈', () => {
  it('2.5σ 点:k1=2 检出,默认 k1=3 不检出', () => {
    const data = [0, 2.5, 0];
    const rules = { ...off, r1: true };
    expect(evalRules(data, 0, 1, rules).viol.size).toBe(0);
    const tightened = evalRules(data, 0, 1, rules, { k1: 2 });
    expect(sortedViol(tightened)).toEqual([1]);
    expect(tightened.list[0].desc).toContain('2σ');
  });

  it('evalLimitedRules:k1 缩放检测阈但不改动 UCL/LCL 判定基准(3σ 限仍是 3σ 限)', () => {
    // cl=0,UCL=3,LCL=-3(3σ 限)。2.5 未越 UCL;k1=2 时检测阈为 ±2,应检出。
    const rules = { ...off, r1: true };
    expect(evalLimitedRules([2.5], 0, 3, -3, rules).viol.size).toBe(0);
    expect(sortedViol(evalLimitedRules([2.5], 0, 3, -3, rules, { k1: 2 }))).toEqual([0]);
    // 反向:k1=4 时 3.5(已越 3σ 控制限)不再被准则 1 报出——阈值确实随 k1 而动
    expect(evalLimitedRules([3.5], 0, 3, -3, rules, { k1: 4 }).viol.size).toBe(0);
  });
});

describe('③ k2 连续同侧游程长度', () => {
  it('7 点同侧:k2=7 检出,默认 k2=9 不检出', () => {
    const data = Array<number>(7).fill(0.8);
    const rules = { ...off, r2: true };
    expect(evalRules(data, 0, 1, rules).viol.size).toBe(0);
    const custom = evalRules(data, 0, 1, rules, { k2: 7 });
    expect(sortedViol(custom)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(custom.list[0]).toMatchObject({ rule: 2, desc: '连续 7 点落在中心线同一侧' });
  });
});

describe('④ k5 的「K/K+1」联动窗口', () => {
  it('k5=3:「4 中 3 点越 2σ 同侧」检出,且实际越界的 3 点全部标红', () => {
    const data = [2.5, 2.5, 0, 2.5];
    const r = evalRules(data, 0, 1, { ...off, r5: true }, { k5: 3 });
    expect(sortedViol(r)).toEqual([0, 1, 3]);
    expect(r.list.every((x) => x.rule === 5)).toBe(true);
  });

  it('k5=3 比默认「3 中 2」更严:仅 2 of 3 的形态默认检出、k5=3 不检出', () => {
    const data = [2.5, 2.5, 0, 0];
    expect(evalRules(data, 0, 1, { ...off, r5: true }).viol.size).toBe(2);
    expect(evalRules(data, 0, 1, { ...off, r5: true }, { k5: 3 }).viol.size).toBe(0);
  });
});

describe('⑤ normalizeRuleK 越界/非法回落默认', () => {
  it('越界、非整数、非数字逐字段回落标准值;合法字段保留', () => {
    expect(normalizeRuleK({ k1: 0.5, k2: 31, k5: 6, k6: 1, k7: 8.5, k8: 'x' })).toEqual(DEFAULT_RULE_K);
    expect(normalizeRuleK({ k1: 7 })).toEqual(DEFAULT_RULE_K);       // k1 上界 6
    expect(normalizeRuleK({ k1: 2.55 })).toEqual(DEFAULT_RULE_K);    // k1 只允许一位小数
    expect(normalizeRuleK({ k1: 2.5, k2: 7 })).toEqual({ ...DEFAULT_RULE_K, k1: 2.5, k2: 7 });
    expect(normalizeRuleK({ k5: 5, k6: 6 })).toEqual({ ...DEFAULT_RULE_K, k5: 5, k6: 6 });
  });

  it('非对象/空输入返回完整标准值;ruleKValueError 与 normalizeRuleK 同口径', () => {
    expect(normalizeRuleK(undefined)).toEqual(DEFAULT_RULE_K);
    expect(normalizeRuleK('垃圾')).toEqual(DEFAULT_RULE_K);
    expect(normalizeRuleK([2, 9])).toEqual(DEFAULT_RULE_K);
    expect(ruleKValueError('k1', 2.5)).toBeNull();
    expect(ruleKValueError('k1', 6.1)).not.toBeNull();
    expect(ruleKValueError('k2', 8.5)).not.toBeNull();
    expect(ruleKValueError('k6', 6)).toBeNull();
    expect(ruleKValueError('k6', 7)).not.toBeNull();
  });
});

describe('⑥ 分析快照往返', () => {
  beforeEach(() => {
    localStorage.clear();
    useAnalyses.setState({ saved: [], lastError: null });
    useData.getState().resetDemo();
    useData.setState({ recents: [] });
    useApp.setState({
      page: 'spc', spcType: 'xbar-r', spcRules: { ...DEFAULT_SPC_RULES }, spcRuleK: { ...DEFAULT_RULE_K },
      spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    });
  });

  it('保存 → 修改 → restore 后 spcRuleK 精确还原', async () => {
    useData.getState().importMatrix('K值数据', ['V1', 'V2', 'V3', 'V4', 'V5'], [
      [25.01, 24.99, 25.02, 24.98, 25.0],
      [25.03, 25.01, 24.97, 25.02, 24.99],
      [24.98, 25.0, 25.01, 25.03, 25.02],
      [25.02, 24.97, 25.0, 25.01, 24.98],
      [25.0, 25.02, 24.99, 25.0, 25.01],
      [24.99, 25.01, 25.02, 24.98, 25.0],
    ]);
    const customK: NelsonRuleK = { ...DEFAULT_RULE_K, k1: 2.5, k2: 7, k5: 3 };
    useApp.setState({ spcRuleK: { ...customK } });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).not.toBeNull();
    expect(saved!.snapshot.spcRuleK).toEqual(customK);

    useApp.setState({ spcRuleK: { ...DEFAULT_RULE_K } });
    expect(await useAnalyses.getState().restore(saved!.id)).toBe(true);
    expect(useApp.getState().spcRuleK).toEqual(customK);
  });

  it('旧记录无 spcRuleK 字段:restore 回到标准值,不继承当前页面自定义值', async () => {
    useData.getState().importMatrix('旧记录数据', ['V1', 'V2', 'V3', 'V4', 'V5'], [
      [25.01, 24.99, 25.02, 24.98, 25.0],
      [25.03, 25.01, 24.97, 25.02, 24.99],
      [24.98, 25.0, 25.01, 25.03, 25.02],
    ]);
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).not.toBeNull();
    const legacy = { ...saved!, snapshot: { ...saved!.snapshot, spcRuleK: undefined } };
    useAnalyses.setState({ saved: [legacy] });
    useApp.setState({ spcRuleK: { ...DEFAULT_RULE_K, k2: 12 } });
    expect(await useAnalyses.getState().restore(saved!.id)).toBe(true);
    expect(useApp.getState().spcRuleK).toEqual(DEFAULT_RULE_K);
  });
});
