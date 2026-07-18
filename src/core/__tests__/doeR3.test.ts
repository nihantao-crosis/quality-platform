/** 716-R3 DOE 扩展:①一般全因子(2–5 水平)②分数因子 2^(k−p) 与折叠。
 * 锚点全部可手算或来自公认标准设计表,不自造数值。 */
import { describe, it, expect } from 'vitest';
import {
  detectGeneralFactorial, analyzeGeneralFactorial, generalLevelMeans, generateGeneralFactorialDesign,
  fractionalDesignOptions, fractionalFoldPreview, generateFractionalFactorialDesign,
  detectFactorial, analyzeFactorial, detectFractionalFactorial, analyzeFractionalFactorial,
  resolveDoeColumns, resolveDoeColumnsWide, MAX_FRACTIONAL_FACTORS,
} from '../doe';
import { fCdf } from '../basicMath';

// ==================== ① 一般全因子 ====================

describe('detectGeneralFactorial', () => {
  it('识别 2 因子 × 3 水平数据并按升序建立水平表', () => {
    const r = detectGeneralFactorial(
      [
        { name: 'A', values: [3, 1, 2, 3, 1, 2] },
        { name: 'B', values: [10, 20, 10, 20, 10, 20] },
      ],
      [5, 6, 7, 8, 9, 10],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.design.levels[0]).toEqual([1, 2, 3]);
    expect(r.design.levels[1]).toEqual([10, 20]);
    expect(r.design.levelIndex[0]).toEqual([2, 0]); // A=3 → 下标 2;B=10 → 下标 0
  });
  it('退化守卫:单水平因子 / >5 水平 / >4 因子 / 非有限值 / 行数不一致均拒绝', () => {
    const y6 = [1, 2, 3, 4, 5, 6];
    expect(detectGeneralFactorial(
      [{ name: 'A', values: [1, 1, 1, 1, 1, 1] }, { name: 'B', values: [1, 2, 1, 2, 1, 2] }], y6,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('只有 1 个水平') });
    expect(detectGeneralFactorial(
      [{ name: 'A', values: [1, 2, 3, 4, 5, 6] }, { name: 'B', values: [1, 2, 1, 2, 1, 2] }], y6,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('最多支持 5 个水平') });
    expect(detectGeneralFactorial(
      Array.from({ length: 5 }, (_, i) => ({ name: `F${i}`, values: [1, 2, 1, 2, 1, 2] })), y6,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('最多支持 4 个因子') });
    expect(detectGeneralFactorial(
      [{ name: 'A', values: [1, 2, NaN, 1, 2, 1] }, { name: 'B', values: [1, 2, 1, 2, 1, 2] }], y6,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('非有限数值') });
    expect(detectGeneralFactorial(
      [{ name: 'A', values: [1, 2, 1] }, { name: 'B', values: [1, 2, 1, 2, 1, 2] }], y6,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('行数不一致') });
  });
});

