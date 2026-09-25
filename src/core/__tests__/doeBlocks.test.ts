/** v1.43.0(双审 P1 整改)回归:两水平全因子区组生成元必须走标准最小畸变方案——
 * 旧实现固定用 A×B、A×C… 作生成元,把一批二因子交互混杂进区组,强交互场景下
 * 「最优设置」推荐可落到全部角点中最差之一(审计端到端反例)。 */
import { describe, it, expect } from 'vitest';
import { generateFactorialDesign, detectFactorial, analyzeFactorial } from '../doe';

const F = (k: number) => ['A', 'B', 'C', 'D'].slice(0, k).map((name) => ({ name, low: -1, high: 1 }));

/** rows: [标准序, 运行序, 区组, ...因子物理值];因子物理值 ±1 即编码值 */
function runsOf(design: ReturnType<typeof generateFactorialDesign>, k: number) {
  return design.rows
    .filter((_, i) => design.textCols[0].values[i] === '因子点')
    .map((row) => ({ block: row[2] as number, signs: (row.slice(3, 3 + k) as number[]).map((v) => (v > 0 ? 1 : -1)) }));
}

/** 找出与区组混杂的效应字(在每个区组内取值恒定的因子乘积) */
function confoundedWords(runs: { block: number; signs: number[] }[], k: number): string[] {
  const letters = ['A', 'B', 'C', 'D'];
  const byBlock = new Map<number, number[][]>();
  runs.forEach((r) => { const arr = byBlock.get(r.block) ?? []; arr.push(r.signs); byBlock.set(r.block, arr); });
  const out: string[] = [];
  for (let mask = 1; mask < (1 << k); mask++) {
    const constant = [...byBlock.values()].every((rows) => {
      const vals = rows.map((signs) => signs.reduce((p, v, i) => (((mask >> i) & 1) ? p * v : p), 1));
      return new Set(vals).size === 1;
    });
    if (constant) out.push(letters.filter((_, i) => (mask >> i) & 1).join(''));
  }
  return out;
}

describe('区组生成元 = 标准最小畸变方案', () => {
  it('2^3 / 2 区组:混杂 ABC(而非旧实现的 AB),全部二因子交互可估计', () => {
    const design = generateFactorialDesign(F(3), { blocks: 2, randomize: false });
    expect(confoundedWords(runsOf(design, 3), 3)).toEqual(['ABC']);
  });

  it('2^3 / 4 区组:混杂全部三个二因子交互(AB/AC/BC,标准表,不可避免)', () => {
    const design = generateFactorialDesign(F(3), { blocks: 4, randomize: false });
    expect(confoundedWords(runsOf(design, 3), 3)).toEqual(['AB', 'AC', 'BC']);
  });

  it('2^4 / 2 区组:混杂 ABCD', () => {
    const design = generateFactorialDesign(F(4), { blocks: 2, randomize: false });
    expect(confoundedWords(runsOf(design, 4), 4)).toEqual(['ABCD']);
  });

  it('2^4 / 4 区组:采用 Minitab 默认生成元 BC、ABD，主效应均可估计', () => {
    const design = generateFactorialDesign(F(4), { blocks: 4, randomize: false });
    const words = confoundedWords(runsOf(design, 4), 4);
    // Minitab 官方默认表：4(BC, ABD)，其乘积为 ACD。
    expect(words).toEqual(['BC', 'ABD', 'ACD']);
  });

  it('2^4 / 8 区组:采用 Minitab 默认生成元 AB、BC、CD', () => {
    const design = generateFactorialDesign(F(4), { blocks: 8, randomize: false });
    const words = confoundedWords(runsOf(design, 4), 4);
    expect(words).toEqual(['AB', 'AC', 'BC', 'AD', 'BD', 'CD', 'ABCD']);
  });

  it('2^2 / 2 区组:仍是 AB(与旧行为一致,标准序测试不受影响)', () => {
    const design = generateFactorialDesign(F(2), { blocks: 2, randomize: false });
    expect(confoundedWords(runsOf(design, 2), 2)).toEqual(['AB']);
  });
});

describe('端到端(审计反例):强 A×B 拮抗交互 + 4 区组', () => {
  it('A×B 仍可估计且效应 ≈ −20,不再被整项剔除', () => {
    const design = generateFactorialDesign(F(4), { blocks: 4, randomize: false });
    const runs = runsOf(design, 4);
    const y = runs.map(({ signs: s }) => 100 + 2 * s[0] + 2 * s[1] + 0.4 * s[2] + 0.3 * s[3] - 10 * s[0] * s[1]);
    const det = detectFactorial(
      ['A', 'B', 'C', 'D'].map((name, i) => ({ name, values: runs.map((r) => r.signs[i]) })),
      y,
    );
    expect(det.ok).toBe(true);
    if (!det.ok) return;
    const res = analyzeFactorial(det.design, { blocks: runs.map((r) => String(r.block)) });
    expect((res.aliases ?? []).map((a) => a.term)).not.toContain('A×B');
    const ab = res.terms.find((t) => t.name === 'A×B');
    expect(ab).toBeDefined();
    expect(ab!.effect).toBeCloseTo(-20, 8);
    // 真最优角点 A=低/B=高:y = 100 −2 +2 ±0.4 ±0.3 +10 → C/D 取高时 110.7
    // 模型含 A×B 后角点预测应复现该结构:A=高/B=高(旧实现的推荐)不再是并列最大
    const predict = (s: number[]) => res.grand
      + res.terms.reduce((acc, t) => {
        const parts = t.name.split('×');
        const idx = parts.map((nm) => res.factorNames.indexOf(nm));
        return acc + (t.effect / 2) * idx.reduce((p, i2) => p * s[i2], 1);
      }, 0);
    expect(predict([-1, 1, 1, 1])).toBeGreaterThan(predict([1, 1, 1, 1]) + 10);
  });
});
