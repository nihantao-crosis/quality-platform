/**
 * .xlsx 导入往返 — SheetJS 写出的工作簿应能被导入管线解析。
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  MAX_XLSX_IMPORT_BYTES,
  assertXlsxImportSize,
} from '../../platform/adapter';
import JSZip from 'jszip';
import {
  MAX_BIFF8_IMPORT_BYTES,
  XLSX_WORKSHEET_LIMITS,
  worksheetLimitError,
  xlsxBytesToCsv,
} from '../../platform/xlsxImport';
import { parseMatrix } from '../../core';

function workbookBytes(sheet: XLSX.WorkSheet, compression = false): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '测量数据');
  return new Uint8Array(
    XLSX.write(wb, {
      type: 'array',
      bookType: 'xlsx',
      compression,
    }) as ArrayBuffer,
  );
}

function workbookSheetsBytes(
  sheets: readonly XLSX.WorkSheet[],
  compression = false,
): Uint8Array {
  const wb = XLSX.utils.book_new();
  sheets.forEach((sheet, index) =>
    XLSX.utils.book_append_sheet(wb, sheet, `工作表${index + 1}`),
  );
  return new Uint8Array(
    XLSX.write(wb, {
      type: 'array',
      bookType: 'xlsx',
      compression,
    }) as ArrayBuffer,
  );
}

async function replaceZipText(
  zip: JSZip,
  name: string,
  replace: (text: string) => string,
): Promise<void> {
  const item = zip.file(name);
  if (!item) throw new Error(`fixture entry missing: ${name}`);
  const before = await item.async('string');
  const after = replace(before);
  if (after === before)
    throw new Error(`fixture mutation did not change: ${name}`);
  zip.file(name, after);
}

function mutateFirstRelationship(
  xml: string,
  mutate: (relationship: string) => string,
): string {
  const match = /<Relationship\b(?=[^>]*\bId="rId1")[^>]*\/>/.exec(xml);
  if (!match) throw new Error('fixture first relationship missing');
  return xml.replace(match[0], mutate(match[0]));
}

async function generatedWorksheetXml(sheet: XLSX.WorkSheet): Promise<string> {
  const zip = await JSZip.loadAsync(workbookBytes(sheet, true));
  const name = Object.keys(zip.files).find((entryName) =>
    /xl\/worksheets\/sheet1\.xml$/i.test(entryName),
  );
  if (!name) throw new Error('generated fixture worksheet missing');
  return zip.file(name)!.async('string');
}

function firstParsedSheet(bytes: Uint8Array): XLSX.WorkSheet {
  const workbook = XLSX.read(bytes, { type: 'array', sheets: 0 });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) {
    throw new Error('SheetJS did not parse the crafted first sheet');
  }
  return workbook.Sheets[sheetName];
}

function tamperFirstEntry(
  bytes: Uint8Array,
  field: 'uncompressed' | 'crc',
): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let eocd = -1;
  for (let i = out.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('test workbook EOCD missing');
  const central = view.getUint32(eocd + 16, true);
  const local = view.getUint32(central + 42, true);
  if ((view.getUint16(central + 8, true) & 0x0008) !== 0)
    throw new Error('test entry unexpectedly uses descriptor');
  if (field === 'uncompressed') {
    view.setUint32(central + 24, 1, true);
    view.setUint32(local + 22, 1, true);
  } else {
    const tampered = (view.getUint32(central + 16, true) ^ 1) >>> 0;
    view.setUint32(central + 16, tampered, true);
    view.setUint32(local + 14, tampered, true);
  }
  return out;
}

describe('.xlsx 导入', () => {
  it('工作簿 → CSV → 解析矩阵(含表头与文本列)', async () => {
    const wb = XLSX.utils.book_new();
    const aoa = [
      ['直径1', '直径2', '设备'],
      [25.01, 24.99, 'A'],
      [25.02, 25.0, 'B'],
      [24.98, 25.03, 'A'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '测量数据');
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );

    const r = await xlsxBytesToCsv(bytes);
    if ('error' in r) throw new Error(r.error);
    expect(r.sheetName).toBe('测量数据');

    const m = parseMatrix(r.csv);
    if ('error' in m) throw new Error(m.error);
    expect(m.colNames).toEqual(['直径1', '直径2']);
    expect(m.rows.length).toBe(3);
    expect(m.rows[0][0]).toBeCloseTo(25.01, 10);
    expect(m.textCols.map((c) => c.name)).toEqual(['设备']);
  });
  it('空工作簿报错', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    expect('error' in (await xlsxBytesToCsv(bytes))).toBe(true);
  });

  it('20 MB 上限在读取边界和解析边界都生效', async () => {
    expect(() => assertXlsxImportSize(MAX_XLSX_IMPORT_BYTES)).not.toThrow();
    expect(() => assertXlsxImportSize(MAX_XLSX_IMPORT_BYTES + 1)).toThrow(
      'Excel 文件超过 20 MB 导入上限',
    );
    expect(
      await xlsxBytesToCsv(new Uint8Array(MAX_XLSX_IMPORT_BYTES + 1)),
    ).toEqual({
      error: 'Excel 文件超过 20 MB 导入上限',
    });
  });

  it('SheetJS 前按实际流式展开结果拒绝伪造的大小与 CRC 声明', async () => {
    const bytes = workbookBytes(
      XLSX.utils.aoa_to_sheet([['测量值'], [1], [2]]),
      true,
    );
    expect(
      await xlsxBytesToCsv(tamperFirstEntry(bytes, 'uncompressed')),
    ).toMatchObject({
      error: expect.stringMatching(/实际展开大小|uncompressed data size/i),
    });
    expect(await xlsxBytesToCsv(tamperFirstEntry(bytes, 'crc'))).toMatchObject({
      error: expect.stringMatching(/实际内容 CRC/),
    });
  });

  it('超过 200000 行时明确报错，不把 sheetRows 截断结果当成完整工作表', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['测量值']]);
    sheet.A300000 = { t: 'n', v: 1 };
    sheet['!ref'] = 'A1:A300000';
    const result = await xlsxBytesToCsv(workbookBytes(sheet));
    expect(result).toEqual({
      error: expect.stringMatching(/300000 行.*200000 行导入上限/),
    });
  });

  it('只对首个工作表执行行列契约，无关第二表超过 200000 行仍可导入', async () => {
    const first = XLSX.utils.aoa_to_sheet([['测量值'], [42]]);
    const ignoredSecond = XLSX.utils.aoa_to_sheet([['不导入']]);
    ignoredSecond.A300001 = { t: 'n', v: 1 };
    ignoredSecond['!ref'] = 'A1:A300001';

    const result = await xlsxBytesToCsv(
      workbookSheetsBytes([first, ignoredSecond], true),
    );
    expect(result).toMatchObject({ sheetName: '工作表1' });
    if ('error' in result) throw new Error(result.error);
    expect(result.csv).toContain('42');
  });

  it('拒绝超宽工作表和超过 200 万的矩形数据范围', async () => {
    const tooWide = XLSX.utils.aoa_to_sheet([['测量值']]);
    tooWide.IW1 = { t: 'n', v: 1 }; // IW 是第 257 列
    tooWide['!ref'] = 'A1:IW1';
    expect(await xlsxBytesToCsv(workbookBytes(tooWide))).toEqual({
      error: expect.stringMatching(/257 列.*256 列导入上限/),
    });

    const tooManyCells = XLSX.utils.aoa_to_sheet([['测量值']]);
    tooManyCells.IV7813 = { t: 'n', v: 1 }; // 7813 × 256 = 2,000,128
    tooManyCells['!ref'] = 'A1:IV7813';
    expect(await xlsxBytesToCsv(workbookBytes(tooManyCells))).toEqual({
      error:
        '工作表「测量数据」的数据范围共 2000128 个单元格，超过 2000000 个导入上限',
    });
  });

  it('SheetJS 前按真实 cell 地址拒绝伪造为小 dimension 的超宽表', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const zip = await JSZip.loadAsync(workbookBytes(sheet, true));
    const worksheet = Object.keys(zip.files).find((name) =>
      /xl\/worksheets\/sheet\d+\.xml$/i.test(name),
    );
    if (!worksheet) throw new Error('fixture worksheet missing');
    const xml = await zip.file(worksheet)!.async('string');
    zip.file(
      worksheet,
      xml.replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1"/>'),
    );
    const forged = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    const result = await xlsxBytesToCsv(forged);
    expect(result).toEqual({
      error: expect.stringMatching(/Excel 内部工作表.*(?:257 列|超过 256 列)/),
    });
  });

  it('cell/row 标签属性内的 literal > 不会截断预扫描地址', async () => {
    const wideSheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const zip = await JSZip.loadAsync(workbookBytes(wideSheet, true));
    await replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
      xml
        .replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1"/>')
        .replace('<row r="1">', '<row foo=">" r="1">')
        .replace('<c r="IW1">', '<c foo=">" r="IW1">'),
    );
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    expect(firstParsedSheet(bytes).IW1).toBeDefined();
    expect(await xlsxBytesToCsv(bytes)).toEqual({
      error: expect.stringMatching(/257 列.*256 列导入上限/),
    });
  });

  it('首表 scanner 对可引起 SheetJS 分歧的 XML 结构与 cell 地址 fail closed', async () => {
    const base = workbookBytes(
      XLSX.utils.aoa_to_sheet([['测量值'], [1]]),
      true,
    );
    const cases: Array<{
      name: string;
      expected: RegExp;
      mutate: (xml: string) => string;
    }> = [
      {
        name: '注释中的伪 cell',
        expected: /XML (?:标签结构无效|不得包含注释)/,
        mutate: (xml) =>
          xml.replace('<sheetData>', '<!-- <c r="IW1"/> --><sheetData>'),
      },
      {
        name: 'CDATA 中的伪 cell',
        expected: /XML (?:标签结构无效|不得包含注释)/,
        mutate: (xml) =>
          xml.replace('<sheetData>', '<![CDATA[<c r="IW1"/>]]><sheetData>'),
      },
      {
        name: '额外 processing instruction',
        expected: /注释、CDATA 或处理指令/,
        mutate: (xml) => xml.replace('<sheetData>', '<?evil data?><sheetData>'),
      },
      {
        name: 'foreign namespace cell',
        expected: /非规范 cell 结构/,
        mutate: (xml) =>
          xml
            .replace('<worksheet ', '<worksheet xmlns:evil="urn:evil" ')
            .replace('<c r="A1"', '<evil:c r="IW1"')
            .replace('</c>', '</evil:c>'),
      },
      {
        name: '大小写变体 cell',
        expected: /非规范 cell 结构/,
        mutate: (xml) =>
          xml.replace('<c r="A1"', '<C r="IW1"').replace('</c>', '</C>'),
      },
      {
        name: '缺失 cell r',
        expected: /属性「r」/,
        mutate: (xml) => xml.replace('<c r="A1"', '<c'),
      },
      {
        name: '畸形 cell r',
        expected: /cell 地址无效/,
        mutate: (xml) => xml.replace('<c r="A1"', '<c r="IW-1"'),
      },
      {
        name: '无 row wrapper 的 cell',
        expected: /非规范 cell 结构/,
        mutate: (xml) => xml.replace(/<row r="1">([\s\S]*?)<\/row>/, '$1'),
      },
      {
        name: 'row r 放在 literal > 属性后',
        expected: /200001 行.*200000 行导入上限/,
        mutate: (xml) => xml.replace('<row r="1">', '<row foo=">" r="200001">'),
      },
    ];

    for (const scenario of cases) {
      const zip = await JSZip.loadAsync(base);
      await replaceZipText(zip, 'xl/worksheets/sheet1.xml', scenario.mutate);
      const bytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
      });
      expect(await xlsxBytesToCsv(bytes), scenario.name).toEqual({
        error: expect.stringMatching(scenario.expected),
      });
    }
  });

  it('共享公式是 cell 内容，不干扰地址预扫描', async () => {
    const zip = await JSZip.loadAsync(
      workbookBytes(XLSX.utils.aoa_to_sheet([['结果'], [2], [3]]), true),
    );
    await replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
      xml
        .replace(
          '<c r="A2"><v>2</v></c>',
          '<c r="A2"><f t="shared" si="0">1+1</f><v>2</v></c>',
        )
        .replace(
          '<c r="A3"><v>3</v></c>',
          '<c r="A3"><f t="shared" si="0"/><v>3</v></c>',
        ),
    );
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    expect(await xlsxBytesToCsv(bytes)).toMatchObject({
      sheetName: '测量数据',
    });
  });

  it('OOXML 首表 relationship 可指向无 .xml 扩展名的自定义路径，仍在 SheetJS 前扫描实际 cell', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const zip = await JSZip.loadAsync(workbookBytes(sheet, true));
    const oldName = Object.keys(zip.files).find((name) =>
      /xl\/worksheets\/sheet\d+\.xml$/i.test(name),
    );
    if (!oldName) throw new Error('fixture worksheet missing');
    const xml = await zip.file(oldName)!.async('string');
    const customName = 'xl/custom/measurement-data';
    zip.file(
      customName,
      xml.replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1"/>'),
    );
    zip.remove(oldName);

    const relsName = 'xl/_rels/workbook.xml.rels';
    const rels = await zip.file(relsName)!.async('string');
    zip.file(
      relsName,
      rels.replace(
        /Target="worksheets\/sheet\d+\.xml"/,
        'Target="custom/measurement-data"',
      ),
    );
    const contentTypesName = '[Content_Types].xml';
    const contentTypes = await zip.file(contentTypesName)!.async('string');
    zip.file(
      contentTypesName,
      contentTypes.replace(
        /PartName="\/xl\/worksheets\/sheet\d+\.xml"/,
        'PartName="/xl/custom/measurement-data"',
      ),
    );

    const forged = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    expect(await xlsxBytesToCsv(forged)).toEqual({
      error: expect.stringMatching(/measurement-data.*(?:257 列|超过 256 列)/),
    });
  });

  it('拒绝 percent-escaped Target，不把解码后的诱饵部件当成 SheetJS 实际首表', async () => {
    const wideSheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const zip = await JSZip.loadAsync(workbookBytes(wideSheet, true));
    const oldName = 'xl/worksheets/sheet1.xml';
    const wideXml = await zip.file(oldName)!.async('string');
    const forgedWideXml = wideXml.replace(
      /<dimension\b[^>]*\/>/,
      '<dimension ref="A1"/>',
    );
    const safeXml = await generatedWorksheetXml(
      XLSX.utils.aoa_to_sheet([['安全诱饵'], [1]]),
    );
    zip.file('xl/custom/measurement-data', safeXml);
    zip.file('xl/custom/measurement%2Ddata', forgedWideXml);
    zip.remove(oldName);
    await replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
      mutateFirstRelationship(xml, (relationship) =>
        relationship.replace(
          /Target="[^"]+"/,
          'Target="custom/measurement%2Ddata"',
        ),
      ),
    );
    await replaceZipText(zip, '[Content_Types].xml', (xml) =>
      xml.replace(
        'PartName="/xl/worksheets/sheet1.xml"',
        'PartName="/xl/custom/measurement%2Ddata"',
      ),
    );
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });

    expect(firstParsedSheet(bytes).IW1).toBeDefined();
    expect(await xlsxBytesToCsv(bytes)).toEqual({
      error: expect.stringMatching(/percent-escape/),
    });
  });

  it('元数据 Target_x、id_x 与 PartName_x 不得把预扫描与 SheetJS 首表切向不同部件', async () => {
    const safeSheet = XLSX.utils.aoa_to_sheet([['安全首表'], [1]]);
    const wideSheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const base = workbookSheetsBytes([safeSheet, wideSheet], true);
    const scenarios: Array<{
      name: string;
      mutate: (zip: JSZip) => Promise<void>;
    }> = [
      {
        name: 'Target_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace(
                'Target="worksheets/sheet1.xml"',
                'Target="worksheets/sheet1.xml" Target_x="worksheets/sheet2.xml"',
              ),
            ),
          ),
      },
      {
        name: 'id_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/workbook.xml', (xml) =>
            xml.replace('r:id="rId1"', 'r:id="rId1" id_x="rId2"'),
          ),
      },
      {
        name: 'PartName_x',
        mutate: async (zip) => {
          const workbookXml = await zip
            .file('xl/workbook.xml')!
            .async('string');
          zip.file(
            'xl/evil-workbook.xml',
            workbookXml.replace('r:id="rId1"', 'r:id="rId2"'),
          );
          await replaceZipText(zip, '[Content_Types].xml', (xml) =>
            xml.replace(
              'PartName="/xl/workbook.xml"',
              'PartName="/xl/workbook.xml" PartName_x="/xl/evil-workbook.xml"',
            ),
          );
        },
      },
    ];

    for (const scenario of scenarios) {
      const zip = await JSZip.loadAsync(base);
      await replaceZipText(zip, 'xl/worksheets/sheet2.xml', (xml) =>
        xml.replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1"/>'),
      );
      await scenario.mutate(zip);
      const bytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
      });
      expect(firstParsedSheet(bytes).IW1, scenario.name).toBeDefined();
      expect(await xlsxBytesToCsv(bytes), scenario.name).toEqual({
        error: expect.stringMatching(/下划线别名/),
      });
    }
  });

  it('所有 SheetJS 关键属性的 underscore alias 都在生产解析前 fail closed', async () => {
    const base = workbookBytes(
      XLSX.utils.aoa_to_sheet([['测量值'], [1]]),
      true,
    );
    const scenarios: Array<{
      name: string;
      mutate: (zip: JSZip) => Promise<void>;
    }> = [
      {
        name: 'Type_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace('/>', ' Type_x="urn:attacker:worksheet"/>'),
            ),
          ),
      },
      {
        name: 'TargetMode_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace('/>', ' TargetMode_x="External"/>'),
            ),
          ),
      },
      {
        name: 'ContentType_x',
        mutate: (zip) =>
          replaceZipText(zip, '[Content_Types].xml', (xml) =>
            xml.replace(
              'PartName="/xl/worksheets/sheet1.xml"',
              'PartName="/xl/worksheets/sheet1.xml" ContentType_x="application/xml"',
            ),
          ),
      },
      {
        name: 'cell r_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
            xml
              .replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1:A2"/>')
              .replace('<c r="A2"', '<c r="A2" r_x="IW1"'),
          ),
      },
      {
        name: 'row r_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
            xml.replace('<row r="2">', '<row r="2" r_x="200001">'),
          ),
      },
      {
        name: 'dimension ref_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
            xml.replace(
              '<dimension ref="A1:A2"',
              '<dimension ref="A1:A2" ref_x="A1:IW1"',
            ),
          ),
      },
      {
        name: 'dimension Ref_x',
        mutate: (zip) =>
          replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
            xml.replace(
              '<dimension ref="A1:A2"',
              '<dimension ref="A1:A2" Ref_x="A1:IW1"',
            ),
          ),
      },
    ];

    for (const scenario of scenarios) {
      const zip = await JSZip.loadAsync(base);
      await scenario.mutate(zip);
      const bytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
      });
      expect(await xlsxBytesToCsv(bytes), scenario.name).toEqual({
        error: expect.stringMatching(/下划线别名/),
      });
    }
  });

  it('cell r_x 不得在伪小 dimension 下让 SheetJS 静默物化超宽数据', async () => {
    const zip = await JSZip.loadAsync(
      workbookBytes(XLSX.utils.aoa_to_sheet([['测量值'], [1]]), true),
    );
    await replaceZipText(zip, 'xl/worksheets/sheet1.xml', (xml) =>
      xml
        .replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1:A2"/>')
        .replace('<c r="A2"', '<c r="A2" r_x="IW1"'),
    );
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    const parsed = firstParsedSheet(bytes);
    expect(parsed.IW1).toBeDefined();
    expect(parsed['!ref']).toBe('A1:A2');
    expect(await xlsxBytesToCsv(bytes)).toEqual({
      error: expect.stringMatching(/属性「r_x」.*下划线别名/),
    });
  });

  it('拒绝规范 sheets 前的 foreign namespace sheet，不跟随 SheetJS strip_ns 切换首表', async () => {
    const safeSheet = XLSX.utils.aoa_to_sheet([['安全首表'], [1]]);
    const wideSheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const zip = await JSZip.loadAsync(
      workbookSheetsBytes([safeSheet, wideSheet], true),
    );
    await replaceZipText(zip, 'xl/worksheets/sheet2.xml', (xml) =>
      xml.replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1"/>'),
    );
    await replaceZipText(zip, 'xl/workbook.xml', (xml) =>
      xml
        .replace('<workbook ', '<workbook xmlns:evil="urn:evil" ')
        .replace(
          '<sheets>',
          '<evil:sheet name="foreign-first" sheetId="999" r:id="rId2"/><sheets>',
        ),
    );
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });

    expect(firstParsedSheet(bytes).IW1).toBeDefined();
    expect(await xlsxBytesToCsv(bytes)).toEqual({
      error: expect.stringMatching(/非规范 sheet 结构/),
    });
  });

  it('对 SheetJS 会改写首表关系的 foreign id、额外 sheet 与关系结构 fail closed', async () => {
    const safeSheet = XLSX.utils.aoa_to_sheet([['安全首表'], [1]]);
    const wideSheet = XLSX.utils.aoa_to_sheet([
      Array.from({ length: 257 }, (_, index) => index),
    ]);
    const base = workbookSheetsBytes([safeSheet, wideSheet], true);
    const cases: Array<{
      name: string;
      expected: RegExp;
      mutate: (zip: JSZip) => Promise<void>;
    }> = [
      {
        name: 'foreign namespace id 覆盖 r:id',
        expected: /异常 relationship id/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/workbook.xml', (xml) =>
            xml
              .replace('<workbook ', '<workbook xmlns:evil="urn:evil" ')
              .replace('r:id="rId1"', 'r:id="rId1" evil:id="rId2"'),
          ),
      },
      {
        name: '规范 sheets 外的额外 sheet',
        expected: /非规范 sheet 结构/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/workbook.xml', (xml) =>
            xml.replace(
              '<sheets>',
              '<sheet name="injected-first" sheetId="999" r:id="rId2"/><sheets>',
            ),
          ),
      },
      {
        name: '其他工作表关系缺失使 safe_parse_wbrels 整体回退',
        expected: /缺少工作表 relationship「rId2」/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            xml.replace(/<Relationship\b(?=[^>]*\bId="rId2")[^>]*\/>/, ''),
          ),
      },
      {
        name: '工作表 relationship id 实体',
        expected: /异常 relationship id/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/workbook.xml', (xml) =>
            xml.replace('r:id="rId1"', 'r:id="r&#x49;d1"'),
          ),
      },
      {
        name: 'foreign Target 覆盖规范 Target',
        expected: /属性「Target」/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(
              xml.replace(
                '<Relationships ',
                '<Relationships xmlns:evil="urn:evil" ',
              ),
              (relationship) =>
                relationship.replace(
                  '/>',
                  ' evil:Target="worksheets/sheet2.xml"/>',
                ),
            ),
          ),
      },
      {
        name: '嵌套 Relationship 仍被 SheetJS 全局扫描',
        expected: /非规范 Relationship 结构/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(
              xml,
              (relationship) => `<Wrapper>${relationship}</Wrapper>`,
            ),
          ),
      },
    ];

    for (const scenario of cases) {
      const zip = await JSZip.loadAsync(base);
      await scenario.mutate(zip);
      const bytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
      });
      expect(await xlsxBytesToCsv(bytes), scenario.name).toEqual({
        error: expect.stringMatching(scenario.expected),
      });
    }
  });

  it('拒绝 SheetJS 大小写不敏感查找可能选到不同部件的 ZIP', async () => {
    const zip = await JSZip.loadAsync(
      workbookBytes(XLSX.utils.aoa_to_sheet([['测量值'], [1]]), true),
    );
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    zip.file('xl/worksheets/SHEET1.xml', xml);
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    expect(await xlsxBytesToCsv(bytes)).toEqual({
      error: expect.stringMatching(/大小写冲突/),
    });
  });

  it('首表 relationship 异常或 worksheet content type 无效时 fail closed', async () => {
    const base = workbookBytes(
      XLSX.utils.aoa_to_sheet([['测量值'], [1]]),
      true,
    );
    const cases: Array<{
      name: string;
      expected: RegExp;
      mutate: (zip: JSZip) => Promise<void>;
    }> = [
      {
        name: '外部关系',
        expected: /外部|TargetMode/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace('/>', ' TargetMode="External"/>'),
            ),
          ),
      },
      {
        name: 'TargetMode 大小写异常',
        expected: /无效 TargetMode/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace('/>', ' TargetMode="internal"/>'),
            ),
          ),
      },
      // PLATFORM-09 拆分:合法的 `/xl/…` 绝对部件名已改为接受(见下方独立正向用例),
      // 这里只保留有歧义/畸形的绝对形态,它们仍须 fail closed。
      ...[
        '//xl/worksheets/sheet1.xml',
        '/worksheets/sheet1.xml',
        '/foo/xl/worksheets/sheet1.xml',
        '/xl/worksheets/xl/sheet1.xml',
        '/xl//worksheets/sheet1.xml',
        '/xl/../xl/worksheets/sheet1.xml',
        '/xl/./worksheets/sheet1.xml',
        '/xl/worksheets/sheet1%2Exml',
        '/xl/worksheets/sheet1.xml?x=1',
        '/xl/worksheets/sheet1.xml#frag',
        '/xl/worksheets\\sheet1.xml',
        '/xl/',
      ].map((target) => ({
        name: `畸形绝对 target ${target}`,
        expected: /相对路径|路径不安全/,
        mutate: (zip: JSZip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace(/Target="[^"]+"/, `Target="${target}"`),
            ),
          ),
      })),
      {
        name: '穿越 target',
        expected: /穿越/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace(
                /Target="[^"]+"/,
                'Target="../../worksheets/sheet1.xml"',
              ),
            ),
          ),
      },
      {
        name: '点段 target',
        expected: /点段/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace(
                /Target="[^"]+"/,
                'Target="worksheets/./sheet1.xml"',
              ),
            ),
          ),
      },
      {
        name: 'SheetJS xl/ 重写 target',
        expected: /相对路径/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace(
                /Target="[^"]+"/,
                'Target="xl/worksheets/sheet1.xml"',
              ),
            ),
          ),
      },
      {
        name: '实体 target',
        expected: /缺少或重复属性「Target」/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, (relationship) =>
              relationship.replace(
                /Target="[^"]+"/,
                'Target="worksheets/sheet&#x31;.xml"',
              ),
            ),
          ),
      },
      {
        name: '缺失关系',
        expected: /缺少工作表 relationship/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(xml, () => ''),
          ),
      },
      {
        name: '重复关系',
        expected: /重复 relationship Id/,
        mutate: (zip) =>
          replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
            mutateFirstRelationship(
              xml,
              (relationship) => relationship + relationship,
            ),
          ),
      },
      {
        name: '无效 content type',
        expected: /content type/,
        mutate: (zip) =>
          replaceZipText(zip, '[Content_Types].xml', (xml) =>
            xml.replace(
              /(PartName="\/xl\/worksheets\/sheet1\.xml" ContentType=")[^"]+"/,
              '$1application/xml"',
            ),
          ),
      },
      {
        name: 'percent-escaped PartName',
        expected: /percent|PartName/,
        mutate: (zip) =>
          replaceZipText(zip, '[Content_Types].xml', (xml) =>
            xml.replace(
              'PartName="/xl/worksheets/sheet1.xml"',
              'PartName="/xl/worksheets/sheet1%2Exml"',
            ),
          ),
      },
    ];

    for (const scenario of cases) {
      const zip = await JSZip.loadAsync(base);
      await scenario.mutate(zip);
      const bytes = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
      });
      expect(await xlsxBytesToCsv(bytes), scenario.name).toEqual({
        error: expect.stringMatching(scenario.expected),
      });
    }
  });

  it('合法的 /xl/… 包内绝对部件名(openpyxl/pandas、.NET 导出形制)被接受并读出同一张表', async () => {
    const base = workbookBytes(
      XLSX.utils.aoa_to_sheet([['测量值', '批次'], [1.5, 'A'], [2.5, 'B']]),
      true,
    );
    const relative = await xlsxBytesToCsv(base);
    const zip = await JSZip.loadAsync(base);
    await replaceZipText(zip, 'xl/_rels/workbook.xml.rels', (xml) =>
      mutateFirstRelationship(xml, (relationship) =>
        relationship.replace(/Target="[^"]+"/, 'Target="/xl/worksheets/sheet1.xml"'),
      ),
    );
    const absolute = await xlsxBytesToCsv(
      await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    );
    expect(relative).toEqual({ csv: '测量值,批次\n1.5,A\n2.5,B', sheetName: '测量数据' });
    expect(absolute).toEqual(relative);
  });

  it('旧版 BIFF8 在同步解析前执行更保守的字节上限', async () => {
    const bytes = new Uint8Array(MAX_BIFF8_IMPORT_BYTES + 1);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await xlsxBytesToCsv(bytes)).toEqual({
      error: '旧版 .xls 文件超过 2 MB 安全导入上限；请先另存为 .xlsx',
    });
  });

  it('拒绝超过 Excel 单元格字符上限的文本，不截断', () => {
    const sheet: XLSX.WorkSheet = {
      A1: { t: 's', v: 'x'.repeat(XLSX_WORKSHEET_LIMITS.stringLength + 1) },
      '!ref': 'A1',
    };
    expect(worksheetLimitError(sheet, '测量数据')).toBe(
      '工作表「测量数据」单元格 A1 的文本长度超过 32767 字符上限',
    );
  });

  it('拒绝累计文本展开过大的压缩工作表，避免 sheet_to_csv 再生成超大字符串', () => {
    const repeated = 'x'.repeat(XLSX_WORKSHEET_LIMITS.stringLength);
    const count =
      Math.floor(XLSX_WORKSHEET_LIMITS.textCharacters / repeated.length) + 1;
    const sheet: XLSX.WorkSheet = { '!ref': `A1:A${count}` };
    for (let row = 1; row <= count; row++)
      sheet[`A${row}`] = { t: 's', v: repeated };
    expect(worksheetLimitError(sheet, '测量数据')).toBe(
      '工作表「测量数据」文本内容超过 20000000 字符累计上限',
    );
  });

  it('各项上限本身可接受，不会产生差一错误', () => {
    const sheet: XLSX.WorkSheet = {
      A1: { t: 's', v: 'x'.repeat(XLSX_WORKSHEET_LIMITS.stringLength) },
      '!ref': 'A1:J200000', // 200000 × 10 = 2000000
    };
    expect(worksheetLimitError(sheet, '测量数据')).toBeNull();
  });
});
