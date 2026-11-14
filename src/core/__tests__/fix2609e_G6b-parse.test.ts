/**
 * 2026-09 全面审查第 2 批复审收口 G6b-parse:解析回归。
 * 语料取自复审者的复现(PLATFORM-09 .NET SDK 形制、CORE-05 S1/S3/S4/S6/T1/T2/T3、CORE-04 宽前导空列),
 * 全部调用真实生产函数;修复前失败、修复后通过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { detectCsvBlocks, extractPChartColumns, parseCategoryCounts, parseMatrix, type ParsedMatrix } from '../csv';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';

function ok(result: ParsedMatrix | { error: string }): ParsedMatrix {
  if ('error' in result) throw new Error(`unexpected parse error: ${result.error}`);
  return result;
}

// ---------------------------------------------------------------- PLATFORM-09

const BOM = '﻿';
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKBOOK_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const WORKSHEET_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

interface DotNetOptions {
  /** 额外追加到 [Content_Types].xml 的 Override(默认无 workbook Override) */
  extraOverrides?: string[];
  /** 工作簿 ZIP 条目名(默认 xl/workbook.xml) */
  workbookEntry?: string | null;
  /** 首表 relationship Type(默认 worksheet) */
  firstSheetType?: string;
}

/**
 * .NET Open XML SDK / MES 导出形制(与本机 bom.xlsx 同构):无 docProps、无 /xl/workbook.xml Override,
 * `Default Extension="xml"` 给 main+xml;relationship Id=R<hex>、Target 全为 /xl/… 绝对部件名;
 * 部件用 x: 前缀;[Content_Types].xml 与 rels 带 UTF-8 BOM。
 */
