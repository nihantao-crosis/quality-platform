/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_QPROJ_IMPORT_BYTES,
  MAX_TEXT_DATA_IMPORT_BYTES,
  assertTextImportSize,
  textImportLimit,
} from '../../platform/importLimits';
import { platform } from '../../platform/adapter';

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
});
