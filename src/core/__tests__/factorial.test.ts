/** 泛化 DOE:检测 / 编码 / 效应 / 显著性 / 设计生成。 */
import { describe, it, expect } from 'vitest';
import {
  detectFactorial, analyzeFactorial, factorialCornerOptimum, factorialOptimizationDecision, factorialAdjustedMainMeans, factorialAdjustedInteractionMeans,
  generateFactorialDesign, resolveDoeColumns, DOE_DESIGN, analyzeDoe,
  factorialModelTerms, buildDoeStructuredReport, buildDoeWorksheetOutput,
} from '../doe';

// 用演示 2³ 数据(A/B/C 标准序)构造「宽表」因子列验证与 analyzeDoe 一致
const demo = DOE_DESIGN;
const A = demo.map((d) => (d[0] === '+' ? 1 : 0)); // 物理值用 0/1
const B = demo.map((d) => (d[1] === '+' ? 1 : 0));
const C = demo.map((d) => (d[2] === '+' ? 1 : 0));
const Y = demo.map((d) => d[3]);

describe('detectFactorial', () => {
  it('两水平因子正确编码 -1/+1', () => {
    const r = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], Y.slice());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.design.coded[0]).toEqual([-1, -1]); // A低 B低
      expect(r.design.coded[3]).toEqual([1, 1]);    // 第4行 A高 B高(标准序)
      expect(r.design.levels[0]).toMatchObject({ low: 0, high: 1, hasCenter: false });
    }
  });
  it('含中心点(3 水平且中值=中点)识别为 hasCenter', () => {
    const f = [0, 1, 0.5, 0, 1]; const y = [10, 20, 15, 12, 22];
    const g = [0, 1, 0.5, 1, 0];
    const r = detectFactorial([{ name: 'X', values: f }, { name: 'Z', values: g }], y);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.design.levels[0].hasCenter).toBe(true);
  });
  it('拒绝伪中心点:各因子中值分散在不同运行', () => {
    // A 的中值在第 2 行，B 的中值在第 4 行；每列单独看都像「三水平+中值」，
    // 但没有任何一行是所有因子同时取中值的合法中心点。
    const r = detectFactorial(
      [
        { name: 'A', values: [0, 0.5, 1, 0, 1] },
        { name: 'B', values: [0, 1, 0, 0.5, 1] },
      ],
      [10, 15, 20, 17, 25],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('所有因子在同一运行中同时取');
  });
  it('拒绝:>3 水平 / 单水平 / 因子<2', () => {
    expect(detectFactorial([{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [1, 1, 2, 2] }], [1, 2, 3, 4]).ok).toBe(false);
    expect(detectFactorial([{ name: 'A', values: [1, 1, 1, 1] }, { name: 'B', values: [1, 2, 1, 2] }], [1, 2, 3, 4]).ok).toBe(false);
    expect(detectFactorial([{ name: 'A', values: [1, 2, 1, 2] }], [1, 2, 3, 4]).ok).toBe(false);
  });
  it('拒绝重名因子与非有限输入，不让 NaN 进入模型', () => {
    expect(detectFactorial(
      [{ name: 'A', values: [-1, 1, -1, 1] }, { name: 'A', values: [-1, -1, 1, 1] }],
      [1, 2, 3, 4],
    )).toMatchObject({ ok: false, reason: expect.stringContaining('不能重复') });
    expect(detectFactorial(
      [{ name: 'A', values: [-1, 1, -1, 1] }, { name: 'B', values: [-1, -1, 1, 1] }],
      [1, 2, Number.NaN, 4],
    )).toMatchObject({ ok: false, reason: expect.stringContaining('响应列') });
  });

  it('中心点规整性按因子量程判断，极小单位不会被固定绝对 epsilon 放宽', () => {
    const tinyInvalid = detectFactorial(
      [
        { name: 'A', values: [1e-12, 3e-12, 1e-12, 3e-12, 2.5e-12, 2.5e-12] },
        { name: 'B', values: [2e-15, 2e-15, 6e-15, 6e-15, 5e-15, 5e-15] },
      ],
      [10, 20, 14, 30, 16, 17],
    );
    expect(tinyInvalid).toMatchObject({ ok: false, reason: expect.stringContaining('非规整水平') });

    for (const map of [
      (value: number) => value * 1e-12,
      (value: number) => 1e12 + value,
    ]) {
      const valid = detectFactorial(
        [
          { name: 'A', values: [0, 2, 0, 2, 1, 1].map(map) },
          { name: 'B', values: [10, 10, 14, 14, 12, 12].map(map) },
        ],
        [10, 20, 14, 30, 16, 17],
      );
      expect(valid.ok).toBe(true);
    }
  });
});

