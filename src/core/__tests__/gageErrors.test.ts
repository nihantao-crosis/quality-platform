/**
 * MSA(Gage R&R)工厂第三轮反馈 — 可执行部分回归测试。
 * 1) 工作表整数列显示精度 dp=0(PPT 10 页「部件」列 1.000 → 1);
 * 2) prepareGageStudy 报错文案指名道姓(PPT 11 页「计算错误无法生成图表」可定位);
 * 3) 工厂场景复现:单操作员 30 行 / 缺胞 / 不等重复;
 * 4) 完整交叉 3×10×2 推断 p/o/r 防回归。
 */
import { describe, it, expect } from 'vitest';
import { columnDisplayDp, prepareGageStudy, recommendGageRoles } from '../gageData';
import type { GageTextColumn } from '../gageData';
import { computeVarModel } from '../model';
import { computeGageRR } from '../gage';

// ---------- 1. 列显示精度纯函数 ----------

describe('columnDisplayDp — 工作表列自适应显示精度', () => {
  it('全整数列(部件 ID 1–10)返回 0:显示 1/2/3 而非 1.000', () => {
    const partIds = Array.from({ length: 30 }, (_, i) => (i % 10) + 1);
    expect(columnDisplayDp(partIds)).toBe(0);
  });

  it('全整数常数列(极差为 0)同样返回 0', () => {
    expect(columnDisplayDp([2, 2, 2, 2])).toBe(0);
  });

  it('负整数与 0 混合仍算整数列', () => {
    expect(columnDisplayDp([-3, 0, 7, 12])).toBe(0);
  });

  it('小数列维持原 3–6 位自适应:常规量纲 3 位', () => {
    expect(columnDisplayDp([4.5, 10.1, 13.5, 11.0])).toBe(3);
  });

  it('小量纲列(过盈量 ~0.0675)提升到高位显示,不被压成 0.068', () => {
    const dp = columnDisplayDp([0.0675, 0.0682, 0.0668, 0.0691]);
    expect(dp).toBeGreaterThanOrEqual(4);
    expect(dp).toBeLessThanOrEqual(6);
  });

  it('整数中混入一个小数即退出整数规则,回到 ≥3 位', () => {
    expect(columnDisplayDp([1, 2, 3, 4.5])).toBeGreaterThanOrEqual(3);
  });

  it('空列回退默认 3 位', () => {
    expect(columnDisplayDp([])).toBe(3);
  });

  it('退化的非整数常数列走量级 1% 规则(与原实现一致)', () => {
    expect(columnDisplayDp([1.5, 1.5, 1.5])).toBe(4);
  });
});

// ---------- 2/3. prepareGageStudy 报错指名道姓 ----------

/** 工厂 PPT 场景:部件 1–10 × 测试人 邹德玉 × 螺钉高度,每部件 3 次,共 30 行 */
function singleOperatorWorksheet() {
  const rows: number[][] = [];
  const operators: string[] = [];
  for (let part = 1; part <= 10; part++) {
    for (let trial = 0; trial < 3; trial++) {
      rows.push([10 + part * 0.1 + trial * 0.01, part]);
      operators.push('邹德玉');
    }
  }
  const model = computeVarModel('螺钉高度MSA.csv', ['螺钉高度', '部件'], rows);
  const textCols: GageTextColumn[] = [{ name: '测试人', values: operators }];
  return { model, textCols };
}

/** 2 操作员 × 部件 1–5 × 2 次的平衡数据,可再按需抽掉行制造缺陷 */
function twoOperatorRows(parts = 5, repeats = 2) {
  const rows: Array<{ value: number; part: string; operator: string }> = [];
  for (const operator of ['张', '李']) {
    for (let part = 1; part <= parts; part++) {
      for (let trial = 0; trial < repeats; trial++) {
        rows.push({ value: 10 + part + trial * 0.05 + (operator === '李' ? 0.02 : 0), part: String(part), operator });
      }
    }
  }
  return rows;
}

function toStudyInputs(rows: Array<{ value: number; part: string; operator: string }>) {
  const model = computeVarModel('gage.csv', ['测量值'], rows.map((row) => [row.value]));
  const textCols: GageTextColumn[] = [
    { name: '部件', values: rows.map((row) => row.part) },
    { name: '操作员', values: rows.map((row) => row.operator) },
  ];
  return { model, textCols };
}

