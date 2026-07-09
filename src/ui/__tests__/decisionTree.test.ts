/** 助手决策树:结构完整性 + 路由有效性 + 关键路径。 */
import { describe, it, expect } from 'vitest';
import { TREE, ROOT, getNode, isRec, type Recommendation } from '../assistant/decisionTree';
import { PAGES } from '../pagesMeta';

const VALID_PAGES = new Set(PAGES.map((p) => p.key));
const VALID_SPC = new Set(['xbar-r', 'xbar-s', 'i-mr', 'ewma', 'cusum', 'p', 'c']);
const VALID_HYPO = new Set(['anova', 't1', 't2', 'reg']);

/** 顺着一串选项文本从 ROOT 走到叶子。 */
function walk(labels: string[]): Recommendation {
  let cur = getNode(ROOT);
  for (const label of labels) {
    if (!cur || cur.kind !== 'q') throw new Error(`到 ${label} 之前已非问题节点`);
    const choice = cur.choices.find((c) => c.label === label);
    if (!choice) throw new Error(`选项「${label}」不存在于「${cur.prompt}」`);
    cur = getNode(choice.to);
  }
  if (!isRec(cur)) throw new Error('路径未终止于推荐');
  return cur;
}

describe('决策树结构', () => {
  it('ROOT 存在且是问题', () => {
    const root = getNode(ROOT);
    expect(root?.kind).toBe('q');
  });

  it('每个选项都指向真实存在的节点', () => {
    for (const node of Object.values(TREE)) {
      if (node.kind !== 'q') continue;
      for (const c of node.choices) {
        expect(getNode(c.to), `${node.id} → ${c.to}`).toBeDefined();
      }
    }
  });

  it('节点 id 与键一致', () => {
    for (const [k, node] of Object.entries(TREE)) {
      expect(node.id).toBe(k);
    }
  });

  it('每个推荐的 page/setup 合法', () => {
    for (const node of Object.values(TREE)) {
      if (node.kind !== 'rec') continue;
      expect(VALID_PAGES.has(node.page), `${node.id} page=${node.page}`).toBe(true);
      expect(node.what.length).toBeGreaterThan(4);
      expect(node.needs.length).toBeGreaterThan(4);
      expect(node.why.length).toBeGreaterThan(4);
      if (node.setup?.spcType) expect(VALID_SPC.has(node.setup.spcType)).toBe(true);
      if (node.setup?.hypoTab) expect(VALID_HYPO.has(node.setup.hypoTab)).toBe(true);
    }
  });

  it('无孤立节点(除 ROOT 外都可从 ROOT 到达)', () => {
    const seen = new Set<string>([ROOT]);
    const stack = [ROOT];
    while (stack.length) {
      const n = getNode(stack.pop()!);
      if (!n || n.kind !== 'q') continue;
      for (const c of n.choices) if (!seen.has(c.to)) { seen.add(c.to); stack.push(c.to); }
    }
    expect(seen.size).toBe(Object.keys(TREE).length);
  });
});

describe('关键路径路由', () => {
  it('小子组连续测量 → X̄-R', () => {
    const r = walk(['监控过程随时间是否稳定', '连续测量值', '每次采集多个,子组 2–8 个']);
    expect(r.page).toBe('spc');
    expect(r.setup?.spcType).toBe('xbar-r');
  });

  it('单值连续测量 → I-MR', () => {
    const r = walk(['监控过程随时间是否稳定', '连续测量值', '每次只有一个测量值']);
    expect(r.setup?.spcType).toBe('i-mr');
  });

  it('不良品件数 → P 图', () => {
    const r = walk(['监控过程随时间是否稳定', '计数数据', '不合格品的“件数”']);
    expect(r.setup?.spcType).toBe('p');
  });

  it('三组以上比较 → ANOVA', () => {
    const r = walk(['比较不同组或条件之间有无差异', '三组及以上比较']);
    expect(r.page).toBe('anova');
    expect(r.setup?.hypoTab).toBe('anova');
  });

  it('两组比较 → 双样本 t', () => {
    const r = walk(['比较不同组或条件之间有无差异', '两组之间比较']);
    expect(r.setup?.hypoTab).toBe('t2');
  });

  it('规格评估 → 能力分析(直达叶子)', () => {
    const r = walk(['评估过程是否满足规格要求']);
    expect(r.page).toBe('capability');
  });

  it('两变量关系 → 回归', () => {
    const r = walk(['研究两个变量之间的关系']);
    expect(r.setup?.hypoTab).toBe('reg');
  });
});