describe('DOE 数值结论对响应单位与基准值不变', () => {
  const factorA = [0, 1, 0, 1, 0, 1, 0, 1];
  const factorB = [0, 0, 1, 1, 0, 0, 1, 1];

  it('t 检验、P 值和标准化残差在缩放/平移后保持一致', () => {
    const response = [10, 30, 12, 33, 11, 29, 13, 31];
    const fit = (values: number[]) => {
      const detected = detectFactorial(
        [{ name: 'A', values: factorA }, { name: 'B', values: factorB }],
        values,
      );
      expect(detected.ok).toBe(true);
      if (!detected.ok) throw new Error(detected.reason);
      return analyzeFactorial(detected.design);
    };
    const base = fit(response);
    const tiny = fit(response.map((value) => value * 1e-14));
    const shifted = fit(response.map((value) => 1e6 + value * 0.1));
    for (const candidate of [tiny, shifted]) {
      expect(candidate.terms.map((term) => [term.name, term.sig])).toEqual(base.terms.map((term) => [term.name, term.sig]));
      for (const term of base.terms) {
        const actual = candidate.terms.find((item) => item.name === term.name)!;
        expect(actual.tStat).toBeCloseTo(term.tStat!, 6);
        expect(actual.p).toBeCloseTo(term.p!, 8);
      }
      expect(candidate.stdResiduals).toHaveLength(base.stdResiduals!.length);
      candidate.stdResiduals!.forEach((value, row) => expect(value).toBeCloseTo(base.stdResiduals![row], 6));
    }
  });

  it('饱和设计的零 PSE 不把零效应判显著，也不设物理单位下限', () => {
    const fit = (response: number[]) => {
      const detected = detectFactorial(
        [{ name: 'A', values: factorA.slice(0, 4) }, { name: 'B', values: factorB.slice(0, 4) }],
        response,
      );
      expect(detected.ok).toBe(true);
      if (!detected.ok) throw new Error(detected.reason);
      return analyzeFactorial(detected.design);
    };
    const base = fit([0, 1, 0, 1]);
    const tiny = fit([0, 1e-15, 0, 1e-15]);
    const shifted = fit([1e9, 1e9 + 1e-5, 1e9, 1e9 + 1e-5]);
    for (const result of [base, tiny, shifted]) {
      expect(result.pse).toBe(0);
      expect(result.me).toBe(0);
      expect(result.terms.find((term) => term.name === 'A')?.sig).toBe(true);
      expect(result.terms.filter((term) => term.name !== 'A').every((term) => !term.sig)).toBe(true);
    }
    expect(analyzeDoe(Array(8).fill(3)).terms.every((term) => !term.sig)).toBe(true);
  });

  it('最优角点按效应对比而非大截距判并列', () => {
    const response = factorA.map((a, row) => 10 * a + 2 * factorB[row]);
    const fit = (values: number[]) => {
      const detected = detectFactorial(
        [{ name: 'A', values: factorA }, { name: 'B', values: factorB }],
        values,
      );
      expect(detected.ok).toBe(true);
      if (!detected.ok) throw new Error(detected.reason);
      return { result: analyzeFactorial(detected.design), design: detected.design };
    };
    const base = fit(response);
    const shifted = fit(response.map((value) => value + 1e12));
    expect(factorialCornerOptimum(base.result, base.design)).toMatchObject({ coded: [1, 1], unique: true });
    expect(factorialCornerOptimum(shifted.result, shifted.design)).toMatchObject({ coded: [1, 1], unique: true });
  });

  it('因子物理量缩放后保持同一别名与秩判定', () => {
    const fit = (scale: number, offset: number) => {
      const rawA = [-1, 1, -1, 1];
      const rawB = [-1, -1, 1, 1];
      const rawC = [1, -1, -1, 1];
      const map = (value: number) => offset + scale * value;
      const detected = detectFactorial(
        [
          { name: 'A', values: rawA.map(map) },
          { name: 'B', values: rawB.map(map) },
          { name: 'C', values: rawC.map(map) },
        ],
        [20, 30, 26, 40],
      );
      expect(detected.ok).toBe(true);
      if (!detected.ok) throw new Error(detected.reason);
      return analyzeFactorial(detected.design);
    };
    for (const result of [fit(1, 0), fit(1e-18, 0), fit(2, 1e12)]) {
      expect(result.droppedTerms).toContain('A×B');
      expect(result.aliases).toContainEqual({ term: 'A×B', with: 'C', relation: 'same' });
    }
  });

  it('直接传入退化编码或空模型时明确拒绝，不返回截距伪分析', () => {
    const detected = detectFactorial(
      [{ name: 'A', values: factorA.slice(0, 4) }, { name: 'B', values: factorB.slice(0, 4) }],
      [1, 2, 3, 4],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    expect(() => analyzeFactorial(detected.design, { terms: [] })).toThrow('至少需要 1 个合法效应项');
    expect(() => analyzeFactorial({
      ...detected.design,
      coded: detected.design.coded.map((row) => [-1, row[1]]),
    })).toThrow('每个因子都必须同时包含低水平和高水平');
  });
});

describe('analyzeFactorial 与 analyzeDoe(2³)一致', () => {
  const r = detectFactorial(
    [{ name: 'A', values: A }, { name: 'B', values: B }, { name: 'C', values: C }],
    Y.slice(),
  );
  it('主效应 A/B/C 与 Lenth 演示一致', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    expect(fr.method).toBe('lenth'); // 8 run 饱和
    const legacy = analyzeDoe();
    const getEff = (name: string, terms: { name: string; effect: number }[]) =>
      terms.find((t) => t.name === name)!.effect;
    // 演示 legacy 用「A 温度」等命名;此处因子名为 A/B/C,比较数值
    expect(getEff('A', fr.terms)).toBeCloseTo(legacy.terms.find((t) => t.name.startsWith('A'))!.v, 6);
    expect(getEff('C', fr.terms)).toBeCloseTo(legacy.terms.find((t) => t.name.startsWith('C'))!.v, 6);
    expect(getEff('A×B', fr.terms)).toBeCloseTo(legacy.terms.find((t) => t.name === 'A×B')!.v, 6);
  });
});