const SELECTION = { valueColumn: '测量值', partColumn: '部件', operatorColumn: '操作员' };

describe('prepareGageStudy — 报错文案指名道姓(工厂第三轮反馈 PPT 11 页)', () => {
  it('工厂场景:单操作员(邹德玉)30 行 → 明确说“仅 1 个操作员…需 ≥2 名”', () => {
    const { model, textCols } = singleOperatorWorksheet();
    const result = prepareGageStudy(model, textCols, {
      valueColumn: '螺钉高度', partColumn: '部件', operatorColumn: '测试人',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('仅检测到 1 个操作员(邹德玉)');
    expect(result.reason).toContain('≥2 名操作员');
    expect(result.reason).toContain('请补充其他操作员数据');
  });

  it('单部件也指名具体部件标签', () => {
    const rows = twoOperatorRows(1, 3);
    const { model, textCols } = toStudyInputs(rows);
    const result = prepareGageStudy(model, textCols, SELECTION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('仅检测到 1 个部件(1)');
    expect(result.reason).toContain('≥2 个部件');
  });

  it('缺胞(部件 3×操作员 李 整胞缺失)→ 指名部件、操作员与缺测次数', () => {
    const rows = twoOperatorRows().filter((row) => !(row.part === '3' && row.operator === '李'));
    const { model, textCols } = toStudyInputs(rows);
    const result = prepareGageStudy(model, textCols, SELECTION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('交叉设计不完整');
    expect(result.reason).toContain('部件「3」×操作员「李」缺 2 次测量');
    expect(result.reason).toContain('其余胞均为 2 次');
  });

  it('不等重复(部件 3×操作员 李 只测 1 次)→ 列出最少/最多的具体胞', () => {
    const rows = twoOperatorRows();
    const index = rows.findIndex((row) => row.part === '3' && row.operator === '李');
    rows.splice(index, 1); // 该胞剩 1 次,其余胞均 2 次
    const { model, textCols } = toStudyInputs(rows);
    const result = prepareGageStudy(model, textCols, SELECTION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('重复测量次数不一致');
    expect(result.reason).toContain('部件「3」×操作员「李」(1 次)');
    expect(result.reason).toContain('(2 次)');
  });

  it('平衡但每胞仅 1 次 → 明确说需每胞 ≥2 次重复', () => {
    const rows = twoOperatorRows(5, 1);
    const { model, textCols } = toStudyInputs(rows);
    const result = prepareGageStudy(model, textCols, SELECTION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('仅有 1 次测量');
    expect(result.reason).toContain('≥2 次重复测量');
  });
});

// ---------- 4. 完整交叉数据推断 p/o/r 防回归 ----------

describe('prepareGageStudy — 完整交叉设计防回归', () => {
  it('3 操作员 × 10 部件 × 2 次(60 行)推断 p=10、o=3、r=2 并产出 60 条观测', () => {
    const rows: Array<{ value: number; part: string; operator: string }> = [];
    for (const operator of ['张', '李', '邹德玉']) {
      for (let part = 1; part <= 10; part++) {
        for (let trial = 0; trial < 2; trial++) {
          rows.push({ value: 20 + part * 0.3 + trial * 0.02, part: String(part), operator });
        }
      }
    }
    const { model, textCols } = toStudyInputs(rows);
    // 不显式指定角色列:验证默认推断(文本列在前 → 部件、操作员)仍成立
    const result = prepareGageStudy(model, textCols, { valueColumn: null, partColumn: null, operatorColumn: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.study.partLabels).toHaveLength(10);
    expect(result.study.operatorLabels).toHaveLength(3);
    expect(result.study.repeats).toBe(2);
    expect(result.study.observations).toHaveLength(60);
    expect(result.study.valueName).toBe('测量值');
    expect(result.study.partName).toBe('部件');
    expect(result.study.operatorName).toBe('操作员');
  });
});

// ---------- 5. 批次716-R3 P1-2:MSA 默认角色推荐(recommendGageRoles) ----------

/** 工厂原列序「部件、测试人、螺钉高度」:旧默认(第一数值列当测量)会把「部件」推荐成测量列。 */
function factoryOrderColumns(operators: string[], parts: number, repeats: number) {
  const rows: number[][] = [];
  const operatorValues: string[] = [];
  for (const operator of operators) {
    for (let part = 1; part <= parts; part++) {
      for (let trial = 0; trial < repeats; trial++) {
        // 部件在前、螺钉高度在后,复现工厂导入列序
        rows.push([part, 10 + part * 0.1 + trial * 0.01 + (operator === '李四' ? 0.02 : 0)]);
        operatorValues.push(operator);
      }
    }
  }
  const model = computeVarModel('工厂GRR.csv', ['部件', '螺钉高度'], rows);
  const textCols: GageTextColumn[] = [{ name: '测试人', values: operatorValues, sourceIndex: 1 } as GageTextColumn];
  return { model, textCols };
}

describe('recommendGageRoles — 工厂列序不再推荐反(716-R3 P1-2)', () => {
  it('工厂场景 30 行「部件(1-10 整数)/测试人(文本 邹德玉)/螺钉高度(10.x 小数)」→ value=螺钉高度、part=部件、operator=测试人', () => {
    const { model, textCols } = factoryOrderColumns(['邹德玉'], 10, 3);
    const rec = recommendGageRoles(model, textCols);
    expect(rec.value).toBe('螺钉高度');
    expect(rec.part).toBe('部件');
    expect(rec.operator).toBe('测试人');
    // 推荐依据可解释,供 UI 小字展示
    expect(rec.reasons.length).toBeGreaterThan(0);
    const joined = rec.reasons.join('');
    expect(joined).toContain('螺钉高度');
    expect(joined).toContain('部件');
    expect(joined).toContain('测试人');
  });

  it('Codex 场景:2 操作员×3 部件×2 次 → 推荐正确,且按推荐能直接算出 GRR', () => {
    const { model, textCols } = factoryOrderColumns(['张三', '李四'], 3, 2);
    const rec = recommendGageRoles(model, textCols);
    expect(rec.value).toBe('螺钉高度');
    expect(rec.part).toBe('部件');
    expect(rec.operator).toBe('测试人');
    // 平衡交叉结构也应进入推荐依据
    expect(rec.reasons.join('')).toContain('交叉平衡');
    const prepared = prepareGageStudy(model, textCols, {
      valueColumn: rec.value, partColumn: rec.part, operatorColumn: rec.operator,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.study.partLabels).toHaveLength(3);
    expect(prepared.study.operatorLabels).toHaveLength(2);
    expect(prepared.study.repeats).toBe(2);
    const g = computeGageRR(prepared.study.observations, null);
    expect(Number.isFinite(g.totalGageRR)).toBe(true);
    expect(g.totalGageRR).toBeGreaterThan(0);
  });

  it('列名无关键词时按结构信号推荐:小数连续列=测量、小整数均衡列=部件、少水平文本列=操作员', () => {
    const rows: number[][] = [];
    const groupValues: string[] = [];
    for (const group of ['甲', '乙']) {
      for (let level = 1; level <= 5; level++) {
        for (let trial = 0; trial < 2; trial++) {
          rows.push([level, 10 + level * 0.5 + trial * 0.03 + (group === '乙' ? 0.02 : 0)]);
          groupValues.push(group);
        }
      }
    }
    const model = computeVarModel('无关键词.csv', ['X1', 'X2'], rows);
    const textCols: GageTextColumn[] = [{ name: 'G', values: groupValues }];
    const rec = recommendGageRoles(model, textCols);
    expect(rec.value).toBe('X2');
    expect(rec.part).toBe('X1');
    expect(rec.operator).toBe('G');
  });

  it('信号不足并列时明确 null,不瞎猜:两条同形态小数列', () => {
    const rows = [[1.15, 2.15], [1.32, 2.32], [1.58, 2.58], [1.71, 2.71], [1.94, 2.94], [1.27, 2.27]];
    const model = computeVarModel('并列.csv', ['X1', 'X2'], rows);
    const rec = recommendGageRoles(model, [] as GageTextColumn[]);
    expect(rec.value).toBeNull();
    expect(rec.part).toBeNull();
    expect(rec.operator).toBeNull();
  });

  it('唯一数值列即使无关键词也锁定为测量列;类别信号不足时部件/操作员为 null', () => {
    const model = computeVarModel('单列.csv', ['D1'], [[1.11], [1.32], [1.53], [1.24]]);
    const rec = recommendGageRoles(model, [] as GageTextColumn[]);
    expect(rec.value).toBe('D1');
    expect(rec.part).toBeNull();
    expect(rec.operator).toBeNull();
    expect(rec.reasons.join('')).toContain('唯一数值列');
  });
});
