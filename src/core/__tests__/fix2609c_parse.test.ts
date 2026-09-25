/**
 * 2026-09 全面审查第 2 批 G6-parse:导入/输入解析回归。
 * 每条用例都基于发现记录的 reproMethod,调用真实生产函数;修复前失败、修复后通过。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { detectCsvBlocks, parseCategoryCounts, parseMatrix, type ParsedMatrix } from '../csv';
import { computeVarModel } from '../model';
import { prepareSpcData, textSpcRole, numericSpcRole } from '../spcData';
import { assessSpcCharts } from '../capabilityAssessment';
import { DEFAULT_RULE_K, DEFAULT_RULES } from '../spc';
import { normalizeNumberText, parseStrictInteger, parseStrictNumber } from '../numberInput';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';

function ok(result: ParsedMatrix | { error: string }): ParsedMatrix {
  if ('error' in result) throw new Error(`unexpected parse error: ${result.error}`);
  return result;
}

describe('CORE-04 Tab 分隔行首空单元格不得被整行 trim 吞掉', () => {
  it('表头左上角空白:列名与数据保持对齐(与逗号分隔同口径)', () => {
    const tab = ok(parseMatrix('\tX\tY\r\n1\t2.5\t3.1\r\n2\t2.6\t3.2\r\n3\t2.7\t3.3\r\n'));
    const comma = ok(parseMatrix(',X,Y\r\n1,2.5,3.1\r\n2,2.6,3.2\r\n3,2.7,3.3\r\n'));
    // 修复前:colNames ["X","Y","C3"],「X」列里装的是行号
    expect(tab.colNames).toEqual(['C1', 'X', 'Y']);
    expect(tab.rows).toEqual([[1, 2.5, 3.1], [2, 2.6, 3.2], [3, 2.7, 3.3]]);
    expect(tab).toEqual(comma);
  });

  it('工厂版式:A1 空白、A 列为序号/零件名,B1 起才是特性名', () => {
    const indexed = ok(parseMatrix('\t直径\t宽度\n1\t10.02\t5.01\n2\t10.05\t5.03\n3\t9.98\t4.99\n4\t10.01\t5.00\n'));
    expect(indexed.colNames).toEqual(['C1', '直径', '宽度']);
    expect(indexed.rows.map((row) => row[1])).toEqual([10.02, 10.05, 9.98, 10.01]);

    const named = ok(parseMatrix('\t直径\t宽度\n零件1\t10.1\t20.2\n零件2\t10.2\t20.1\n零件3\t10.3\t20.3\n'));
    // 修复前:colNames ["宽度","C2"],标着「宽度」的列里是直径
    expect(named.colNames).toEqual(['直径', '宽度']);
    expect(named.rows).toEqual([[10.1, 20.2], [10.2, 20.1], [10.3, 20.3]]);
    expect(named.textCols).toEqual([{ name: 'T1', values: ['零件1', '零件2', '零件3'], sourceIndex: 0 }]);
  });

  it('数据行首单元格为空:后一列的数值不得左移进前一列,Remark 列不丢', () => {
    const parsed = ok(parseMatrix('A\tB\tRemark\n1\t2\tok\n\t7\tok\n3\t4\tok\n5\t6\tok\n'));
    // 修复前:colNames ["A"]、rows [[1],[7],[3],[5]](7 来自 B 列),Remark 整列消失
    expect(parsed.colNames).toContain('B');
    const b = parsed.colNames.indexOf('B');
    expect(parsed.rows.map((row) => row[b])).toEqual([2, 7, 4, 6]);
    expect(parsed.textCols.find((col) => col.name === 'Remark')?.values).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(parsed.skippedRows).toBe(0);
  });

  it('纯空白(空格/Tab)行仍被跳过,不会凭空多出全空行', () => {
    const parsed = ok(parseMatrix('X\tY\n \t \t\n1\t2\n\t\n3\t4\n   \n5\t6\n'));
    expect(parsed.rows).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(parsed.skippedRows).toBe(0);
  });

  it('并排数据块检测也按真实列位拆分(行首空单元格不再把右侧块挤丢)', () => {
    const blocks = detectCsvBlocks('A\tB\t\tC\n1\t2\t\t9\n\t3\t\t8\n4\t5\t\t7\n');
    const right = blocks.find((block) => block.headers[0] === 'C');
    // 修复前:第 3 行被 trim 成 "3\t\t8",C 块只剩 9、7 两行
    expect(right?.colStart).toBe(3);
    expect(right?.rows).toBe(3);
    expect(right?.csv).toBe('C\n9\n8\n7');
  });

  it('帕累托:Excel 选区左侧整列空白仍可自动识别;横向带行标签形态对齐', () => {
    expect(parseCategoryCounts('\t划伤\t5\n\t毛刺\t3\n')).toEqual({ rows: [{ name: '划伤', count: 5 }, { name: '毛刺', count: 3 }] });
    const horizontal = parseCategoryCounts('\t划伤\t毛刺\n频数\t5\t3\n');
    expect('error' in horizontal).toBe(false);
    if (!('error' in horizontal)) expect(horizontal.rows).toEqual([{ name: '划伤', count: 5 }, { name: '毛刺', count: 3 }]);
  });
});

describe('CORE-05 字段中部的英寸号 " 是字面量,只有字段起始的 " 才开启引号', () => {
  it('两个裸英寸号之间的测量行不再被合并吞掉(CSV/TSV)', () => {
    const csv = ok(parseMatrix('部件,直径\n1/2" 螺栓,10.1\n3/4" 螺栓,10.2\nM8,10.3\nM10,10.4\n'));
    // 修复前:rows [[10.2],[10.3],[10.4]],10.1 消失,skippedRows 0
    expect(csv.rows).toEqual([[10.1], [10.2], [10.3], [10.4]]);
    expect(csv.textCols[0].values).toEqual(['1/2" 螺栓', '3/4" 螺栓', 'M8', 'M10']);
    expect(csv.totalLines).toBe(4);
    expect(csv.skippedRows).toBe(0);

    const tsv = ok(parseMatrix('部件\t直径\n1/2" 螺栓\t10.1\n3/4" 螺栓\t10.2\nM8\t10.3\nM10\t10.4\n'));
    expect(tsv.rows).toEqual(csv.rows);
    expect(tsv.textCols).toEqual(csv.textCols);
  });

  it('20 行长样本(第 1 与第 15 行带英寸号)全部保留', () => {
    const lines = ['部件,直径'];
    for (let i = 1; i <= 20; i++) {
      const part = i === 1 ? '1/2" 螺栓' : i === 15 ? '3/4" 螺栓' : `M${i}`;
      lines.push(`${part},${(10 + i / 100).toFixed(2)}`);
    }
    const parsed = ok(parseMatrix(lines.join('\n')));
    expect(parsed.rows).toHaveLength(20);
    expect(parsed.skippedRows).toBe(0);
    expect(parsed.rows.map((row) => row[0])[0]).toBe(10.01);
  });

  it('全文只有一个裸英寸号的合法文件不再被判「引号未闭合」整份拒收', () => {
    const parsed = ok(parseMatrix('规格,直径\n12",10.1\nM8,10.3\nM10,10.4\n'));
    expect(parsed.rows).toEqual([[10.1], [10.3], [10.4]]);
    expect(parsed.textCols[0].values[0]).toBe('12"');
  });

  it('真正未闭合的引号字段仍然响亮失败;RFC 4180 引号字段语义不变', () => {
    expect(parseMatrix('a,b\n"x,1\ny,2\nz,3\n')).toEqual({ error: 'CSV 引号未闭合，请检查含分隔符或换行的引号字段。' });
    const quoted = ok(parseMatrix('a,b\n"x, y",1\n"he said ""hi""",2\n "q",3\n"多\n行",4\n'));
    expect(quoted.textCols[0].values).toEqual(['x, y', 'he said "hi"', 'q', '多\n行']);
    expect(quoted.rows).toEqual([[1], [2], [3], [4]]);
  });

  it('数据块检测与帕累托走同一引号口径', () => {
    const blocks = detectCsvBlocks('部件,直径\n1/2" 螺栓,10.1\n3/4" 螺栓,10.2\nM8,10.3\nM10,10.4\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rows).toBe(4);
    expect(ok(parseMatrix(blocks[0].csv)).rows).toEqual([[10.1], [10.2], [10.3], [10.4]]);

    const pareto = parseCategoryCounts('缺陷,频数\n1/2" 毛刺,10\n3/4" 毛刺,7\n划伤,5\n');
    // 修复前:[{name:'1/2 毛刺,10\n3/4 毛刺',count:7},…],频数 10 丢失
    expect(pareto).toEqual({
      rows: [{ name: '1/2" 毛刺', count: 10 }, { name: '3/4" 毛刺', count: 7 }, { name: '划伤', count: 5 }],
      note: '已识别并跳过表头行',
    });
  });
});

/** 两天数据:每天子组号 1..4,每组 5 个测量,第二天整体 +3(发现记录场景 A)。 */
function twoDayStacked() {
  const base = [
    [10.1, 10.3, 9.9, 10.2, 10.0],
    [10.2, 10.0, 10.1, 9.9, 10.3],
    [9.8, 10.1, 10.2, 10.0, 10.1],
    [10.0, 10.2, 9.9, 10.1, 10.2],
  ];
  const rows: number[][] = [];
  const dates: string[] = [];
  for (const [day, shift] of [['7/1', 0], ['7/2', 3]] as const) {
    base.forEach((values, index) => values.forEach((value) => {
      rows.push([index + 1, Number((value + shift).toFixed(2))]);
      dates.push(day);
    }));
  }
  return { model: computeVarModel('两天长表', ['子组', '测量值'], rows), text: [{ name: '日期', values: dates }], base };
}