async function dotNetStyleWorkbook(options: DotNetOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const overrides = [
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" />`,
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" />`,
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${WORKSHEET_CT}" />`,
    ...(options.extraOverrides ?? []),
  ];
  zip.file('[Content_Types].xml', `${BOM}${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="${WORKBOOK_CT}" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />${overrides.join('')}</Types>`);
  zip.file('_rels/.rels', `${BOM}${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml" Id="R14b4abd19f084db0" /></Relationships>`);
  const workbookEntry = options.workbookEntry === undefined ? 'xl/workbook.xml' : options.workbookEntry;
  if (workbookEntry) {
    zip.file(workbookEntry, `${XML_DECL}<x:workbook xmlns:x="${MAIN_NS}"><x:sheets><x:sheet name="采购分组" sheetId="1" r:id="R10b9c0e28d1449e3" xmlns:r="${REL_NS}" /></x:sheets></x:workbook>`);
  }
  const firstType = options.firstSheetType ?? `${REL_NS}/worksheet`;
  zip.file('xl/_rels/workbook.xml.rels', `${BOM}${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${REL_NS}/styles" Target="/xl/styles.xml" Id="Rd991cbdbf7f842c5" /><Relationship Type="${REL_NS}/sharedStrings" Target="/xl/sharedStrings.xml" Id="Rfd2f8514ce444d00" /><Relationship Type="${firstType}" Target="/xl/worksheets/sheet1.xml" Id="R10b9c0e28d1449e3" /></Relationships>`);
  zip.file('xl/styles.xml', `${XML_DECL}<x:styleSheet xmlns:x="${MAIN_NS}"><x:fonts count="1"><x:font /></x:fonts><x:fills count="1"><x:fill /></x:fills><x:borders count="1"><x:border /></x:borders><x:cellXfs count="1"><x:xf /></x:cellXfs></x:styleSheet>`);
  zip.file('xl/sharedStrings.xml', `${XML_DECL}<x:sst xmlns:x="${MAIN_NS}" />`);
  zip.file('xl/worksheets/sheet1.xml', `${XML_DECL}<x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>位号</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>数量</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>R1</x:t></x:is></x:c><x:c r="B2"><x:v>4</x:v></x:c></x:row><x:row r="3"><x:c r="A3" t="inlineStr"><x:is><x:t>C7</x:t></x:is></x:c><x:c r="B3"><x:v>2.5</x:v></x:c></x:row></x:sheetData></x:worksheet>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('PLATFORM-09 复审:.NET Open XML SDK 形制(无 workbook Override)按 SheetJS 同口径放行', () => {
  it('正向夹具:SheetJS 回退读 xl/workbook.xml,守卫不再整批拒绝(修复前报「必须唯一指定标准 /xl/workbook.xml」)', async () => {
    const bytes = await dotNetStyleWorkbook();
    // 对照:SheetJS 本身可直读
    const direct = XLSX.read(bytes, { type: 'array', sheets: 0 });
    expect(XLSX.utils.sheet_to_csv(direct.Sheets[direct.SheetNames[0]], { rawNumbers: true })).toBe('位号,数量\nR1,4\nC7,2.5');
    expect(await xlsxBytesToCsv(bytes)).toEqual({ csv: '位号,数量\nR1,4\nC7,2.5', sheetName: '采购分组' });
  });

  it('负向夹具:缺 xl/workbook.xml、只有 xl/workbook.bin、两个 workbook Override、workbook 路径被声明为非工作簿类型、唯一 Override 指向别处 → 仍拒绝', async () => {
    const cases: Array<[string, DotNetOptions, RegExp]> = [
      ['无 Override 且缺 xl/workbook.xml', { workbookEntry: 'xl/book.xml' }, /缺少必需内部部件「xl\/workbook\.xml」/],
      ['只有 xl/workbook.bin', { workbookEntry: 'xl/workbook.bin' }, /缺少必需内部部件「xl\/workbook\.xml」/],
      ['两个 workbook Override', {
        extraOverrides: [
          `<Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_CT}" />`,
          `<Override PartName="/xl/workbook2.xml" ContentType="${WORKBOOK_CT}" />`,
        ],
      }, /必须唯一指定标准 \/xl\/workbook\.xml 工作簿部件/],
      ['xl/workbook.xml 被 Override 成非工作簿类型', {
        extraOverrides: ['<Override PartName="/xl/workbook.xml" ContentType="application/xml" />'],
      }, /必须唯一指定标准 \/xl\/workbook\.xml 工作簿部件/],
      ['唯一 workbook Override 指向别的部件', {
        extraOverrides: [`<Override PartName="/xl/other.xml" ContentType="${WORKBOOK_CT}" />`],
      }, /必须唯一指定标准 \/xl\/workbook\.xml 工作簿部件/],
    ];
    for (const [name, options, expected] of cases) {
      const result = await xlsxBytesToCsv(await dotNetStyleWorkbook(options));
      expect(result, name).toEqual({ error: expect.stringMatching(expected) });
    }
  });

  it('「SheetJS 可读、只是守卫更严」的结构性拒绝统一附「可用 Excel/WPS 打开后另存再导入」指引', async () => {
    const twoWorkbooks = await xlsxBytesToCsv(await dotNetStyleWorkbook({
      extraOverrides: [
        `<Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_CT}" />`,
        `<Override PartName="/xl/workbook2.xml" ContentType="${WORKBOOK_CT}" />`,
      ],
    }));
    expect(twoWorkbooks).toEqual({ error: expect.stringContaining('可用 Excel/WPS 打开后另存再导入') });
    const oddType = await xlsxBytesToCsv(await dotNetStyleWorkbook({ firstSheetType: `${REL_NS}/dialogsheet` }));
    expect(oddType).toEqual({ error: expect.stringContaining('可用 Excel/WPS 打开后另存再导入') });
  });

  it('首张是图表页(chartsheet)时给出可操作的说明,而不是「Type 不是 worksheet」', async () => {
    const result = await xlsxBytesToCsv(await dotNetStyleWorkbook({ firstSheetType: `${REL_NS}/chartsheet` }));
    expect(result).toEqual({ error: expect.stringMatching(/首张工作表是图表页.*移到第一张/) });
  });

  // 本机实测证据文件(复审者点名的 bom/bom.xlsx);不在本机时跳过,不影响 CI。
  const realBom = join(homedir(), 'Desktop/电机控制板设计/第五版_Codex_GPT6_重设计_2026-09-11/bom/bom.xlsx');
  it.skipIf(!existsSync(realBom))('本机真实 .NET 导出 bom.xlsx 可导入,且与 SheetJS 直读逐字一致', async () => {
    const bytes = new Uint8Array(readFileSync(realBom));
    const direct = XLSX.read(bytes, { type: 'array', sheets: 0, cellDates: true });
    const expected = XLSX.utils.sheet_to_csv(direct.Sheets[direct.SheetNames[0]], { rawNumbers: true });
    expect(await xlsxBytesToCsv(bytes)).toEqual({ csv: expected, sheetName: direct.SheetNames[0] });
  });
});

