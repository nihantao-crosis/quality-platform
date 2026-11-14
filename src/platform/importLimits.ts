/**
 * 文本导入资源上限。CSV/TXT 是未压缩数据，20 MB 已能容纳常规质量分析表；
 * QPROJ 可包含多个数据集与快照，因此保留更高的 64 MB 上限。
 */
export const MAX_TEXT_DATA_IMPORT_BYTES = 20 * 1024 * 1024;
/** 剪贴板先做 UTF-16 字符数快检，再计算 UTF-8；避免把超大字符串写入 React state。 */
export const MAX_CLIPBOARD_IMPORT_CHARS = 20_000_000;
export { MAX_IMPORT_DATA_ROWS } from '../core/csv';
export const MAX_QPROJ_IMPORT_BYTES = 64 * 1024 * 1024;
const UTF8_BOM_BYTES = 3;

export class QprojExportSizeError extends Error {
  constructor(byteLength: number, estimated: boolean) {
    const sizeMb = (byteLength / 1024 / 1024).toFixed(1);
    const limitMb = MAX_QPROJ_IMPORT_BYTES / 1024 / 1024;
    super(`项目文件${estimated ? '预计至少' : '生成后'}为 ${sizeMb} MB，超过 ${limitMb} MB 导入上限；`
      + '为避免生成软件无法重新打开的备份，已取消导出。'
      + '请在「数据 → 数据集库（本机）」删除不再需要的归档数据集，或缩小当前数据后重试');
    this.name = 'QprojExportSizeError';
  }
}

/** 与 TextEncoder 相同的 UTF-8 字节数，但不再分配一份最高 64 MB 的字节数组。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00
      && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3; // BMP 字符或未配对代理项（TextEncoder 会转为 U+FFFD）
  }
  return bytes;
}

/** 导出层会统一在文本前加 UTF-8 BOM，必须把这 3 字节算入可再导入上限。 */
export function qprojExportByteLength(text: string): number {
  return UTF8_BOM_BYTES + utf8ByteLength(text);
}

export function assertQprojExportByteLength(byteLength: number, estimated = false): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('项目文件导出大小无效');
  }
  if (byteLength > MAX_QPROJ_IMPORT_BYTES) throw new QprojExportSizeError(byteLength, estimated);
}

export function assertQprojExportText(text: string): void {
  assertQprojExportByteLength(qprojExportByteLength(text));
}

export function textImportLimit(fileName: string): { bytes: number; label: string } {
  return /\.qproj$/i.test(fileName)
    ? { bytes: MAX_QPROJ_IMPORT_BYTES, label: '项目文件' }
    : { bytes: MAX_TEXT_DATA_IMPORT_BYTES, label: 'CSV/TXT 文件' };
}

export function assertTextImportSize(fileName: string, byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`${textImportLimit(fileName).label}大小无效`);
  }
  const limit = textImportLimit(fileName);
  if (byteLength > limit.bytes) {
    throw new Error(`${limit.label}超过 ${limit.bytes / 1024 / 1024} MB 导入上限`);
  }
}

/** 弹窗粘贴与工作表 Ctrl/Cmd+V 共用同一入口，且必须在解析/写 React state 前调用。 */
export function assertClipboardImportText(text: string): void {
  if (text.length > MAX_CLIPBOARD_IMPORT_CHARS) {
    throw new Error(`剪贴板文本超过 ${MAX_CLIPBOARD_IMPORT_CHARS.toLocaleString()} 字符上限`);
  }
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_TEXT_DATA_IMPORT_BYTES) {
    throw new Error(`剪贴板文本 UTF-8 大小超过 ${MAX_TEXT_DATA_IMPORT_BYTES / 1024 / 1024} MB 导入上限`);
  }
}
