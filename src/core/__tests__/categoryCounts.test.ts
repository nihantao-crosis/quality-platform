/** 帕累托类别+频数解析器(独立于 parseMatrix)。 */
import { describe, it, expect } from 'vitest';
import { parseCategoryCounts } from '../csv';

const ok = (r: ReturnType<typeof parseCategoryCounts>) => {
  if ('error' in r) throw new Error('unexpected error: ' + r.error);
  return r;
};

describe('parseCategoryCounts', () => {
  it('纵向 类别,频数 两列', () => {
    const r = ok(parseCategoryCounts('划伤,32\n毛刺,21\n缺料,9'));
    expect(r.rows).toEqual([
      { name: '划伤', count: 32 }, { name: '毛刺', count: 21 }, { name: '缺料', count: 9 },
    ]);
    expect(r.note).toBeUndefined();
  });

  it('横向 2×N(黄广洋实测场景)自动转置并提示', () => {
    const r = ok(parseCategoryCounts('划伤\t毛刺\t缺料\t色差\t其他\n32\t21\t9\t5\t3'));
    expect(r.rows.map((x) => x.name)).toEqual(['划伤', '毛刺', '缺料', '色差', '其他']);
    expect(r.rows[0].count).toBe(32);
    expect(r.note).toContain('转置');
  });

  it('关键词表头剥离;非关键词首行不误吃', () => {
    const withHeader = ok(parseCategoryCounts('类别,频数\n划伤,32\n毛刺,21'));
    expect(withHeader.rows).toHaveLength(2);
    expect(withHeader.note).toContain('表头');
    const noHeader = ok(parseCategoryCounts('划伤,32\n毛刺,21'));
    expect(noHeader.rows).toHaveLength(2); // 「划伤」不是表头关键词,不剥离
  });

  it('单列原始标签 tally 计数', () => {
    const r = ok(parseCategoryCounts('划伤\n毛刺\n划伤\n划伤\n缺料'));
    const m = new Map(r.rows.map((x) => [x.name, x.count]));
    expect(m.get('划伤')).toBe(3);
    expect(m.get('毛刺')).toBe(1);
    expect(r.note).toContain('计数');
  });

  it('单类别允许(放宽旧「至少 2 行」限制)', () => {
    expect(ok(parseCategoryCounts('划伤,32')).rows).toEqual([{ name: '划伤', count: 32 }]);
  });

  it('同名类别合并求和', () => {
    const r = ok(parseCategoryCounts('划伤,3\n划伤,5\n毛刺,2'));
    expect(r.rows.find((x) => x.name === '划伤')!.count).toBe(8);
  });

  it('负频数/纯数值单列/坏行给出可操作错误', () => {
    expect(parseCategoryCounts('划伤,-3')).toHaveProperty('error');
    const numOnly = parseCategoryCounts('1\n2\n3');
    expect(numOnly).toHaveProperty('error');
    if ('error' in numOnly) expect(numOnly.error).toContain('类别');
    const bad = parseCategoryCounts('划伤,32\n毛刺');
    expect(bad).toHaveProperty('error');
    if ('error' in bad) expect(bad.error).toContain('第 2 行');
  });

  it('带序号列(序号,类别,频数):序号不被当频数', () => {
    const r = ok(parseCategoryCounts('1,划伤,32\n2,毛刺,21\n3,缺料,9'));
    const m = new Map(r.rows.map((x) => [x.name, x.count]));
    expect(m.get('划伤')).toBe(32);
    expect(m.get('缺料')).toBe(9);
    expect(r.note).toContain('序号');
  });

  it('空格分隔的「类别 频数」正确解析(不被 tally 成 1)', () => {
    const r = ok(parseCategoryCounts('划伤 32\n毛刺 21\n缺料 9'));
    expect(r.rows).toEqual([{ name: '划伤', count: 32 }, { name: '毛刺', count: 21 }, { name: '缺料', count: 9 }]);
    expect(r.note).toContain('空格');
  });

  it('带行首标签的横向表(类别,划伤,… / 频数,32,…)剥标签+转置', () => {
    const r = ok(parseCategoryCounts('类别,划伤,毛刺,缺料\n频数,32,21,9'));
    expect(r.rows.map((x) => x.name)).toEqual(['划伤', '毛刺', '缺料']);
    expect(r.rows[0].count).toBe(32);
    expect(r.note).toContain('剥离');
  });

  it('全零频数被拒绝', () => {
    expect(parseCategoryCounts('划伤,0\n毛刺,0')).toHaveProperty('error');
  });

  it('一行含多个数值列(无序号规律)报歧义错误', () => {
    const bad = parseCategoryCounts('划伤,32,50\n毛刺,21,40\n缺料,9,80');
    expect(bad).toHaveProperty('error');
    if ('error' in bad) expect(bad.error).toContain('多个数值列');
  });
});
