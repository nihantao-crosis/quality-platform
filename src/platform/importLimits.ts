/**
 * 文本导入资源上限。CSV/TXT 是未压缩数据，20 MB 已能容纳常规质量分析表；
 * QPROJ 可包含多个数据集与快照，因此保留更高的 64 MB 上限。
 */
export const MAX_TEXT_DATA_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_QPROJ_IMPORT_BYTES = 64 * 1024 * 1024;

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
