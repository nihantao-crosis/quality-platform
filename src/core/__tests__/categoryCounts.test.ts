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

  it('纯数字类别代码的横向 2×N 也可自动转置', () => {
    const r = ok(parseCategoryCounts('101,102,103,104\n8,5,3,1'));
    expect(r.rows).toEqual([
      { name: '101', count: 8 }, { name: '102', count: 5 },
      { name: '103', count: 3 }, { name: '104', count: 1 },
    ]);
    expect(r.note).toContain('纯数字横向数据');
  });

  it('带类别/频数行标签的纯数字横向代码也可转置', () => {
    const r = ok(parseCategoryCounts('类别,101,102,103\n频数,8,5,3'));
    expect(r.rows).toEqual([
      { name: '101', count: 8 }, { name: '102', count: 5 }, { name: '103', count: 3 },
    ]);
    expect(r.note).toContain('剥离标签并转置');
  });

  it('带行标签的横向类别代码可混用数字与字母', () => {
    const r = ok(parseCategoryCounts('类别,101,A12,102\n频数,8,5,3'));
    expect(r.rows).toEqual([
      { name: '101', count: 8 }, { name: 'A12', count: 5 }, { name: '102', count: 3 },
    ]);
  });

  it('多数字列可显式指定类别列与频数列', () => {
    const r = ok(parseCategoryCounts(
      '缺陷,频数,成本\n划伤,32,120.5\n毛刺,21,80\n划伤,3,20',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(r.rows).toEqual([{ name: '划伤', count: 35 }, { name: '毛刺', count: 21 }]);
    expect(r.note).toContain('第 1 列作为类别');
  });

  it('手动选列识别“缺陷类型 / 发生次数”常见表头', () => {
    const r = ok(parseCategoryCounts(
      '缺陷类型,发生次数,成本\n划伤,32,120.5\n毛刺,21,80',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(r.rows).toEqual([{ name: '划伤', count: 32 }, { name: '毛刺', count: 21 }]);
    expect(r.note).toContain('跳过表头');
  });

  it('显式类别列允许纯数字类别代码', () => {
    const r = ok(parseCategoryCounts('代码,频数,成本\n101,5,9\n102,3,8', { categoryColumn: 0, countColumn: 1 }));
    expect(r.rows).toEqual([{ name: '101', count: 5 }, { name: '102', count: 3 }]);
  });

  it('显式选列保留空字段列位，不会错位或吞掉第一条数据', () => {
    const r = ok(parseCategoryCounts(
      '类别,备注,频数\n划伤,,32\n毛刺,返工,21',
      { categoryColumn: 0, countColumn: 2 },
    ));
    expect(r.rows).toEqual([{ name: '划伤', count: 32 }, { name: '毛刺', count: 21 }]);
  });

  it('CSV 引号字段可包含逗号与转义双引号', () => {
    const r = ok(parseCategoryCounts(
      '类别,频数\n"划伤,表面",32\n"毛刺""返工",21',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(r.rows).toEqual([{ name: '划伤,表面', count: 32 }, { name: '毛刺"返工', count: 21 }]);
  });

  it('CSV 引号字段可包含换行，且未闭合引号给明确错误', () => {
    const r = ok(parseCategoryCounts(
      '类别,频数\n"划伤\n严重",32\n毛刺,21',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(r.rows).toEqual([{ name: '划伤\n严重', count: 32 }, { name: '毛刺', count: 21 }]);
    expect(parseCategoryCounts('类别,频数\n"划伤,32', { categoryColumn: 0, countColumn: 1 })).toHaveProperty('error');
  });

  it('通用表头已剥离时不会因首条类别名也是关键词而重复剥离', () => {
    const r = ok(parseCategoryCounts(
      '类别,频数\n类别,32\n毛刺,21',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(r.rows).toEqual([{ name: '类别', count: 32 }, { name: '毛刺', count: 21 }]);
    expect(r.note?.match(/跳过表头/g)).toHaveLength(1);
  });

  it('显式选列首条频数非法时明确报错，不擅自当表头跳过', () => {
    const bad = parseCategoryCounts('划伤,未知\n毛刺,21', { categoryColumn: 0, countColumn: 1 });
    expect(bad).toHaveProperty('error');
    if ('error' in bad) expect(bad.error).toContain('第 1 行');
  });

  it('显式选列时合法首个类别恰叫“缺陷/类别”也不会被误当表头吞掉', () => {
    const defect = ok(parseCategoryCounts(
      '缺陷,32,100\n毛刺,21,80',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(defect.rows).toEqual([{ name: '缺陷', count: 32 }, { name: '毛刺', count: 21 }]);

    const category = ok(parseCategoryCounts(
      '类别,12\n划伤,8',
      { categoryColumn: 0, countColumn: 1 },
    ));
    expect(category.rows).toEqual([{ name: '类别', count: 12 }, { name: '划伤', count: 8 }]);
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