describe('analyzeFactorial 带重复用 t 检验', () => {
  it('2² 重复 2 次(8 run)→ ttest,残差自由度>0', () => {
    // 明显的 A 主效应:A=+1 时 y 高约 +20
    const A2 = [0, 1, 0, 1, 0, 1, 0, 1];
    const B2 = [0, 0, 1, 1, 0, 0, 1, 1];
    const y = [10, 30, 12, 33, 11, 29, 13, 31];
    const r = detectFactorial([{ name: 'A', values: A2 }, { name: 'B', values: B2 }], y);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    expect(fr.method).toBe('ttest');
    expect(fr.dfResid).toBeGreaterThan(0);
    const a = fr.terms.find((t) => t.name === 'A')!;
    expect(a.effect).toBeGreaterThan(15);
    expect(a.sig).toBe(true);           // A 显著
    expect(a.p).toBeLessThan(0.05);
  });
});

describe('DOE 交互作用下的角点优化', () => {
  it('不按主效应符号独立推荐，而是枚举完整模型的最优组合', () => {
    const A = [-1, 1, -1, 1, -1, 1, -1, 1];
    const B = [-1, -1, 1, 1, -1, -1, 1, 1];
    const response = A.map((a, index) => a + B[index] - 10 * a * B[index]);
    const detected = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], response);
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.terms.find((term) => term.name === 'A×B')?.sig).toBe(true);
    const optimum = factorialCornerOptimum(result, detected.design);
    expect(optimum.coded).not.toEqual([1, 1]);
    expect(optimum.predicted).toBeCloseTo(10, 8);
  });
});

