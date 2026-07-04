/**
 * .xlsx / .xls 导入 — SheetJS 解析首个工作表,转 CSV 后走现有 parseMatrix 管线。
 */
import * as XLSX from 'xlsx';

export function xlsxBytesToCsv(bytes: Uint8Array): { csv: string; sheetName: string } | { error: string } {
  try {
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { error: '工作簿为空' };
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
    if (csv.trim() === '') return { error: `工作表「${sheetName}」没有数据` };
    return { csv, sheetName };
  } catch (e) {
    return { error: '工作簿解析失败：' + (e as Error).message };
  }
}