// ---------------------------------------------------------------- CORE-05

describe('CORE-05 复审:分隔符嗅探与首条记录切分同口径(三种候选都算字段边界)', () => {
  it('S1 分号 CSV 表头带引号逗号 `"Teil";"Maß, mm"` 判为分号', () => {
    const parsed = ok(parseMatrix('"Teil";"Maß, mm"\n1;10\n2;11\n3;12\n'));
    expect(parsed.colNames).toEqual(['Teil', 'Maß, mm']);
    expect(parsed.rows).toEqual([[1, 10], [2, 11], [3, 12]]);
  });

  it('S3 `批次;"直径,mm";"长度,mm"` 判为分号', () => {
    const parsed = ok(parseMatrix('批次;"直径,mm";"长度,mm"\nA;10.1;20.1\nB;10.2;20.2\nC;10.3;20.3\n'));
    expect(parsed.colNames).toEqual(['直径,mm', '长度,mm']);
    expect(parsed.rows).toEqual([[10.1, 20.1], [10.2, 20.2], [10.3, 20.3]]);
    expect(parsed.textCols).toEqual([{ name: '批次', values: ['A', 'B', 'C'], sourceIndex: 0 }]);
  });

  it('S4 全加引号的 TSV `"编号"\\t"长,宽,高"` 判为 Tab', () => {
    const parsed = ok(parseMatrix('"编号"\t"长,宽,高"\n1\t10\n2\t11\n3\t12\n'));
    expect(parsed.colNames).toEqual(['编号', '长,宽,高']);
    expect(parsed.rows).toEqual([[1, 10], [2, 11], [3, 12]]);
  });

  it('S6 逗号 CSV 表头 `编号,"a;b;c"` 判为逗号', () => {
    const parsed = ok(parseMatrix('编号,"a;b;c"\n1,10\n2,11\n3,12\n'));
    expect(parsed.colNames).toEqual(['编号', 'a;b;c']);
    expect(parsed.rows).toEqual([[1, 10], [2, 11], [3, 12]]);
  });

  it('T1 分号 + 小数逗号不再静默生成错误数值列 mm"=[5,6,7]', () => {
    const text = '"Nr";"Wert, mm"\n1;10,5\n2;10,6\n3;10,7';
    const parsed = ok(parseMatrix(text));
    expect(parsed.colNames).toEqual(['Nr']);
    expect(parsed.rows).toEqual([[1], [2], [3]]);
    expect(parsed.textCols).toEqual([{ name: 'Wert, mm', values: ['10,5', '10,6', '10,7'], sourceIndex: 1 }]);
    // detectCsvBlocks 重组的 block.csv 再走 parseMatrix 时重新嗅探,结果一致
    const blocks = detectCsvBlocks(text);
    expect(blocks.map((block) => block.headers)).toEqual([['Nr', 'Wert, mm']]);
    expect(ok(parseMatrix(blocks[0].csv))).toEqual(parsed);
  });

  it('T2 Excel 剪贴板 TSV 表头带 Alt+Enter 换行与逗号', () => {
    const parsed = ok(parseMatrix('编号\t"长,宽,高\n(mm)"\n1\t10\n2\t11'));
    expect(parsed.colNames).toEqual(['编号', '长,宽,高\n(mm)']);
    expect(parsed.rows).toEqual([[1, 10], [2, 11]]);
  });

  it('T3 Excel 剪贴板 TSV 表头带转义英寸号 `"管径 1/2"", 3/4"", 1"""`', () => {
    const parsed = ok(parseMatrix('编号\t"管径 1/2"", 3/4"", 1"""\n1\t10\n2\t11\n3\t12'));
    expect(parsed.colNames).toEqual(['编号', '管径 1/2", 3/4", 1"']);
    expect(parsed.rows).toEqual([[1, 10], [2, 11], [3, 12]]);
  });

  it('原缺陷用例保持修好:字段中部裸英寸号为字面量(CSV/TSV/表头)', () => {
    const csv = ok(parseMatrix('部件,直径\n1/2" 螺栓,10.1\n3/4" 螺栓,10.2\nM8,10.3\nM10,10.4\n'));
    expect(csv.rows).toEqual([[10.1], [10.2], [10.3], [10.4]]);
    expect(csv.textCols[0].values).toEqual(['1/2" 螺栓', '3/4" 螺栓', 'M8', 'M10']);
    const single = ok(parseMatrix('规格,直径\n12",10.1\nM8,10.3\nM10,10.4\n'));
    expect(single.textCols[0].values[0]).toBe('12"');
    const header = ok(parseMatrix('编号\t管径 1/2", 3/4"\n1\t10\n2\t11\n3\t12'));
    expect(header.colNames).toEqual(['编号', '管径 1/2", 3/4"']);
    expect(parseMatrix('a,b\n"x,1\ny,2\nz,3\n')).toEqual({ error: 'CSV 引号未闭合，请检查含分隔符或换行的引号字段。' });
  });

  it('帕累托:未闭合判定与记录数按最终分隔符重算,与工作表导入同口径(复审 P3)', () => {
    // Tab 分隔,类别里出现 `,"`:按 ANY 口径会开启引号并吞到文末(误报未闭合),按 Tab 口径是字面量
    const text = '缺陷\t频数\n1/2,"毛刺\t5\n划伤\t3\n';
    expect(parseCategoryCounts(text)).toEqual({
      rows: [{ name: '1/2,"毛刺', count: 5 }, { name: '划伤', count: 3 }],
      note: '已识别并跳过表头行',
    });
    const matrix = ok(parseMatrix(text));
    expect(matrix.textCols[0].values).toEqual(['1/2,"毛刺', '划伤']);
    // 真正未闭合仍拒绝
    expect(parseCategoryCounts('缺陷,频数\n"毛刺,5\n划伤,3\n')).toEqual({ error: 'CSV 引号未闭合，请检查含逗号或换行的类别字段。' });
  });
});