describe('analyzeFactorial 非正交/不平衡设计用真正的最小二乘', () => {
  it('角点 (1,1) 多一次重复 → OLS 拟合各单元均值(不是单列投影)', () => {
    // (1,1) 出现两次(30,32,均值31),其余各一次;非正交(ΣA≠0)
    const A = [0, 1, 0, 1, 1]; const B = [0, 0, 1, 1, 1];
    const y = [10, 20, 14, 30, 32];
    const r = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    const eff = (n: string) => fr.terms.find((t) => t.name === n)!.effect;
    // 手算 OLS(饱和 2² 拟合单元均值 10,20,14,31):
    expect(eff('A')).toBeCloseTo(13.5, 6);
    expect(eff('B')).toBeCloseTo(7.5, 6);
    expect(eff('A×B')).toBeCloseTo(3.5, 6);
    expect(fr.grand).toBeCloseTo(18.75, 6);   // 截距 = 单元均值之均值
    expect(fr.method).toBe('ttest');
    expect(fr.dfResid).toBe(1);
    expect(fr.mse!).toBeCloseTo(2, 6);         // 纯误差:(30-31)²+(32-31)² = 2,df=1
    // (1,1) 两行拟合到单元均值 31
    r.design.coded.forEach((row, i) => { if (row[0] === 1 && row[1] === 1) expect(fr.fits[i]).toBeCloseTo(31, 6); });
  });
});

describe('analyzeFactorial 中心点给出曲率检验且残差回归纯误差', () => {
  it('2² 单次 + 2 中心点 → 残差=纯误差(df=1),曲率项存在', () => {
    // 物理值:0/1 两水平 + 0.5 中心点
    const Af = [0, 1, 0, 1, 0.5, 0.5]; const Bf = [0, 0, 1, 1, 0.5, 0.5];
    const y = [10, 20, 14, 28, 16, 18];
    const r = detectFactorial([{ name: 'A', values: Af }, { name: 'B', values: Bf }], y);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    expect(fr.method).toBe('ttest');
    expect(fr.dfResid).toBe(1);                // 纯误差 df = 中心点数-1 = 1
    expect(fr.mse!).toBeCloseTo(2, 6);          // (16-17)²+(18-17)² = 2
    expect(fr.curvature).toBeDefined();
    expect(Math.abs(fr.curvature!.coef)).toBeCloseTo(1, 6); // 中心均值17 − 角点均值18 = −1
    expect(fr.terms.find((t) => t.name === 'A')!.effect).toBeCloseTo(12, 6); // ((20+28)-(10+14))/2
  });
});

describe('analyzeFactorial 分数/不完整设计:保留主效应,剔除别名交互', () => {
  it('3 因子仅 4 run(半分数,C=AB)→ 保留主效应 C,丢弃交互 A×B(低阶优先)', () => {
    // 半分数:A,B 全因子,C=A*B;只有 4 个 run。C 与 A×B 别名。
    const A = [0, 1, 0, 1]; const B = [0, 0, 1, 1]; const C = [1, 0, 0, 1]; // C=1 当 A==B(即 C=A·B)
    const y = [20, 30, 26, 40];
    const r = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }, { name: 'C', values: C }], y);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    const names = fr.terms.map((t) => t.name);
    expect(names).toContain('C');        // 主效应 C 被保留(修复前会被丢弃)
    expect(names).not.toContain('A×B');  // 别名交互 A×B 被剔除
    expect(fr.droppedTerms).toContain('A×B');
    expect(fr.aliases).toContainEqual({ term: 'A×B', with: 'C', relation: 'same' });
    expect(fr.terms.every((t) => Number.isFinite(t.effect))).toBe(true); // 无 NaN
  });
});

describe('analyzeFactorial 零残差(完美拟合)下非零效应判为显著', () => {
  it('单元内零变异、单元间有差异 → MSE=0;非零效应显著(p=0),零效应不显著', () => {
    const A = [0, 1, 0, 1, 0, 1, 0, 1];
    const B = [0, 0, 1, 1, 0, 0, 1, 1];
    const y = [10, 20, 10, 20, 10, 20, 10, 20]; // A 效应=10;每个单元两次完全相同
    const r = detectFactorial([{ name: 'A', values: A }, { name: 'B', values: B }], y);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fr = analyzeFactorial(r.design);
    expect(fr.method).toBe('ttest');
    expect(fr.mse!).toBeCloseTo(0, 12);
    const a = fr.terms.find((t) => t.name === 'A')!;
    expect(a.effect).toBeCloseTo(10, 6);
    expect(a.sig).toBe(true);   // 修复前:seEff=0→tStat=0→p=1→误判不显著
    expect(a.p).toBe(0);
    const b = fr.terms.find((t) => t.name === 'B')!;
    expect(b.effect).toBeCloseTo(0, 6);
    expect(b.sig).toBe(false);  // 零效应仍不显著
  });
});

