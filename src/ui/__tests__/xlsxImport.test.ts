/**
 * .xlsx 导入往返 — SheetJS 写出的工作簿应能被导入管线解析。
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';
import { parseMatrix } from '../../core';

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
});
