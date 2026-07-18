/**
 * 工厂 MSA 工作簿端到端导入链路（v1.40 C4）：
 * 真实 xlsx（fixtures/gage-factory-workbook-2026-07.xlsx，电机一厂 5 案例并排 + A1:S9 合并说明区）
 * → xlsxBytesToCsv 整表转 CSV → detectCsvBlocks 识别 5 个并排块 → 选块 → parseMatrix
 * → prepareGageStudy → computeGageRR，数值与黄金夹具/Minitab 一致。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectCsvBlocks, parseMatrix } from '../csv';
import { computeVarModel } from '../model';
import { prepareGageStudy } from '../gageData';
import { computeGageRR } from '../gage';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';

const workbook = readFileSync(new URL('./fixtures/gage-factory-workbook-2026-07.xlsx', import.meta.url));
const converted = xlsxBytesToCsv(new Uint8Array(workbook));

describe('工厂 5 案例工作簿端到端导入', () => {
  it('整表转 CSV 后检测到 5 个并排数据块,名称与行数与数据源一致', () => {
    expect('csv' in converted).toBe(true);
    if (!('csv' in converted)) return;
    const blocks = detectCsvBlocks(converted.csv);
    expect(blocks.map((block) => [block.name, block.rows])).toEqual([
      ['螺钉高度', 30], ['平衡量值', 30], ['电阻值', 30], ['窜动值', 90], ['螺钉高度', 90],
    ]);
    for (const block of blocks) {
      expect(block.headers[0]).toBe('部件');
      expect(block.headers[1]).toBe('测试人');
    }
  });

  it('案例1 块:选块→解析→单操作员引擎,数值命中 Minitab(3.35%/ndc42)', () => {
    if (!('csv' in converted)) return;
    const block = detectCsvBlocks(converted.csv)[0];
    const parsed = parseMatrix(block.csv);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    const model = computeVarModel('案例1.csv', parsed.colNames, parsed.rows);
    const textCols = parsed.textCols.map((column) => ({ name: column.name, values: column.values }));
    const study = prepareGageStudy(model, textCols, { valueColumn: '螺钉高度', partColumn: '部件', operatorColumn: '测试人' });
    expect(study.ok).toBe(true);
    if (!study.ok) return;
    expect(study.study.operatorLabels).toEqual(['邹德玉']);
    const result = computeGageRR(study.study.observations, { mode: 'width', value: 1 });
    expect(result.totalGageRR).toBeCloseTo(3.347205459690695, 9);
    expect(result.ndc).toBe(42);
    expect(result.interaction).toBeNull();
  });

  it('案例4 块:三人交叉引擎,数值命中 Minitab(10.51%/17.82%/ndc13)', () => {
    if (!('csv' in converted)) return;
    const block = detectCsvBlocks(converted.csv)[3];
    const parsed = parseMatrix(block.csv);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    const model = computeVarModel('案例4.csv', parsed.colNames, parsed.rows);
    const textCols = parsed.textCols.map((column) => ({ name: column.name, values: column.values }));
    const study = prepareGageStudy(model, textCols, { valueColumn: '窜动值', partColumn: '部件', operatorColumn: '测试人' });
    expect(study.ok).toBe(true);
    if (!study.ok) return;
    expect(study.study.operatorLabels).toHaveLength(3);
    expect(study.study.repeats).toBe(3);
    const result = computeGageRR(study.study.observations, { mode: 'width', value: 1.4 });
    expect(result.totalGageRR).toBeCloseTo(10.51344820502612, 9);
    const grr = result.components.find((component) => component.key === 'grr')!;
    expect(grr.pctTolerance!).toBeCloseTo(17.819373977742917, 9);
    expect(result.ndc).toBe(13);
  });

  it('Tab 分隔工作表中含逗号的单元格:块重组用原分隔符直拼,选块导入往返无损(对抗审查 P1 回归)', () => {
    const sheet = [
      '部件\t备注\t扭矩\t\t部件\t测试人\t高度',
      '1\tOK, 复检\t5.01\t\t1\t张\t10.1',
      '2\tOK, 复检\t5.02\t\t2\t张\t10.2',
      '3\t待定\t5.03\t\t3\t张\t10.3',
    ].join('\n');
    const blocks = detectCsvBlocks(sheet);
    expect(blocks.map((block) => block.name)).toEqual(['扭矩', '高度']);
    const parsed = parseMatrix(blocks[0].csv);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    // 含逗号的「OK, 复检」必须作为完整文本保留,数值列不得被劈碎挤成文本
    expect(parsed.colNames).toEqual(['部件', '扭矩']);
    expect(parsed.textCols.map((column) => column.name)).toEqual(['备注']);
    expect(parsed.textCols[0].values).toEqual(['OK, 复检', 'OK, 复检', '待定']);
    expect(parsed.rows.map((row) => row[1])).toEqual([5.01, 5.02, 5.03]);
  });

  it('RFC-4180 引号 CSV(Excel→SheetJS 形态):含逗号引号单元格整表解析不劈列(Codex 复审 P1)', () => {
    const csv = '部件,备注,扭矩\n1,"OK, 复检",5.01\n2,"OK, 复检",5.02\n3,待定,5.03';
    const parsed = parseMatrix(csv);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.colNames).toEqual(['部件', '扭矩']);
    expect(parsed.textCols[0].values).toEqual(['OK, 复检', 'OK, 复检', '待定']);
    expect(parsed.rows.map((row) => row[1])).toEqual([5.01, 5.02, 5.03]);
  });

  it('RFC-4180 引号 CSV 并排两块:检测/选块/重组引号转义/再解析全链路往返无损', () => {
    const csv = [
      '部件,备注,扭矩,,部件,测试人,高度',
      '1,"OK, 复检",5.01,,1,张,10.1',
      '2,"OK, 复检",5.02,,2,张,10.2',
      '3,待定,5.03,,3,张,10.3',
    ].join('\n');
    const blocks = detectCsvBlocks(csv);
    expect(blocks.map((block) => [block.name, block.rows])).toEqual([['扭矩', 3], ['高度', 3]]);
    const parsed = parseMatrix(blocks[0].csv);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.colNames).toEqual(['部件', '扭矩']);
    expect(parsed.textCols[0].values).toEqual(['OK, 复检', 'OK, 复检', '待定']);
    expect(parsed.rows.map((row) => row[1])).toEqual([5.01, 5.02, 5.03]);
  });

  it('引号多行说明区(含逗号)不干扰块检测:说明保持单格,块识别与工厂工作簿一致', () => {
    const csv = [
      '"说明:第一行,含逗号\n第二行,也含逗号",,,,,,',
      ',,,,,,',
      '部件,测试人,螺钉高度,,部件,测试人,高度',
      '1,甲,3.18,,1,甲,10.1',
      '2,甲,3.29,,2,甲,10.2',
    ].join('\n');
    const blocks = detectCsvBlocks(csv);
    expect(blocks.map((block) => [block.name, block.rows])).toEqual([['螺钉高度', 2], ['高度', 2]]);
  });

  it('无表头纯数字块:行数按数据行如实上报,与 parseMatrix 导入行数一致(对抗审查 P3)', () => {
    const sheet = '5.01,1\n5.02,2\n5.03,3\n5.04,4';
    const blocks = detectCsvBlocks(sheet);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rows).toBe(4);
    expect(blocks[0].name).toContain('第1列起');
    const parsed = parseMatrix(blocks[0].csv);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.rows).toHaveLength(4);
  });

  it('常规单表 CSV 只报 1 个块且表头在首行(导入层按原路径处理,不弹选块)', () => {
    const plain = '直径1,直径2\n25.01,24.99\n24.98,25.03\n25.02,25.00';
    const blocks = detectCsvBlocks(plain);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headerRow).toBe(0);
    expect(blocks[0].rows).toBe(3);
  });
});
