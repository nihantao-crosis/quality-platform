/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_QPROJ_IMPORT_BYTES,
  MAX_TEXT_DATA_IMPORT_BYTES,
  assertQprojExportByteLength,
  assertTextImportSize,
  qprojExportByteLength,
  textImportLimit,
  utf8ByteLength,
} from '../../platform/importLimits';
import { assertExportJobSize, platform } from '../../platform/adapter';

afterEach(() => vi.restoreAllMocks());

describe('文本与项目文件导入上限', () => {
  it('CSV/TXT 为 20 MB，QPROJ 为 64 MB，边界值本身可用', () => {
    expect(textImportLimit('data.csv').bytes).toBe(MAX_TEXT_DATA_IMPORT_BYTES);
    expect(textImportLimit('DATA.TXT').bytes).toBe(MAX_TEXT_DATA_IMPORT_BYTES);
    expect(textImportLimit('backup.QPROJ').bytes).toBe(MAX_QPROJ_IMPORT_BYTES);
    expect(() => assertTextImportSize('data.csv', MAX_TEXT_DATA_IMPORT_BYTES)).not.toThrow();
    expect(() => assertTextImportSize('backup.qproj', MAX_QPROJ_IMPORT_BYTES)).not.toThrow();
    expect(() => assertTextImportSize('data.csv', MAX_TEXT_DATA_IMPORT_BYTES + 1))
      .toThrow('CSV/TXT 文件超过 20 MB 导入上限');
    expect(() => assertTextImportSize('backup.qproj', MAX_QPROJ_IMPORT_BYTES + 1))
      .toThrow('项目文件超过 64 MB 导入上限');
  });

  it('Web 选择过大 CSV 时在调用 file.text 前拒绝', async () => {
    const text = vi.fn(async () => 'should not be read');
    const file = { name: 'too-large.csv', size: MAX_TEXT_DATA_IMPORT_BYTES + 1, text } as unknown as File;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    await expect(platform.pickImportFile()).rejects.toThrow('CSV/TXT 文件超过 20 MB 导入上限');
    expect(text).not.toHaveBeenCalled();
  });

  it('Web 选择过大 QPROJ 时使用独立上限并在读取前拒绝', async () => {
    const text = vi.fn(async () => 'should not be read');
    const file = { name: 'too-large.qproj', size: MAX_QPROJ_IMPORT_BYTES + 1, text } as unknown as File;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    await expect(platform.pickImportFile()).rejects.toThrow('项目文件超过 64 MB 导入上限');
    expect(text).not.toHaveBeenCalled();
  });

  it('导出按实际 UTF-8+BOM 字节计数，超限错误说明为何取消与如何缩小', () => {
    expect(utf8ByteLength('A测试😀')).toBe(1 + 6 + 4);
    expect(qprojExportByteLength('{}')).toBe(5); // 3 字节 BOM + 2 字节 JSON
    expect(() => assertQprojExportByteLength(MAX_QPROJ_IMPORT_BYTES)).not.toThrow();
    expect(() => assertQprojExportByteLength(MAX_QPROJ_IMPORT_BYTES + 1)).toThrow('软件无法重新打开');
    expect(() => assertQprojExportByteLength(MAX_QPROJ_IMPORT_BYTES + 1)).toThrow('数据集库（本机）');
  });

  it('Web/桌面共用的导出任务闸门在任何落盘副作用前拒绝超限 QPROJ', () => {
    const oversizedBytes = { byteLength: MAX_QPROJ_IMPORT_BYTES + 1 } as unknown as Uint8Array;
    // 项目实际使用文本任务；多字节字符用更小的 JS 字符串即可越过 64 MB UTF-8+BOM 边界。
    const oversizedText = '汉'.repeat(Math.floor((MAX_QPROJ_IMPORT_BYTES - 3) / 3) + 1);
    expect(() => assertExportJobSize({
      defaultName: 'backup', ext: 'qproj', filterLabel: '项目', bytes: oversizedBytes,
    })).toThrow('已取消导出');
    expect(() => assertExportJobSize({
      defaultName: 'backup', ext: 'qproj', filterLabel: '项目', text: oversizedText,
    })).toThrow('已取消导出');
    expect(() => assertExportJobSize({
      defaultName: 'report', ext: 'txt', filterLabel: '报告', bytes: oversizedBytes,
    })).not.toThrow();
  });
});
