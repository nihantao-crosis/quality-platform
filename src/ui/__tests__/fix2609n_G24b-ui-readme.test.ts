/**
 * fix2609n · G24b-ui README 事实核对:
 * B1   「手工数值输入」:AQL 批量 N 与 μ₀/过程公差/规格限共用同一严格数值框(编辑前值回退);
 *      「实际不合格品数」是本地草稿,只在点「记录本批」时提交。
 * B3a  规格限回退时一并恢复 1000σ 强警告确认。
 * B3c  reportNum 条目以 v1.42 为参照,不再提候选分支内部的「此前阈值是 2 位」。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync('README.md', 'utf8');

function bullet(title: string): string {
  const line = readme.split('\n').find((l) => l.startsWith(`- **${title}`));
  expect(line, `缺少「${title}」条目`).toBeDefined();
  return line!;
}

describe('README 与修复后的真实行为一致', () => {
  it('B1 手工数值输入:AQL 批量 N 列入同一严格数值框(回退语义),不合格品数写明按钮提交', () => {
    const line = bullet('手工数值输入');
    expect(line).toMatch(/μ₀、MSA 过程公差、能力规格限与 AQL 批量 N 共用同一严格数值框/);
    expect(line).toMatch(/实际不合格品数.*记录本批/);
    expect(line).toContain('1000σ');
  });

  it('B3c reportNum 条目以 v1.42 为参照', () => {
    const line = bullet('报告数值文本');
    expect(line).not.toContain('阈值是 2 位');
    expect(line).toContain('v1.42');
    expect(line).toContain('0.00000047');
    expect(line).toContain('3 位有效数字');
  });
});
