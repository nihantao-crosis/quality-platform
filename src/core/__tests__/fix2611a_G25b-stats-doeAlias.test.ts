/**
 * fix2611a G25b-stats B3(附录 F.2-7):DOE 混杂提示按「区组混杂 / 生成元别名 / 其他线性相关」分句,
 * 列表封顶并如实给出总数;无区组设计不得出现「区组」字样。
 * 全部 alias 由真实引擎(generate* → detect* → analyze*)产出,不手写引擎产不出的形状。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeFactorial, analyzeFractionalFactorial, buildDoeConclusion, CONFOUNDED_NOTE_TERM_CAP,
  confoundedInteractionNote, detectFactorial, detectFractionalFactorial, doeInteractionNote,
  generateFactorialDesign, generateFractionalFactorialDesign, type FactorialAlias,
} from '../doe';

const STATUSES = ['no-significant-effect', 'significant-curvature', 'tied', 'unique'] as const;

function conclusionBase(aliases: FactorialAlias[] | undefined) {
  return {
    aliases, hasSignificantInteraction: false, sigTermNames: ['A'], detail: 'Lenth 检验',
    factorCount: 4, respName: 'Y', settings: 'A=+1', tieCount: 2, fixedSettings: 'A=+1',
  };
}

/** 2^4 分 4 区组(Minitab 默认生成元 BC、ABD,乘积 ACD)。 */
function blockedAliases() {
  const names = ['A', 'B', 'C', 'D'];
  const design = generateFactorialDesign(names.map((name) => ({ name, low: -1, high: 1 })), { blocks: 4, randomize: false });
  const k = names.length;
  const signs = design.rows.map((row) => (row.slice(3, 3 + k) as number[]).map((value) => (value > 0 ? 1 : -1)));
  const blocks = design.rows.map((row) => String(row[2]));
  const response = signs.map((s, row) => 50 + 3 * s[0] - 2 * s[1] + s[2] + 0.5 * s[3] + 0.1 * ((row * 7) % 5));
  const detected = detectFactorial(names.map((name, j) => ({ name, values: signs.map((s) => s[j]) })), response);
  if (!detected.ok) throw new Error(detected.reason);
  return analyzeFactorial(detected.design, { blocks }).aliases ?? [];
}

/** 2^(k−p) 无区组分式设计。 */
function fractionalAliases(k: number, p: number) {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].slice(0, k);
  const design = generateFractionalFactorialDesign(names.map((name) => ({ name, low: -1, high: 1 })), p);
  const detected = detectFractionalFactorial(
    names.map((name, j) => ({ name, values: design.rows.map((row) => row[3 + j]) })),
    design.rows.map((_, row) => 10 + ((row * 37) % 11)),
  );
  if (!detected.ok) throw new Error(detected.reason);
  return analyzeFractionalFactorial(detected.design).aliases ?? [];
}

describe('B3 区组混杂与生成元别名分句', () => {
  it('引擎把真正的区组混杂标成 confoundedWithBlocks,提示只建议减少区组数/增加仿行', () => {
    const aliases = blockedAliases();
    for (const term of ['B×C', 'A×B×D', 'A×C×D']) {
      expect(aliases).toContainEqual({
        term, with: '已保留模型项的线性组合', relation: 'linear-dependent', confoundedWithBlocks: true,
      });
    }
    const note = confoundedInteractionNote(aliases)!;
    expect(note).toContain('B×C、A×B×D、A×C×D 与区组混杂');
    expect(note).toContain('减少区组数或增加仿行');
    expect(note).toContain('无法检验');
    expect(note).not.toContain('分辨率');
    expect(note).not.toContain('别名');
  });

  it('无区组的 2^(5−2) 分式设计:只给生成元别名句,全文不出现「区组」', () => {
    const aliases = fractionalAliases(5, 2);
    expect(aliases.every((alias) => alias.confoundedWithBlocks === undefined)).toBe(true);
    const note = confoundedInteractionNote(aliases)!;
    expect(note).toContain('A×B(=D)');
    expect(note).toContain('A×C(=E)');
    expect(note).toContain('互为别名');
    expect(note).toContain('提高设计分辨率或折叠设计');
    expect(note).toContain('无法检验');
    expect(note).not.toContain('区组');
    for (const status of STATUSES) {
      const text = buildDoeConclusion({ ...conclusionBase(aliases), status });
      expect(text, `分支 ${status}`).not.toContain('区组');
      expect(text, `分支 ${status}`).toContain('提高设计分辨率或折叠设计');
    }
    expect(doeInteractionNote({ hasSignificantInteraction: true, aliases })).not.toContain('区组');
  });

  it('列表封顶:每类最多列 6 项,并如实给出总数', () => {
    const aliases = fractionalAliases(7, 4); // 8 运行饱和设计:大量交互项与主效应/常量互为别名
    const interactionCount = aliases.filter((alias) => alias.term.includes('×')).length;
    expect(interactionCount).toBeGreaterThan(CONFOUNDED_NOTE_TERM_CAP * 5);
    const note = confoundedInteractionNote(aliases)!;
    expect(note).toContain(`等共 ${interactionCount} 项`);
    const listed = note.slice(note.indexOf('交互项 ') + 4, note.indexOf(' 等共')).split('、');
    expect(listed).toHaveLength(CONFOUNDED_NOTE_TERM_CAP);
    expect(note.length).toBeLessThan(400);
    // 结论四个分支同源,同样封顶
    for (const status of STATUSES) {
      const text = buildDoeConclusion({ ...conclusionBase(aliases), status });
      expect(text).toContain(`等共 ${interactionCount} 项`);
      expect(text).not.toContain('区组');
    }
  });

  it('非区组的线性相关(缺运行)单独成句,也不提区组', () => {
    const A = [-1, 1, -1, 1, -1, 1, -1];
    const B = [-1, -1, 1, 1, -1, -1, 1];
    const C = [-1, -1, -1, -1, 1, 1, 1];
    const detected = detectFactorial(
      [{ name: 'A', values: A }, { name: 'B', values: B }, { name: 'C', values: C }],
      [10, 14, 11, 16, 12, 17, 13],
    );
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const aliases = analyzeFactorial(detected.design).aliases ?? [];
    expect(aliases.some((alias) => alias.relation === 'linear-dependent' && alias.term.includes('×'))).toBe(true);
    const note = confoundedInteractionNote(aliases)!;
    expect(note).toContain('与已保留模型项线性相关');
    expect(note).toContain('增加运行或减少模型项');
    expect(note).not.toContain('区组');
  });

  it('区组混杂四个结论分支都带区组句(页面与专项报告同源的 buildDoeConclusion)', () => {
    const aliases = blockedAliases();
    for (const status of STATUSES) {
      const text = buildDoeConclusion({ ...conclusionBase(aliases), status });
      expect(text, `分支 ${status}`).toContain('与区组混杂');
      expect(text, `分支 ${status}`).not.toContain('分辨率');
    }
    expect(confoundedInteractionNote([])).toBeNull();
    expect(confoundedInteractionNote(undefined)).toBeNull();
  });
});