describe('analyzeGeneralFactorial:平衡 2 因子 × 3 水平 × 2 仿行手算锚点', () => {
  // 单元均值(无交互构造):A0 行 [10,12,14],A1 行 [20,22,24],A2 行 [30,32,34];
  // 每单元两观测 = 均值 ±1。手算:
  //   总均值 = 22;A 水平均值 12/22/32 → SS_A = 6·(100+0+100) = 1200,df=2
  //   B 水平均值 20/22/24 → SS_B = 6·(4+0+4) = 48,df=2
  //   交互 SS = 0(单元均值恰为行+列可加),df=4
  //   SSE = 18 个 (±1)² = 18,df = 18−9 = 9,MSE = 2;SST = 1266
  //   F_A = 600/2 = 300,F_B = 24/2 = 12,F_AB = 0
  const cellMean = [[10, 12, 14], [20, 22, 24], [30, 32, 34]];
  const aLevels = [1, 2, 3];
  const bLevels = [10, 20, 30];
  const A: number[] = []; const B: number[] = []; const y: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (const d of [-1, 1]) {
    A.push(aLevels[i]); B.push(bLevels[j]); y.push(cellMean[i][j] + d);
  }
  const detected = detectGeneralFactorial([{ name: '温度', values: A }, { name: '压力', values: B }], y);

  it('主效应/交互的 DF、Adj SS、Adj MS、F、P 与手算一致', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const res = analyzeGeneralFactorial(detected.design);
    expect(res.includeInteractions).toBe(true);
    const row = (name: string) => res.rows.find((r) => r.name === name)!;
    expect(row('温度')).toMatchObject({ kind: 'main', df: 2, sig: true });
    expect(row('温度').adjSS).toBeCloseTo(1200, 8);
    expect(row('温度').adjMS!).toBeCloseTo(600, 8);
    expect(row('温度').f!).toBeCloseTo(300, 6);
    expect(row('温度').p!).toBeLessThan(1e-6);
    expect(row('压力').df).toBe(2);
    expect(row('压力').adjSS).toBeCloseTo(48, 8);
    expect(row('压力').f!).toBeCloseTo(12, 6);
    // P 与平台 F 分布 CDF 自洽,且落在 α=0.05 显著区
    expect(row('压力').p!).toBeCloseTo(1 - fCdf(12, 2, 9), 10);
    expect(row('压力').p!).toBeGreaterThan(0.001);
    expect(row('压力').p!).toBeLessThan(0.05);
    expect(row('压力').sig).toBe(true);
    expect(row('温度×压力').df).toBe(4);
    expect(row('温度×压力').adjSS).toBeCloseTo(0, 8);
    expect(row('温度×压力').f!).toBeCloseTo(0, 8);
    expect(row('温度×压力').p!).toBeCloseTo(1, 8);
    expect(row('温度×压力').sig).toBe(false);
    expect(res.error.df).toBe(9);
    expect(res.error.adjSS).toBeCloseTo(18, 8);
    expect(res.error.adjMS!).toBeCloseTo(2, 8);
    expect(res.total.df).toBe(17);
    expect(res.total.adjSS).toBeCloseTo(1266, 8);
    expect(res.grand).toBeCloseTo(22, 10);
    expect(res.r2).toBeCloseTo(1 - 18 / 1266, 10);
  });

  it('主效应图数据:均值按水平算', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const means = generalLevelMeans(detected.design);
    expect(means[0]).toEqual({ name: '温度', levels: [1, 2, 3], means: [12, 22, 32], counts: [6, 6, 6] });
    expect(means[1].means).toEqual([20, 22, 24]);
    const res = analyzeGeneralFactorial(detected.design);
    expect(res.levelMeans).toEqual(means);
    // 拟合值 = 单元均值(饱和单元结构 + 仿行)
    expect(res.fits[0]).toBeCloseTo(10, 8);
    expect(res.residuals[0]).toBeCloseTo(-1, 8);
  });

  it('响应零方差直接拒绝,不产出伪 ANOVA', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const flat = { ...detected.design, response: detected.design.response.map(() => 7) };
    expect(() => analyzeGeneralFactorial(flat)).toThrow('零方差');
  });
});

describe('analyzeGeneralFactorial:两水平输入与既有两水平引擎 P 值一致', () => {
  const compare = (A: number[], B: number[], y: number[]) => {
    const two = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    const gen = detectGeneralFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    expect(two.ok).toBe(true);
    expect(gen.ok).toBe(true);
    if (!two.ok || !gen.ok) return;
    const twoRes = analyzeFactorial(two.design);
    const genRes = analyzeGeneralFactorial(gen.design);
    // 单自由度项的 F 检验 = t 检验的平方(F = t²,df1=1),两路径 P 必须一致
    for (const name of ['A', 'B', 'A×B']) {
      const t = twoRes.terms.find((term) => term.name === name)!;
      const g = genRes.rows.find((row) => row.name === name)!;
      expect(g.df).toBe(1);
      expect(g.p!).toBeCloseTo(t.p!, 8);
      expect(g.sig).toBe(t.sig);
    }
    expect(genRes.error.df).toBe(twoRes.dfResid);
    expect(genRes.error.adjMS!).toBeCloseTo(twoRes.mse!, 8);
  };
  it('平衡 2² × 2 仿行', () => {
    compare([0, 1, 0, 1, 0, 1, 0, 1], [0, 0, 1, 1, 0, 0, 1, 1], [10, 30, 12, 33, 11, 29, 13, 31]);
  });
  it('不平衡 2²(角点 (1,1) 多一次重复)', () => {
    compare([0, 1, 0, 1, 1], [0, 0, 1, 1, 1], [10, 20, 14, 30, 32]);
  });
});