// ---------------------------------------------------------------- CORE-04

describe('CORE-04 复审:帕累托前导空列单遍剥离;P 图整列空白不计列数', () => {
  it('2 行 × 49,999 个前导 Tab 在 1 s 内完成(修复前 O(行数×k²),约 3.9 s)', () => {
    const lead = '\t'.repeat(49_999);
    const text = `${lead}划伤\t5\n${lead}毛刺\t3\n`;
    const started = performance.now();
    const result = parseCategoryCounts(text);
    const elapsed = performance.now() - started;
    expect(result).toEqual({ rows: [{ name: '划伤', count: 5 }, { name: '毛刺', count: 3 }] });
    expect(elapsed).toBeLessThan(1000);
  });

  it('单遍剥离与逐列剥离同口径:只剥所有行共有的前导空列,每行至少保留 1 格', () => {
    expect(parseCategoryCounts('\t\t划伤\t5\n\t毛刺\t3\n\t\t\t擦伤\t2\n')).toEqual({ error: expect.any(String) });
    expect(parseCategoryCounts('\t划伤\t5\n\t毛刺\t3\n')).toEqual({ rows: [{ name: '划伤', count: 5 }, { name: '毛刺', count: 3 }] });
  });

  it('P 图 Tab 粘贴含空白 A 列:不再报「检测到 3 列」;逗号形态同口径', () => {
    for (const text of ['\t不良数\t样本量\n\t3\t50\n\t2\t50\n\t4\t40\n', ',不良数,样本量\n,3,50\n,2,50\n,4,40\n']) {
      const parsed = ok(parseMatrix(text));
      expect(parsed.sourceColumnCount, JSON.stringify(text)).toBe(2);
      expect(extractPChartColumns(parsed, 50)).toEqual({ counts: [3, 2, 4], sampleSizes: [50, 50, 40], variableSampleSizes: true });
    }
    // 有内容的额外列仍拒绝
    const extra = ok(parseMatrix('不良数\t样本量\t备注\n3\t50\t\n2\t50\tx\n4\t40\t\n'));
    expect(extractPChartColumns(extra, 50)).toEqual({ error: expect.stringMatching(/检测到 3 列/) });
  });
});
