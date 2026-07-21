/**
 * .xlsx / .xls 导入 — SheetJS 解析首个工作表,转 CSV 后走现有 parseMatrix 管线。
 */
import * as XLSX from 'xlsx';
import { assertXlsxImportSize } from './adapter';

export const XLSX_WORKSHEET_LIMITS = Object.freeze({
  rows: 200_000,
  columns: 256,
  cells: 2_000_000,
  stringLength: 32_767,
  textCharacters: 20_000_000,
});

export function worksheetLimitError(sheet: XLSX.WorkSheet, sheetName: string): string | null {
  // sheetRows 发生截断时 SheetJS 把原始范围保存在 !fullref，必须用它判定“过大”，
  // 否则会把前 200001 行误当成完整工作表。
  const ref = sheet['!fullref'] ?? sheet['!ref'];
  if (!ref) return null;

  let range: XLSX.Range;
  try {
    range = XLSX.utils.decode_range(ref);
  } catch {
    return `工作表「${sheetName}」的数据范围无效`;
  }
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  if (rows > XLSX_WORKSHEET_LIMITS.rows) {
    return `工作表「${sheetName}」共 ${rows} 行，超过 ${XLSX_WORKSHEET_LIMITS.rows} 行导入上限`;
  }
  if (columns > XLSX_WORKSHEET_LIMITS.columns) {
    return `工作表「${sheetName}」共 ${columns} 列，超过 ${XLSX_WORKSHEET_LIMITS.columns} 列导入上限`;
  }
  const cells = rows * columns;
  if (cells > XLSX_WORKSHEET_LIMITS.cells) {
    return `工作表「${sheetName}」的数据范围共 ${cells} 个单元格，超过 ${XLSX_WORKSHEET_LIMITS.cells} 个导入上限`;
  }

  // 不用 Object.entries，避免在大表上再分配一份庞大的键值数组。
  let textCharacters = 0;
  for (const address in sheet) {
    if (!Object.prototype.hasOwnProperty.call(sheet, address) || address.startsWith('!')) continue;
    const value = (sheet[address] as XLSX.CellObject).v;
    if (typeof value === 'string' && value.length > XLSX_WORKSHEET_LIMITS.stringLength) {
      return `工作表「${sheetName}」单元格 ${address} 的文本长度超过 ${XLSX_WORKSHEET_LIMITS.stringLength} 字符上限`;
    }
    if (typeof value === 'string') {
      textCharacters += value.length;
      if (textCharacters > XLSX_WORKSHEET_LIMITS.textCharacters) {
        return `工作表「${sheetName}」文本内容超过 ${XLSX_WORKSHEET_LIMITS.textCharacters} 字符累计上限`;
      }
    }
  }
  return null;
}

export function xlsxBytesToCsv(bytes: Uint8Array): { csv: string; sheetName: string } | { error: string } {
  try {
    assertXlsxImportSize(bytes.byteLength);
  } catch (error) {
    return { error: (error as Error).message };
  }
  try {
    // 只读首个工作表，并多读 1 行作为超限哨兵；检测到哨兵后整表拒绝，不静默截断。
    const wb = XLSX.read(bytes, {
      type: 'array',
      sheets: 0,
      sheetRows: XLSX_WORKSHEET_LIMITS.rows + 1,
    });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { error: '工作簿为空' };
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return { error: `无法读取工作表「${sheetName}」` };
    const limitError = worksheetLimitError(sheet, sheetName);
    if (limitError) return { error: limitError };
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim() === '') return { error: `工作表「${sheetName}」没有数据` };
    return { csv, sheetName };
  } catch (e) {
    return { error: '工作簿解析失败：' + (e as Error).message };
  }
}
