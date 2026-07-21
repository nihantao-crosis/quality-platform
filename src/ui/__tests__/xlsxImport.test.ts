/**
 * .xlsx 导入往返 — SheetJS 写出的工作簿应能被导入管线解析。
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { MAX_XLSX_IMPORT_BYTES, assertXlsxImportSize } from '../../platform/adapter';
import { XLSX_WORKSHEET_LIMITS, worksheetLimitError, xlsxBytesToCsv } from '../../platform/xlsxImport';
import { parseMatrix } from '../../core';

function workbookBytes(sheet: XLSX.WorkSheet): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '测量数据');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('.xlsx 导入', () => {
  it('工作簿 → CSV → 解析矩阵(含表头与文本列)', () => {
    const wb = XLSX.utils.book_new();
    const aoa = [
      ['直径1', '直径2', '设备'],
      [25.01, 24.99, 'A'],
      [25.02, 25.0, 'B'],
      [24.98, 25.03, 'A'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '测量数据');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    const r = xlsxBytesToCsv(bytes);
    if ('error' in r) throw new Error(r.error);
    expect(r.sheetName).toBe('测量数据');

    const m = parseMatrix(r.csv);
    if ('error' in m) throw new Error(m.error);
    expect(m.colNames).toEqual(['直径1', '直径2']);
    expect(m.rows.length).toBe(3);
    expect(m.rows[0][0]).toBeCloseTo(25.01, 10);
    expect(m.textCols.map((c) => c.name)).toEqual(['设备']);
  });
  it('空工作簿报错', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    expect('error' in xlsxBytesToCsv(bytes)).toBe(true);
  });

  it('20 MB 上限在读取边界和解析边界都生效', () => {
    expect(() => assertXlsxImportSize(MAX_XLSX_IMPORT_BYTES)).not.toThrow();
    expect(() => assertXlsxImportSize(MAX_XLSX_IMPORT_BYTES + 1)).toThrow('Excel 文件超过 20 MB 导入上限');
    expect(xlsxBytesToCsv(new Uint8Array(MAX_XLSX_IMPORT_BYTES + 1))).toEqual({
      error: 'Excel 文件超过 20 MB 导入上限',
    });
  });

  it('超过 200000 行时明确报错，不把 sheetRows 截断结果当成完整工作表', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['测量值']]);
    sheet.A300000 = { t: 'n', v: 1 };
    sheet['!ref'] = 'A1:A300000';
    const result = xlsxBytesToCsv(workbookBytes(sheet));
    expect(result).toEqual({ error: '工作表「测量数据」共 300000 行，超过 200000 行导入上限' });
  });

  it('拒绝超宽工作表和超过 200 万的矩形数据范围', () => {
    const tooWide = XLSX.utils.aoa_to_sheet([['测量值']]);
    tooWide.IW1 = { t: 'n', v: 1 }; // IW 是第 257 列
    tooWide['!ref'] = 'A1:IW1';
    expect(xlsxBytesToCsv(workbookBytes(tooWide))).toEqual({
      error: '工作表「测量数据」共 257 列，超过 256 列导入上限',
    });

    const tooManyCells = XLSX.utils.aoa_to_sheet([['测量值']]);
    tooManyCells.IV7813 = { t: 'n', v: 1 }; // 7813 × 256 = 2,000,128
    tooManyCells['!ref'] = 'A1:IV7813';
    expect(xlsxBytesToCsv(workbookBytes(tooManyCells))).toEqual({
      error: '工作表「测量数据」的数据范围共 2000128 个单元格，超过 2000000 个导入上限',
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
    const count = Math.floor(XLSX_WORKSHEET_LIMITS.textCharacters / repeated.length) + 1;
    const sheet: XLSX.WorkSheet = { '!ref': `A1:A${count}` };
    for (let row = 1; row <= count; row++) sheet[`A${row}`] = { t: 's', v: repeated };
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
