/** 泛化 DOE:检测 / 编码 / 效应 / 显著性 / 设计生成。 */
import { describe, it, expect } from 'vitest';
import { detectFactorial, analyzeFactorial, generateFactorialDesign, resolveDoeColumns, DOE_DESIGN, analyzeDoe } from '../doe';

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
  it('拒绝:>3 水平 / 单水平 / 因子<2', () => {
    expect(detectFactorial([{ name: 'A', values: [1, 2, 3, 4] }, { name: 'B', values: [1, 1, 2, 2] }], [1, 2, 3, 4]).ok).toBe(false);
    expect(detectFactorial([{ name: 'A', values: [1, 1, 1, 1] }, { name: 'B', values: [1, 2, 1, 2] }], [1, 2, 3, 4]).ok).toBe(false);
    expect(detectFactorial([{ name: 'A', values: [1, 2, 1, 2] }], [1, 2, 3, 4]).ok).toBe(false);
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
});

describe('generateFactorialDesign', () => {
  it('2 因子 + 2 中心点 = 4 角 + 2 中心 = 6 run,末列空响应', () => {
    const d = generateFactorialDesign(
      [{ name: '过盈量', low: 0.045, high: 0.09 }, { name: '轴硬度', low: 28, high: 32 }],
      { centerPoints: 2 },
    );
    expect(d.colNames).toEqual(['过盈量', '轴硬度', '响应(待录入)']);
    expect(d.rows).toHaveLength(6);
    // 角点覆盖 4 组合
    const corners = d.rows.filter((r) => r[0] !== 0.0675);
    expect(corners).toHaveLength(4);
    // 中心点在中值
    const centers = d.rows.filter((r) => r[0] === 0.0675 && r[1] === 30);
    expect(centers).toHaveLength(2);
    expect(d.rows.every((r) => r[2] === 0)).toBe(true);
  });
  it('随机种子可复现', () => {
    const opt = { randomize: true, seed: 42 };
    const f = [{ name: 'A', low: 0, high: 1 }, { name: 'B', low: 0, high: 1 }];
    expect(generateFactorialDesign(f, opt).rows).toEqual(generateFactorialDesign(f, opt).rows);
  });
});