describe('analyzeGeneralFactorial:无仿行时二因子交互明确不纳入', () => {
  it('3×3 单仿行 → 交互与误差不可分,主效应模型 + 说明', () => {
    const A = [1, 2, 3, 1, 2, 3, 1, 2, 3];
    const B = [1, 1, 1, 2, 2, 2, 3, 3, 3];
    const y = [10, 12, 14, 20, 23, 24, 30, 32, 35];
    const detected = detectGeneralFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const res = analyzeGeneralFactorial(detected.design);
    expect(res.includeInteractions).toBe(false);
    expect(res.interactionNote).toContain('无仿行');
    expect(res.rows.map((row) => row.name)).toEqual(['A', 'B']); // 只有主效应
    expect(res.error.df).toBe(4); // 交互自由度并入误差:8 − 2 − 2 = 4
  });
});

describe('generateGeneralFactorialDesign', () => {
  it('3×2 水平 × 2 仿行 = 12 运行;标准序因子 1 变化最快;区组恒 1;点类型全因子点', () => {
    const d = generateGeneralFactorialDesign(
      [{ name: '温度', levels: [150, 175, 200] }, { name: '时间', levels: [30, 60] }],
      { replicates: 2 },
    );
    expect(d.colNames).toEqual(['标准序', '运行序', '区组', '温度', '时间', '响应(待录入)']);
    expect(d.rows).toHaveLength(12);
    expect(d.blockCount).toBe(1);
    expect(d.rows.every((row) => row[2] === 1)).toBe(true);
    expect(d.rows.every((row) => row[d.responseCol] === 0)).toBe(true);
    expect(d.textCols[0].values).toEqual(Array(12).fill('因子点'));
    // 未随机化:第一仿行 6 行按「温度最快」的全组合序
    expect(d.rows.slice(0, 6).map((row) => [row[3], row[4]])).toEqual([
      [150, 30], [175, 30], [200, 30], [150, 60], [175, 60], [200, 60],
    ]);
    expect(d.rows.map((row) => row[0])).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
  it('随机化同种子可复现;非法输入拒绝', () => {
    const factors = [{ name: 'A', levels: [1, 2, 3] }, { name: 'B', levels: [0, 1] }];
    const opt = { randomize: true, seed: 42 };
    expect(generateGeneralFactorialDesign(factors, opt).rows)
      .toEqual(generateGeneralFactorialDesign(factors, opt).rows);
    expect(() => generateGeneralFactorialDesign(
      [{ name: 'A', levels: [1, 1, 2] }, { name: 'B', levels: [0, 1] }],
    )).toThrow('水平值不能重复');
    expect(() => generateGeneralFactorialDesign(
      [{ name: 'A', levels: [1, 2, 3, 4, 5, 6] }, { name: 'B', levels: [0, 1] }],
    )).toThrow('水平数必须在 2–5 之间');
    expect(() => generateGeneralFactorialDesign(
      [{ name: 'A', levels: [1, 2] }, { name: 'A', levels: [0, 1] }],
    )).toThrow('因子名不能重复');
    expect(() => generateGeneralFactorialDesign(
      [{ name: 'A', levels: [1, 2] }, { name: 'B', levels: [0, 1] }], { replicates: 1.5 },
    )).toThrow('仿行数');
  });
  it('生成 → 检测 → 分析闭环:多水平数据可直接进入一般全因子路径', () => {
    const d = generateGeneralFactorialDesign(
      [{ name: 'A', levels: [1, 2, 3] }, { name: 'B', levels: [10, 20] }],
      { replicates: 2 },
    );
    const A = d.rows.map((row) => row[3]);
    const B = d.rows.map((row) => row[4]);
    const y = d.rows.map((row) => 5 + 2 * row[3] + 0.1 * row[4] + (row[1] % 2 ? 0.5 : -0.5));
    const detected = detectGeneralFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const res = analyzeGeneralFactorial(detected.design);
    expect(res.rows.find((row) => row.name === 'A')?.sig).toBe(true);
  });
});

// ==================== ② 分数因子 2^(k−p) 与折叠 ====================

describe('fractionalDesignOptions:设计选择表与标准教科书设计一致', () => {
  it('k=5:全因子 32 / 2^(5-1) 16 V E=ABCD / 2^(5-2) 8 III D=AB,E=AC', () => {
    const options = fractionalDesignOptions(5);
    expect(options.map((o) => [o.p, o.runs, o.resolutionLabel])).toEqual([
      [0, 32, '完全'], [1, 16, 'V'], [2, 8, 'III'],
    ]);
    expect(options[1].generators).toEqual(['E=ABCD']);
    expect(options[2].generators).toEqual(['D=AB', 'E=AC']);
  });
  it('k=3/4/6/7 的次数、分辨率与生成元逐项核对', () => {
    expect(fractionalDesignOptions(3).map((o) => [o.p, o.runs, o.resolutionLabel])).toEqual([[0, 8, '完全'], [1, 4, 'III']]);
    expect(fractionalDesignOptions(3)[1].generators).toEqual(['C=AB']);
    expect(fractionalDesignOptions(4).map((o) => [o.p, o.runs, o.resolutionLabel])).toEqual([[0, 16, '完全'], [1, 8, 'IV']]);
    expect(fractionalDesignOptions(4)[1].generators).toEqual(['D=ABC']);
    const k6 = fractionalDesignOptions(6);
    expect(k6.map((o) => [o.p, o.runs, o.resolutionLabel])).toEqual([
      [0, 64, '完全'], [1, 32, 'VI'], [2, 16, 'IV'], [3, 8, 'III'],
    ]);
    expect(k6[1].generators).toEqual(['F=ABCDE']);
    expect(k6[2].generators).toEqual(['E=ABC', 'F=BCD']);
    expect(k6[3].generators).toEqual(['D=AB', 'E=AC', 'F=BC']);
    const k7 = fractionalDesignOptions(7);
    expect(k7.map((o) => [o.p, o.runs, o.resolutionLabel])).toEqual([
      [0, 128, '完全'], [1, 64, 'VII'], [2, 32, 'IV'], [3, 16, 'IV'], [4, 8, 'III'],
    ]);
    expect(k7[1].generators).toEqual(['G=ABCDEF']);
    expect(k7[2].generators).toEqual(['F=ABCD', 'G=ABDE']);
    expect(k7[3].generators).toEqual(['E=ABC', 'F=BCD', 'G=ACD']);
    expect(k7[4].generators).toEqual(['D=AB', 'E=AC', 'F=BC', 'G=ABC']);
  });
  it('k 越界拒绝', () => {
    expect(() => fractionalDesignOptions(2)).toThrow('3–7');
    expect(() => fractionalDesignOptions(8)).toThrow('3–7');
  });
});

const pm1 = (name: string) => ({ name, low: -1, high: 1 });

describe('generateFractionalFactorialDesign:2^(4-1) D=ABC 设计矩阵逐行锚点(Yates 序)', () => {
  const d = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C'), pm1('D')], 1);
  it('8 行矩阵与教科书 Yates 序完全一致', () => {
    expect(d.resolutionLabel).toBe('IV');
    expect(d.generators).toEqual(['D=ABC']);
    expect(d.colNames).toEqual(['标准序', '运行序', '区组', 'A', 'B', 'C', 'D', '响应(待录入)']);
    expect(d.rows.map((row) => row.slice(3, 7))).toEqual([
      [-1, -1, -1, -1],
      [1, -1, -1, 1],
      [-1, 1, -1, 1],
      [1, 1, -1, -1],
      [-1, -1, 1, 1],
      [1, -1, 1, -1],
      [-1, 1, 1, -1],
      [1, 1, 1, 1],
    ]);
    expect(d.rows.map((row) => row[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(d.rows.every((row) => row[2] === 1)).toBe(true);
    expect(d.blockCount).toBe(1);
    expect(d.folded).toBe(false);
  });
  it('D=ABC 的全反转与原分部重合，拒绝伪折叠；指定 D 折叠才追加互补分部', () => {
    expect(fractionalFoldPreview(4, 1, 'full')).toMatchObject({ effective: false, addedRuns: 0, totalRuns: 8, resolutionLabel: 'IV' });
    expect(() => generateFractionalFactorialDesign(
      [pm1('A'), pm1('B'), pm1('C'), pm1('D')], 1, { fold: 'full' },
    )).toThrow(/完全重复/);
    const folded = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C'), pm1('D')], 1, { fold: 3 });
    expect(folded.rows).toHaveLength(16);
    expect(folded.blockCount).toBe(2);
    expect(folded.folded).toBe(true);
    expect(folded.resolutionLabel).toBe('完全');
    for (let i = 0; i < 8; i++) {
      expect(folded.rows[i].slice(3, 7)).toEqual(d.rows[i].slice(3, 7));
      expect(folded.rows[8 + i].slice(3, 6)).toEqual(d.rows[i].slice(3, 6));
      expect(folded.rows[8 + i][6]).toBe(-d.rows[i][6]);
      expect(folded.rows[i][2]).toBe(1);
      expect(folded.rows[8 + i][2]).toBe(2);
    }
    expect(folded.rows.map((row) => row[0])).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(folded.rows.map((row) => row[1])).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});

describe('generateFractionalFactorialDesign:折叠与守卫', () => {
  it('2^(3-1) 指定因子折叠(C):追加行仅 C 取反', () => {
    const base = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C')], 1);
    expect(base.rows.map((row) => row.slice(3, 6))).toEqual([
      [-1, -1, 1], [1, -1, -1], [-1, 1, -1], [1, 1, 1],
    ]);
    const folded = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C')], 1, { fold: 2 });
    expect(folded.rows).toHaveLength(8);
    for (let i = 0; i < 4; i++) {
      const orig = base.rows[i].slice(3, 6);
      const mirror = folded.rows[4 + i].slice(3, 6);
      expect(mirror[0]).toBe(orig[0]);
      expect(mirror[1]).toBe(orig[1]);
      expect(mirror[2]).toBe(-orig[2]);
    }
  });
  it('随机化同种子可复现;全因子(p=0)拒绝折叠;非法 p/k/折叠下标拒绝', () => {
    const factors = [pm1('A'), pm1('B'), pm1('C'), pm1('D'), pm1('E')];
    const opt = { fold: 'full' as const, randomize: true, seed: 42 };
    expect(generateFractionalFactorialDesign(factors, 2, opt).rows)
      .toEqual(generateFractionalFactorialDesign(factors, 2, opt).rows);
    expect(() => generateFractionalFactorialDesign(factors, 0, { fold: 'full' })).toThrow('无需折叠');
    expect(() => generateFractionalFactorialDesign(factors, 3)).toThrow('不支持');
    expect(() => generateFractionalFactorialDesign([pm1('A'), pm1('B')], 1)).toThrow('3–7');
    expect(() => generateFractionalFactorialDesign(factors, 1, { fold: 5 })).toThrow('折叠因子下标');
  });
  it('每个标准设计都预检全折叠；四个全反转不增点的组合被准确拦截', () => {
    const noOp: string[] = [];
    for (let k = 3; k <= 7; k++) {
      for (const option of fractionalDesignOptions(k).filter((candidate) => candidate.p > 0)) {
        const preview = fractionalFoldPreview(k, option.p, 'full');
        if (!preview.effective) noOp.push(`${k}-${option.p}`);
        else {
          expect(preview.addedRuns).toBe(preview.baseRuns);
          expect(preview.totalRuns).toBe(preview.baseRuns * 2);
        }
      }
    }
    expect(noOp).toEqual(['4-1', '6-1', '6-2', '7-3']);
  });
  it('支持选择 2^p 个分部，并把负生成元写入审计元数据', () => {
    const main = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C'), pm1('D')], 1, { fraction: 1 });
    const complement = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C'), pm1('D')], 1, { fraction: 2 });
    expect(main.generators).toEqual(['D=ABC']);
    expect(complement.generators).toEqual(['D=−ABC']);
    expect(complement.fraction).toBe(2);
    expect(new Set([...main.rows, ...complement.rows].map((row) => row.slice(3, 7).join(','))).size).toBe(16);
    expect(() => generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C'), pm1('D')], 1, { fraction: 3 })).toThrow(/1–2/);
  });
  it('p=0 生成 2^k 全因子;仿行数生效', () => {
    const d = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C')], 0, { replicates: 2 });
    expect(d.rows).toHaveLength(16);
    expect(d.resolutionLabel).toBe('完全');
    expect(d.generators).toEqual([]);
  });
});

describe('折叠后的别名结构:现有两水平分析引擎直接可用', () => {
  it('2^(3-1) C=AB 全折叠 8 行:C 主效应可估(与 A×B 解除混杂),A×B×C 与折叠区组混杂被剔除', () => {
    const folded = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C')], 1, { fold: 'full' });
    const cols = (j: number) => folded.rows.map((row) => row[j]);
    const blocks = cols(2);
    // 构造带 C 效应与区组差的响应:y = 10 + 5A + 3C + 2·1{区组2}
    const y = folded.rows.map((row) => 10 + 5 * row[3] + 3 * row[5] + (row[2] === 2 ? 2 : 0));
    const detected = detectFactorial(
      [{ name: 'A', values: cols(3) }, { name: 'B', values: cols(4) }, { name: 'C', values: cols(5) }],
      y, { blocks },
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const names = result.terms.map((term) => term.name);
    expect(names).toContain('C');            // 折叠前 C=AB 混杂;折叠后 C 可估
    expect(names).toContain('A×B');          // 二因子交互同样解除混杂
    expect(result.droppedTerms).toContain('A×B×C'); // I=±ABC → 三因子交互与折叠区组混杂
    expect(result.terms.find((term) => term.name === 'C')?.effect).toBeCloseTo(6, 8); // 效应 = 2×系数 = 2×3
    expect(result.terms.find((term) => term.name === 'A')?.effect).toBeCloseTo(10, 8);
    expect(result.block).toMatchObject({ df: 1 });
  });
  it('未折叠 2^(3-1):C 与 A×B 完全混杂,引擎按低阶优先保留 C', () => {
    const base = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C')], 1);
    const cols = (j: number) => base.rows.map((row) => row[j]);
    const detected = detectFactorial(
      [{ name: 'A', values: cols(3) }, { name: 'B', values: cols(4) }, { name: 'C', values: cols(5) }],
      [20, 30, 26, 40],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.terms.map((term) => term.name)).toContain('C');
    expect(result.droppedTerms).toContain('A×B');
    expect(result.aliases).toContainEqual({ term: 'A×B', with: 'C', relation: 'same' });
  });
});

describe('2^(5-2) D=AB,E=AC:分析端 estimableColumns 正确处理别名列', () => {
  it('5 因子 8 行:主效应全部保留,A×B/A×C 分别与 D/E 同列被剔除', () => {
    const d = generateFractionalFactorialDesign([pm1('A'), pm1('B'), pm1('C'), pm1('D'), pm1('E')], 2);
    expect(d.rows).toHaveLength(8);
    // 生成元自检:每一行 D=A·B,E=A·C
    for (const row of d.rows) {
      expect(row[6]).toBe(row[3] * row[4]);
      expect(row[7]).toBe(row[3] * row[5]);
    }
    const cols = (j: number) => d.rows.map((row) => row[j]);
    const detected = detectFractionalFactorial(
      ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ name, values: cols(3 + i) })),
      [12, 30, 24, 33, 18, 21, 27, 45],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFractionalFactorial(detected.design);
    const names = result.terms.map((term) => term.name);
    for (const main of ['A', 'B', 'C', 'D', 'E']) expect(names).toContain(main);
    expect(result.droppedTerms).toContain('A×B');
    expect(result.droppedTerms).toContain('A×C');
    expect(result.aliases).toContainEqual({ term: 'A×B', with: 'D', relation: 'same' });
    expect(result.aliases).toContainEqual({ term: 'A×C', with: 'E', relation: 'same' });
    expect(result.method).toBe('lenth'); // 8 行饱和
    expect(result.terms.every((term) => Number.isFinite(term.effect))).toBe(true);
  });
});

describe('放宽版入口与既有 4 因子上限的关系', () => {
  it('detectFactorial 仍拒绝 5 因子;detectFractionalFactorial 支持至 7、拒绝 8', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
      name: `F${i}`, values: [0, 1, 0, 1, 0, 1, 0, 1].map((v, r) => ((r >> (i % 3)) & 1) ^ v),
    }));
    const y = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(detectFactorial(mk(5), y)).toMatchObject({ ok: false, reason: expect.stringContaining('最多支持 4 个') });
    expect(detectFractionalFactorial(mk(8), y)).toMatchObject({ ok: false, reason: expect.stringContaining('最多支持 7 个') });
    expect(MAX_FRACTIONAL_FACTORS).toBe(7);
  });
  it('analyzeFractionalFactorial 在 ≤4 因子上与 analyzeFactorial 完全一致(同一核心)', () => {
    const detected = detectFactorial(
      [
        { name: 'A', values: [0, 1, 0, 1, 0, 1, 0, 1] },
        { name: 'B', values: [0, 0, 1, 1, 0, 0, 1, 1] },
      ],
      [10, 30, 12, 33, 11, 29, 13, 31],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const a = analyzeFactorial(detected.design);
    const b = analyzeFractionalFactorial(detected.design);
    expect(b.terms).toEqual(a.terms);
    expect(b.mse).toBe(a.mse);
    expect(b.dfResid).toBe(a.dfResid);
  });
  it('resolveDoeColumnsWide 支持 7 因子;resolveDoeColumns 保持 4 因子截断不变', () => {
    const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Y'];
    expect(resolveDoeColumnsWide(cols, null, null)).toEqual({ factorIdx: [0, 1, 2, 3, 4, 5, 6], respIdx: 7 });
    expect(resolveDoeColumns(cols, null, null)).toEqual({ factorIdx: [0, 1, 2, 3], respIdx: 7 });
  });
});