describe('CORE-01 堆叠格式按 Minitab 口径「ID 值一变就开新子组」', () => {
  it('跨天重新编号的子组 ID 不再被合并;阶跃被判失控', () => {
    const { model, text, base } = twoDayStacked();
    const prepared = prepareSpcData(model, text, { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('stacked');
    // 修复前:k=4、n=10,子组 1 同时含 10.1… 与 13.1…
    expect(prepared.model?.k).toBe(8);
    expect(prepared.model?.n).toBe(5);
    expect(prepared.model?.subs[0].vals).toEqual(base[0]);
    expect(prepared.subgroupLabels).toEqual(['1', '2', '3', '4', '1', '2', '3', '4']);
    // 组内恒定的日期列可作为分阶段候选(合并口径下会被静默剔除)
    expect(prepared.textCols).toContainEqual({ name: '日期', values: ['7/1', '7/1', '7/1', '7/1', '7/2', '7/2', '7/2', '7/2'] });
    const assessment = assessSpcCharts(prepared.model!, DEFAULT_RULES, DEFAULT_RULE_K, 'xbar-r');
    expect(assessment.stable).toBe(false);
    // 口径变更必须在角色说明里写明(SPC 页、能力页、专项报告共用 prepared.note)
    expect(prepared.note).toContain('值一变即开新子组');
    expect(prepared.note).toContain('v1.42 及更早版本');
  });

  it('能力页「单列+子组 ID」(显式 stacked)与 SPC 同口径', () => {
    const { model, text } = twoDayStacked();
    const prepared = prepareSpcData(model, text, { layout: 'stacked', valueColumn: '测量值', subgroupColumn: numericSpcRole('子组') });
    expect(prepared.model?.k).toBe(8);
    expect(prepared.model?.n).toBe(5);
    expect(prepared.model!.sigmaWithin).toBeLessThan(0.3);
    expect(prepared.note).toContain('口径说明');
  });

  it('轮换出现的文本 ID(操作员 A/B/C)不再被当作堆叠子组', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [Number((10 + i * 0.05).toFixed(2))]);
    const model = computeVarModel('轮换', ['尺寸'], rows);
    const operators = [{ name: '操作员', values: rows.map((_, i) => ['A', 'B', 'C'][i % 3]) }];
    const auto = prepareSpcData(model, operators, { layout: 'auto', valueColumn: null, subgroupColumn: null });
    // 修复前:layout stacked,k=3、n=10,每个「子组」横跨整条时间轴
    expect(auto.layout).toBe('individuals');
    expect(auto.model?.k).toBe(30);
    expect(auto.note).toContain('口径说明');

    const explicit = prepareSpcData(model, operators, { layout: 'stacked', valueColumn: '尺寸', subgroupColumn: textSpcRole('操作员') });
    expect(explicit.layout).toBeNull();
    expect(explicit.error).toContain('Minitab 口径');
  });

  it('相邻块状 ID 结果不变,也不出现口径说明', () => {
    const model = computeVarModel('堆叠文本', ['直径'], [[10], [11], [20], [21]]);
    const prepared = prepareSpcData(model, [{ name: '批次', values: ['A', 'A', 'B', 'B'] }], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.model?.subs.map((s) => s.vals)).toEqual([[10, 11], [20, 21]]);
    expect(prepared.note).not.toContain('口径说明');
  });
});

