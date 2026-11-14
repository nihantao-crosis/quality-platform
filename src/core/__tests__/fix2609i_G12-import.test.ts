/**
 * 2026-09 全面审查第 4 批 G12-import:导入侧收口回归。
 * 语料取自 2b+1d 批对抗复审的复现(PLATFORM-09-final「Root Entry/」影子条目、CORE-04-final
 * Tab/逗号 sourceColumnCount 不对称),全部调用真实生产函数;修复前失败、修复后通过。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractPChartColumns, parseMatrix, type ParsedMatrix } from '../csv';
import { assertXlsxArchiveBudget, type XlsxArchiveEntryBudget } from '../../platform/adapter';
import { verifyXlsxArchiveContents, xlsxBytesToCsv } from '../../platform/xlsxImport';

function ok(result: ParsedMatrix | { error: string }): ParsedMatrix {
  if ('error' in result) throw new Error(`unexpected parse error: ${result.error}`);
  return result;
}

// ------------------------------------------------------------ (1) Root Entry 影子条目

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const WORKBOOK_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const WORKSHEET_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const RESAVE = '可用 Excel/WPS 打开后另存再导入';

/** 显式 Override 形态:SheetJS 自己写出的标准包(/xl/workbook.xml 有 main+xml Override)。 */
function explicitWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['测量值'], [1], [2]]), '正常');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** implicit 形态:.NET Open XML SDK / MES 导出,无 workbook Override,靠 Default xml=main+xml。 */
async function implicitWorkbook(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${XML_DECL}<Types xmlns="${CT_NS}"><Default Extension="xml" ContentType="${WORKBOOK_CT}" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${WORKSHEET_CT}" /></Types>`);
  zip.file('_rels/.rels', `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${REL_NS}/officeDocument" Target="/xl/workbook.xml" Id="R1" /></Relationships>`);
  zip.file('xl/workbook.xml', `${XML_DECL}<x:workbook xmlns:x="${MAIN_NS}"><x:sheets><x:sheet name="正常" sheetId="1" r:id="R2" xmlns:r="${REL_NS}" /></x:sheets></x:workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml" Id="R2" /></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `${XML_DECL}<x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>测量值</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c></x:row><x:row r="3"><x:c r="A3"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** 把若干影子条目排在中央目录最前(SheetJS safegetzipfile 取第一个折叠后同名的条目)。 */
async function withShadowsFirst(base: Uint8Array, shadows: Record<string, string>): Promise<Uint8Array> {
  const source = await JSZip.loadAsync(base);
  const zip = new JSZip();
  for (const [name, content] of Object.entries(shadows)) zip.file(name, content, { createFolders: false });
  for (const name of Object.keys(source.files)) {
    const item = source.files[name];
    if (item.dir) continue;
    zip.file(name, await item.async('uint8array'), { createFolders: false });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const SHADOW_SHEET = `${XML_DECL}<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>影子</t></is></c></row><row r="2"><c r="A2"><v>9</v></c></row><row r="3"><c r="A3"><v>9</v></c></row></sheetData></worksheet>`;

async function shadowCases(form: 'explicit' | 'implicit'): Promise<Array<[string, Uint8Array]>> {
  const base = form === 'explicit' ? explicitWorkbook() : await implicitWorkbook();
  const source = await JSZip.loadAsync(base);
  const workbookXml = await source.file('xl/workbook.xml')!.async('string');
  const workbookRels = await source.file('xl/_rels/workbook.xml.rels')!.async('string');
  const shadowWorkbook = workbookXml.replace(/name="正常"/, 'name="影子"');
  const shadowTypes = `${XML_DECL}<Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="xml" ContentType="application/xml" /><Override PartName="/xl/evil.xml" ContentType="${WORKBOOK_CT}" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${WORKSHEET_CT}" /></Types>`;
  return [
    ['影子首表', await withShadowsFirst(base, { 'Root Entry/xl/worksheets/sheet1.xml': SHADOW_SHEET })],
    ['影子 workbook.xml', await withShadowsFirst(base, { 'Root Entry/xl/workbook.xml': shadowWorkbook })],
    ['影子 [Content_Types].xml', await withShadowsFirst(base, {
      'Root Entry/[Content_Types].xml': shadowTypes,
      'xl/evil.xml': shadowWorkbook,
      'xl/_rels/evil.xml.rels': workbookRels,
    })],
  ];
}

function sheetJsFirst(bytes: Uint8Array): { name: string; csv: string } {
  const wb = XLSX.read(bytes, { type: 'array', sheets: 0 });
  const name = wb.SheetNames[0];
  return { name, csv: XLSX.utils.sheet_to_csv(wb.Sheets[name], { rawNumbers: true }) };
}

describe('PLATFORM-09-final:SheetJS 剥 ^Root Entry/ 前缀查找,影子条目不得绕过预扫描', () => {
  for (const form of ['explicit', 'implicit'] as const) {
    it(`${form} 形态:影子首表 / 影子 workbook / 影子 CT 都在 SheetJS 之前被拒绝`, async () => {
      const base = form === 'explicit' ? explicitWorkbook() : await implicitWorkbook();
      // 基线:不带影子的同一个包正常导入
      expect(await xlsxBytesToCsv(base)).toEqual({ csv: '测量值\n1\n2', sheetName: '正常' });
      for (const [name, bytes] of await shadowCases(form)) {
        // 夹具有效性:SheetJS 直读确实读到了影子(守卫预扫描的却是正常条目)
        const direct = sheetJsFirst(bytes);
        expect(direct.name === '影子' || direct.csv.startsWith('影子'), `${form}/${name} SheetJS 读到影子`).toBe(true);
        // 守卫:中央目录预检阶段就以「Root Entry/」拒绝,并附处置指引
        expect(() => assertXlsxArchiveBudget(bytes), `${form}/${name}`).toThrow(/Root Entry\//);
        const result = await xlsxBytesToCsv(bytes);
        expect(result, `${form}/${name}`).toEqual({ error: expect.stringMatching(/Root Entry\//) });
        expect(result, `${form}/${name}`).toEqual({ error: expect.stringContaining(RESAVE) });
      }
    });
  }

  it('第二道防线:verifyXlsxArchiveContents 按 SheetJS 口径(去 Root Entry/ 前缀 + 小写)折叠后判冲突', async () => {
    const bytes = await withShadowsFirst(explicitWorkbook(), { 'Root Entry/XL/Workbook.xml': '<x/>' });
    // 绕过中央目录预检,直接用 JSZip 读到的声明构造条目表,只验证折叠冲突判定
    const zip = await JSZip.loadAsync(bytes);
    const entries: XlsxArchiveEntryBudget[] = Object.keys(zip.files).map((name) => {
      const data = (zip.files[name] as unknown as {
        _data: { crc32: number; compressedSize: number; uncompressedSize: number };
      })._data;
      return { name, crc32: data.crc32, compressedBytes: data.compressedSize, uncompressedBytes: data.uncompressedSize };
    });
    await expect(verifyXlsxArchiveContents(bytes, entries)).rejects.toThrow(/Root Entry\/XL\/Workbook\.xml.*xl\/workbook\.xml|xl\/workbook\.xml.*Root Entry\/XL\/Workbook\.xml/);
  });

  it('大小写不同的「root entry/」前缀在 SheetJS 里不会被剥,但同样按异常条目拒绝(fail closed)', async () => {
    const bytes = await withShadowsFirst(explicitWorkbook(), { 'root entry/xl/workbook.xml': '<x/>' });
    expect(() => assertXlsxArchiveBudget(bytes)).toThrow(/Root Entry\//);
  });
});

describe('PLATFORM-09-final P3:SheetJS 可读、只是守卫更严的其余拒绝统一附处置指引', () => {
  async function mutateSheet(mutate: (xml: string) => string): Promise<Uint8Array> {
    const source = await JSZip.loadAsync(explicitWorkbook());
    const xml = await source.file('xl/worksheets/sheet1.xml')!.async('string');
    source.file('xl/worksheets/sheet1.xml', mutate(xml));
    return source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  it('row 缺 r、c 缺 r、首表 XML 注释:报错附「另存再导入」', async () => {
    const cases: Array<[string, (xml: string) => string, RegExp]> = [
      ['row 缺 r', (xml) => xml.replace('<row r="1"', '<row'), /row 缺少或重复属性「r」/],
      ['c 缺 r', (xml) => xml.replace('<c r="A1"', '<c'), /cell 缺少或重复属性「r」/],
      ['XML 注释', (xml) => xml.replace('<sheetData>', '<!-- note --><sheetData>'), /注释|标签结构无效/],
    ];
    for (const [name, mutate, expected] of cases) {
      const bytes = await mutateSheet(mutate);
      // SheetJS 本身可读(守卫更严)
      expect(() => XLSX.read(bytes, { type: 'array', sheets: 0 }), name).not.toThrow();
      const result = await xlsxBytesToCsv(bytes);
      expect(result, name).toEqual({ error: expect.stringMatching(expected) });
      expect(result, name).toEqual({ error: expect.stringContaining(RESAVE) });
    }
  });

  it('首表缺 worksheet content type:报错附「另存再导入」', async () => {
    const source = await JSZip.loadAsync(explicitWorkbook());
    const types = await source.file('[Content_Types].xml')!.async('string');
    source.file('[Content_Types].xml', types.replace(/<Override PartName="\/xl\/worksheets\/sheet1\.xml"[^>]*\/>/, ''));
    const bytes = await source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const result = await xlsxBytesToCsv(bytes);
    expect(result).toEqual({ error: expect.stringMatching(/缺少有效 worksheet content type/) });
    expect(result).toEqual({ error: expect.stringContaining(RESAVE) });
  });

  it('元数据 XML 含注释(workbook.xml):报错附「另存再导入」', async () => {
    const source = await JSZip.loadAsync(explicitWorkbook());
    const workbook = await source.file('xl/workbook.xml')!.async('string');
    source.file('xl/workbook.xml', workbook.replace('<sheets>', '<!-- x --><sheets>'));
    const bytes = await source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const result = await xlsxBytesToCsv(bytes);
    expect(result).toEqual({ error: expect.stringMatching(/不得包含注释/) });
    expect(result).toEqual({ error: expect.stringContaining(RESAVE) });
  });
});

// ------------------------------------------------------------ (2) sourceColumnCount Tab/逗号对称

describe('CORE-04-final:表头有名、数据全空的尾列在 Tab 与逗号两条路径同口径计入', () => {
  it('复审复现:「样本量」表头在、数据全空 → Tab 与逗号都拒绝(修复前 Tab 被放行为单列、n 取默认 50)', () => {
    const texts = [
      '\t不良数\t样本量\r\n\t3\t\r\n\t2\t\r\n\t4\t\r\n',
      ',不良数,样本量\r\n,3,\r\n,2,\r\n,4,\r\n',
      '不良数\t样本量\r\n3\t\r\n2\t\r\n4\t\r\n',
      '不良数,样本量\r\n3,\r\n2,\r\n4,\r\n',
    ];
    for (const text of texts) {
      const parsed = ok(parseMatrix(text));
      expect(parsed.sourceColumnCount, JSON.stringify(text)).toBe(2);
      expect(extractPChartColumns(parsed, 50), JSON.stringify(text)).toEqual({
        error: expect.stringMatching(/无法识别 行\/列非法值/),
      });
    }
  });

  it('尾部空表头 + 空数据的列仍不计入:「不良数,样本量,,」继续放行', () => {
    for (const text of ['不良数,样本量,,\n3,50,,\n2,50,,\n4,40,,\n', '不良数\t样本量\t\t\n3\t50\t\t\n2\t50\t\t\n4\t40\t\t\n']) {
      const parsed = ok(parseMatrix(text));
      expect(parsed.sourceColumnCount, JSON.stringify(text)).toBe(2);
      expect(extractPChartColumns(parsed, 50)).toEqual({ counts: [3, 2, 4], sampleSizes: [50, 50, 40], variableSampleSizes: true });
    }
  });

  it('既有放行形态不回归:空白 A 列 + 两列完整数据 / 单列不良数', () => {
    for (const text of ['\t不良数\t样本量\n\t3\t50\n\t2\t50\n\t4\t40\n', ',不良数,样本量\n,3,50\n,2,50\n,4,40\n']) {
      expect(extractPChartColumns(ok(parseMatrix(text)), 50)).toEqual({ counts: [3, 2, 4], sampleSizes: [50, 50, 40], variableSampleSizes: true });
    }
    expect(extractPChartColumns(ok(parseMatrix('不良数\n3\n2\n4\n')), 50)).toEqual({ counts: [3, 2, 4], sampleSizes: 50, variableSampleSizes: false });
  });
});