describe('resolveDoeColumns 页面与汇总共用', () => {
  const cols = ['过盈量', '轴硬度', '温度', '时间', '压入力'];
  it('默认:末列为响应、其余前 4 列为因子(4 因子上限)', () => {
    const { factorIdx, respIdx } = resolveDoeColumns(cols, null, null);
    expect(respIdx).toBe(4);
    expect(factorIdx).toEqual([0, 1, 2, 3]);
  });
  it('6 列时因子截断到 4(与 detectFactorial 上限一致,避免页面/汇总口径分歧)', () => {
    const six = [...cols, '扭矩']; // 6 列
    const { factorIdx, respIdx } = resolveDoeColumns(six, null, null);
    expect(respIdx).toBe(5);
    expect(factorIdx).toHaveLength(4);
  });
  it('按列名选择,失效名回落默认', () => {
    const r = resolveDoeColumns(cols, ['轴硬度', '温度'], '压入力');
    expect(r.respIdx).toBe(4);
    expect(r.factorIdx).toEqual([1, 2]);
    const stale = resolveDoeColumns(cols, ['不存在1', '不存在2'], '压入力');
    expect(stale.factorIdx).toEqual([0, 1, 2, 3]); // 名称失效 → 默认前 4 列
  });
  it('Minitab/本平台元数据与旧 DOE 输出列不会被误选为因子', () => {
    const meta = ['StdOrder', 'RunOrder', 'PtType', 'Blocks', '过盈量', '轴硬度', '压入力', 'Fits1', 'RESI1', 'SRES1'];
    expect(resolveDoeColumns(meta, null, null)).toEqual({ factorIdx: [4, 5], respIdx: 6 });
  });
});