describe('GAP-8-4 严格数值解析原语', () => {
  it('合法写法与全角归一化', () => {
    expect(parseStrictNumber('  3.2  ')).toEqual({ ok: true, value: 3.2 });
    expect(parseStrictNumber('１２３')).toEqual({ ok: true, value: 123 });
    expect(parseStrictNumber('−5')).toEqual({ ok: true, value: -5 });
    expect(parseStrictNumber('－０．５')).toEqual({ ok: true, value: -0.5 });
    expect(parseStrictNumber('1e3')).toEqual({ ok: true, value: 1000 });
    expect(normalizeNumberText('　１２．５　')).toBe('12.5');
  });

  it('parseFloat 会静默截断的形态一律拒绝并给出原因', () => {
    const cases: Array<[string, RegExp]> = [
      ['1,000', /逗号.*千分位还是小数点/],
      ['2,000', /逗号/],
      ['3,5', /逗号/],
      ['1 000', /空格/],
      ['12.5mm', /单位或多余字符「mm」/],
      ['5%', /单位或多余字符「%」/],
      ['0x10', /十六进制/],
      ['1e999', /超出可表示的数值范围/],
      ['abc', /不是有效数值/],
    ];
    for (const [text, reason] of cases) {
      const parsed = parseStrictNumber(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) {
        expect(parsed.empty, text).toBe(false);
        expect(parsed.reason, text).toMatch(reason);
      }
      // 反证:旧口径 parseFloat 对前 8 个都返回有限数(被静默换成另一个数)
    }
    expect(Number.parseFloat('1,000')).toBe(1);
  });

  it('千分位只在无歧义时接受,并返回说明', () => {
    expect(parseStrictNumber('1,234,567')).toEqual({ ok: true, value: 1234567, note: '「1,234,567」已按千分位读作 1234567' });
    expect(parseStrictNumber('1,000.5')).toMatchObject({ ok: true, value: 1000.5 });
    expect(parseStrictNumber('12,34,567').ok).toBe(false);
  });

  it('空串单独标记;整数解析拒绝小数与越界', () => {
    expect(parseStrictNumber('   ')).toEqual({ ok: false, empty: true, reason: '未填写数值' });
    expect(parseStrictInteger('2.5').ok).toBe(false);
    expect(parseStrictInteger('0', { min: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('超出允许范围') });
    expect(parseStrictInteger('８', { min: 1 })).toEqual({ ok: true, value: 8 });
  });
});

/** 按本机真实 openpyxl 3.1.5 文件的包结构手工组装(inlineStr、绝对 Target、Override PartName)。 */
async function openpyxlStyleWorkbook(worksheetTarget: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="xml" ContentType="application/xml" /><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" /><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml" /><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" /><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml" Id="rId1" /><Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml" Id="rId2" /><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml" Id="rId3" /></Relationships>');
  zip.file('docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel Compatible / Openpyxl 3.1.5</Application><AppVersion>3.1</AppVersion></Properties>');
  zip.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>openpyxl</dc:creator></cp:coreProperties>');
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><workbookPr /><workbookProtection /><bookViews><workbookView visibility="visible" minimized="0" showHorizontalScroll="1" showVerticalScroll="1" showSheetTabs="1" tabRatio="600" firstSheet="0" activeTab="0" autoFilterDateGrouping="1" /></bookViews><sheets><sheet name="测量数据" sheetId="1" state="visible" r:id="rId1" /></sheets><definedNames /><calcPr calcId="124519" fullCalcOnLoad="1" /></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${worksheetTarget}" Id="rId1" /><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml" Id="rId2" /></Relationships>`);
  zip.file('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0" /><fonts count="1"><font><name val="Calibri" /><family val="2" /><sz val="11" /></font></fonts><fills count="2"><fill><patternFill /></fill><fill><patternFill patternType="gray125" /></fill></fills><borders count="1"><border><left /><right /><top /><bottom /><diagonal /></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" /></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0" /></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0" hidden="0" /></cellStyles><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16" /></styleSheet>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><outlinePr summaryBelow="1" summaryRight="1" /><pageSetUpPr /></sheetPr><dimension ref="A1:B3" /><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1" /></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15" /><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>测量值</t></is></c><c r="B1" t="inlineStr"><is><t>批次</t></is></c></row><row r="2"><c r="A2" t="n"><v>1.5</v></c><c r="B2" t="inlineStr"><is><t>A</t></is></c></row><row r="3"><c r="A3" t="n"><v>2.5</v></c><c r="B3" t="inlineStr"><is><t>B</t></is></c></row></sheetData><pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5" /></worksheet>');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('PLATFORM-09 openpyxl/pandas 的 /xl/… 绝对部件名', () => {
  it('openpyxl 形制工作簿可导入(修复前报「不是安全的包内相对路径」)', async () => {
    const result = await xlsxBytesToCsv(await openpyxlStyleWorkbook('/xl/worksheets/sheet1.xml'));
    expect(result).toEqual({ csv: '测量值,批次\n1.5,A\n2.5,B', sheetName: '测量数据' });
    const relative = await xlsxBytesToCsv(await openpyxlStyleWorkbook('worksheets/sheet1.xml'));
    expect(relative).toEqual(result);
  });

  it('同一包里的歧义/畸形绝对形态仍 fail closed', async () => {
    for (const target of ['/foo/xl/worksheets/sheet1.xml', '//xl/worksheets/sheet1.xml', '/xl/worksheets/xl/sheet1.xml', '/xl/../xl/worksheets/sheet1.xml', '/worksheets/sheet1.xml']) {
      const result = await xlsxBytesToCsv(await openpyxlStyleWorkbook(target));
      expect(result, target).toEqual({ error: expect.stringMatching(/相对路径|路径不安全/) });
    }
  });
});