describe('generateFactorialDesign', () => {
  it('2 因子 + 2 中心点 = 4 角 + 2 中心 = 6 run,末列空响应', () => {
    const d = generateFactorialDesign(
      [{ name: '过盈量', low: 0.045, high: 0.09 }, { name: '轴硬度', low: 28, high: 32 }],
      { centerPoints: 2 },
    );
    expect(d.colNames).toEqual(['标准序', '运行序', '区组', '过盈量', '轴硬度', '响应(待录入)']);
    expect(d.rows).toHaveLength(6);
    // 角点覆盖 4 组合
    const corners = d.rows.filter((r) => r[3] !== 0.0675);
    expect(corners).toHaveLength(4);
    // 中心点在中值
    const centers = d.rows.filter((r) => r[3] === 0.0675 && r[4] === 30);
    expect(centers).toHaveLength(2);
    expect(d.rows.every((r) => r[d.responseCol] === 0)).toBe(true);
    expect(d.textCols[0]).toEqual({ name: '点类型', values: ['因子点', '因子点', '因子点', '因子点', '中心点', '中心点'] });
  });
  it('随机种子可复现', () => {
    const opt = { randomize: true, seed: 42 };
    const f = [{ name: 'A', low: 0, high: 1 }, { name: 'B', low: 0, high: 1 }];
    expect(generateFactorialDesign(f, opt).rows).toEqual(generateFactorialDesign(f, opt).rows);
  });
  it('3 因子 4 区组：保存标准序/运行序/区组，区组内随机且主效应平衡', () => {
    const d = generateFactorialDesign(
      [{ name: 'A', low: -1, high: 1 }, { name: 'B', low: -1, high: 1 }, { name: 'C', low: -1, high: 1 }],
      { blocks: 4, centerPoints: 1, randomize: true, seed: 42 },
    );
    expect(d.rows).toHaveLength(12);
    expect(d.rows.map((row) => row[1])).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(new Set(d.rows.map((row) => row[0])).size).toBe(12);
    for (let block = 1; block <= 4; block++) {
      const factorRuns = d.rows.filter((row, i) => row[2] === block && d.textCols[0].values[i] === '因子点');
      expect(factorRuns).toHaveLength(2);
      for (let factor = 3; factor <= 5; factor++) {
        expect(factorRuns.map((row) => row[factor]).sort()).toEqual([-1, 1]);
      }
    }
  });
  it('区组效应作为扰动项入模，不误报为与生成元混杂的交互效应', () => {
    const generated = generateFactorialDesign(
      [{ name: 'A', low: -1, high: 1 }, { name: 'B', low: -1, high: 1 }],
      { blocks: 2 },
    );
    const blocks = generated.rows.map((row) => row[2]);
    const response = blocks.map((block) => block === 1 ? 100 : 0);
    const detected = detectFactorial(
      [
        { name: 'A', values: generated.rows.map((row) => row[3]) },
        { name: 'B', values: generated.rows.map((row) => row[4]) },
      ],
      response,
      { blocks },
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.block).toMatchObject({ levels: ['1', '2'], df: 1, coefficients: [{ level: '2', coef: -100 }] });
    expect(result.droppedTerms).toContain('A×B');
    expect(result.terms.find((term) => term.name === 'A×B')).toBeUndefined();
    expect(result.terms.filter((term) => term.sig)).toHaveLength(0);
    expect(result.fits).toEqual(response);
  });
  it('非平衡区组的图使用模型调整均值，不被原始边际构成反转方向', () => {
    const factorA: number[] = [];
    const factorB: number[] = [];
    const blocks: number[] = [];
    const response: number[] = [];
    const add = (block: number, a: number, b: number, repeats: number) => {
      for (let i = 0; i < repeats; i++) {
        factorA.push(a);
        factorB.push(b);
        blocks.push(block);
        response.push((block === 1 ? 100 : 0) + 10 * a);
      }
    };
    // 区组1高基线且 A低占 8/10；区组2低基线且 A高占 8/10。
    for (const b of [-1, 1]) {
      add(1, -1, b, 4); add(1, 1, b, 1);
      add(2, -1, b, 1); add(2, 1, b, 4);
    }
    const detected = detectFactorial(
      [{ name: 'A', values: factorA }, { name: 'B', values: factorB }], response, { blocks },
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.terms.find((term) => term.name === 'A')?.effect).toBeCloseTo(20, 10);
    const adjusted = factorialAdjustedMainMeans(result, detected.design);
    expect(adjusted.find((factor) => factor.name === 'A')?.lo).toBeCloseTo(40, 10);
    expect(adjusted.find((factor) => factor.name === 'A')?.hi).toBeCloseTo(60, 10);
    const interaction = factorialAdjustedInteractionMeans(result, detected.design, 0, 1);
    expect(interaction.c00).toBeCloseTo(40, 10);
    expect(interaction.c10).toBeCloseTo(60, 10);
    expect(interaction.c01).toBeCloseTo(40, 10);
    expect(interaction.c11).toBeCloseTo(60, 10);
    expect(factorialCornerOptimum(result, detected.design).coded[0]).toBe(1);
  });
  it('无显著项不推荐角点；仅 A 有效时报告 B 方向并列而非冒充唯一最优', () => {
    const detected = detectFactorial(
      [
        { name: 'A', values: [-1, 1, -1, 1, -1, 1, -1, 1] },
        { name: 'B', values: [-1, -1, 1, 1, -1, -1, 1, 1] },
      ],
      [10, 20, 10, 20, 10, 20, 10, 20],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const onlyA = analyzeFactorial(detected.design);
    const tied = factorialOptimizationDecision(onlyA, detected.design);
    expect(tied.status).toBe('tied');
    expect(tied.optimum?.ties).toHaveLength(2);
    expect(tied.fixedCoded).toEqual([1, null]);

    const flatDesign = { ...detected.design, response: detected.design.response.map(() => 10) };
    const flat = analyzeFactorial(flatDesign);
    expect(factorialOptimizationDecision(flat, flatDesign)).toEqual({ status: 'no-significant-effect' });
  });
  it('只有曲率显著时优先建议响应曲面，不能误报为“无显著项、增加中心点”', () => {
    const detected = detectFactorial(
      [
        { name: 'A', values: [0, 1, 0, 1, 0.5, 0.5] },
        { name: 'B', values: [0, 0, 1, 1, 0.5, 0.5] },
      ],
      [10, 10, 10, 10, 30, 30],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.terms.every((term) => !term.sig)).toBe(true);
    expect(result.curvature?.sig).toBe(true);
    expect(factorialOptimizationDecision(result, detected.design)).toEqual({ status: 'significant-curvature' });
  });
  it('4 因子创建路径可用，并拒绝重名/倒置水平/非整数设计参数', () => {
    const factors = [
      { name: 'A', low: -1, high: 1 }, { name: 'B', low: -1, high: 1 },
      { name: 'C', low: -1, high: 1 }, { name: 'D', low: -1, high: 1 },
    ];
    const design = generateFactorialDesign(factors, { blocks: 8, centerPoints: 1 });
    expect(design.rows).toHaveLength(24);
    expect(design.colNames).toEqual(['标准序', '运行序', '区组', 'A', 'B', 'C', 'D', '响应(待录入)']);
    expect(() => generateFactorialDesign([{ ...factors[0] }, { ...factors[1], name: 'A' }])).toThrow('因子名不能重复');
    expect(() => generateFactorialDesign([{ ...factors[0], low: 1, high: -1 }, factors[1]])).toThrow('低水平 < 高水平');
    expect(() => generateFactorialDesign(factors, { replicates: 1.5 })).toThrow('重复数');
  });
});

describe('人工反馈 DOE 精确 7 行闭环', () => {
  const factorA = [1, 1, 0, 0, -1, -1, 0];
  const factorB = [-1, 1, 0, 0, -1, 1, 0];
  const responses = [1180, 1380, 980, 940, 530, 690, 970];
  const detected = detectFactorial(
    [{ name: '过盈量', values: factorA }, { name: '轴硬度', values: factorB }],
    responses,
  );

  it('效应、交互、曲率、残差自由度与原始 7 行数据一致', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    expect(result.method).toBe('ttest');
    expect(result.dfResid).toBe(2);
    expect(result.mse).toBeCloseTo(433.333333, 5);
    expect(result.terms.find((term) => term.name === '过盈量')?.effect).toBeCloseTo(670, 10);
    expect(result.terms.find((term) => term.name === '轴硬度')?.effect).toBeCloseTo(180, 10);
    expect(result.terms.find((term) => term.name === '过盈量×轴硬度')?.effect).toBeCloseTo(20, 10);
    expect(result.curvature?.coef).toBeCloseTo(18.333333, 5);
    expect(result.fits).toHaveLength(7);
    expect(result.stdResiduals?.every(Number.isFinite)).toBe(true);
  });

  it('模型项可选择；专项报告和工作表存储项均为结构化且按行对齐', () => {
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    expect(factorialModelTerms(detected.design.factorNames)).toEqual(['过盈量', '轴硬度', '过盈量×轴硬度']);
    const result = analyzeFactorial(detected.design, { terms: ['过盈量', '轴硬度'], includeCurvature: true });
    expect(result.requestedTerms).toEqual(['过盈量', '轴硬度']);
    expect(result.terms.map((term) => term.name).sort()).toEqual(['轴硬度', '过盈量'].sort());
    const report = buildDoeStructuredReport(detected.design, result, '压入力', [
      { standardOrder: 2, runOrder: 1, block: 1 }, { standardOrder: 4, runOrder: 2, block: 1 },
      { standardOrder: 7, runOrder: 3, block: 1 }, { standardOrder: 6, runOrder: 4, block: 1 },
      { standardOrder: 1, runOrder: 5, block: 1 }, { standardOrder: 3, runOrder: 6, block: 1 },
      { standardOrder: 5, runOrder: 7, block: 1 },
    ]);
    expect(report).toMatchObject({ kind: 'factorial-doe', responseName: '压入力', runCount: 7 });
    expect(report.runs.map((run) => run.observed)).toEqual(responses);
    expect(report.runs.map((run) => run.standardOrder)).toEqual([2, 4, 7, 6, 1, 3, 5]);
    expect(report.runs[0]).toMatchObject({
      runOrder: 1, block: 1, pointType: '因子点', codedLevels: [1, -1], factorValues: [1, -1],
    });
    expect(report.runs[2]).toMatchObject({ pointType: '中心点', codedLevels: [0, 0], factorValues: [0, 0] });
    expect(report.model.requestedTerms).toEqual(['过盈量', '轴硬度']);
    expect(report.model.droppedTerms).toEqual([]);
    const output = buildDoeWorksheetOutput(result);
    expect(output.numericColumns.find((column) => column.name === 'DOE拟合值')?.values).toEqual(result.fits);
    expect(output.numericColumns.find((column) => column.name === 'DOE残差')?.values).toEqual(result.residuals);
    expect(output.numericColumns.find((column) => column.name === 'DOE标准化残差')?.values).toEqual(result.stdResiduals);
    expect(output.textColumns.find((column) => column.name === 'DOE模型项')?.values.slice(0, 4)).toEqual(['常量', ...result.terms.map((term) => term.name), '曲率']);
  });
});
