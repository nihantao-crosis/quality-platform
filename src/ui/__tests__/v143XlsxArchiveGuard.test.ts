/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { assertXlsxArchiveBudget } from '../../platform/adapter';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';

type DescriptorKind = 'signed' | 'unsigned' | 'zip64-signed';

interface OneEntryArchiveOptions {
  centralSignature?: number;
  entryCount?: number;
  centralSize?: number;
  centralFlags?: number;
  localFlags?: number;
  centralMethod?: number;
  localMethod?: number;
  centralCompressed?: number;
  localCompressed?: number;
  centralUncompressed?: number;
  localUncompressed?: number;
  centralCrc?: number;
  localCrc?: number;
  centralName?: string;
  localName?: string;
  centralExtra?: Uint8Array;
  localExtra?: Uint8Array;
  localExtraLengthOverride?: number;
  descriptor?: DescriptorKind;
  descriptorCrc?: number;
  descriptorCompressed?: number;
  descriptorUncompressed?: number;
}

function oneEntryArchive(options: OneEntryArchiveOptions = {}): Uint8Array {
  const encoder = new TextEncoder();
  const centralName = encoder.encode(options.centralName ?? 'a');
  const localName = encoder.encode(options.localName ?? 'a');
  const centralExtra = options.centralExtra ?? new Uint8Array();
  const localExtra = options.localExtra ?? new Uint8Array();
  const centralCompressed = options.centralCompressed ?? 1;
  const centralUncompressed = options.centralUncompressed ?? centralCompressed;
  const centralCrc = options.centralCrc ?? 0;
  const localCompressed = options.localCompressed ?? (options.descriptor ? 0 : centralCompressed);
  const localUncompressed = options.localUncompressed ?? (options.descriptor ? 0 : centralUncompressed);
  const localCrc = options.localCrc ?? (options.descriptor ? 0 : centralCrc);
  const centralMethod = options.centralMethod ?? 0;
  const localMethod = options.localMethod ?? centralMethod;
  const centralFlags = options.centralFlags ?? 0;
  const localFlags = options.localFlags ?? centralFlags;
  const descriptorLength = options.descriptor === 'zip64-signed'
    ? 24
    : options.descriptor === 'signed'
      ? 16
      : options.descriptor === 'unsigned'
        ? 12
        : 0;

  const dataStart = 30 + localName.length + localExtra.length;
  const descriptorStart = dataStart + centralCompressed;
  const local = new Uint8Array(descriptorStart + descriptorLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(6, localFlags, true);
  localView.setUint16(8, localMethod, true);
  localView.setUint32(14, localCrc, true);
  localView.setUint32(18, localCompressed, true);
  localView.setUint32(22, localUncompressed, true);
  localView.setUint16(26, localName.length, true);
  localView.setUint16(28, options.localExtraLengthOverride ?? localExtra.length, true);
  local.set(localName, 30);
  local.set(localExtra, 30 + localName.length);
  if (options.descriptor) {
    const signed = options.descriptor !== 'unsigned';
    const fieldsStart = descriptorStart + (signed ? 4 : 0);
    if (signed) localView.setUint32(descriptorStart, 0x08074b50, true);
    localView.setUint32(fieldsStart, options.descriptorCrc ?? centralCrc, true);
    localView.setUint32(fieldsStart + 4, options.descriptorCompressed ?? centralCompressed, true);
    if (options.descriptor === 'zip64-signed') {
      localView.setUint32(fieldsStart + 8, 0, true);
      localView.setUint32(fieldsStart + 12, options.descriptorUncompressed ?? centralUncompressed, true);
      localView.setUint32(fieldsStart + 16, 0, true);
    } else {
      localView.setUint32(fieldsStart + 8, options.descriptorUncompressed ?? centralUncompressed, true);
    }
  }

  const central = new Uint8Array(46 + centralName.length + centralExtra.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, options.centralSignature ?? 0x02014b50, true);
  centralView.setUint16(8, centralFlags, true);
  centralView.setUint16(10, centralMethod, true);
  centralView.setUint32(16, centralCrc, true);
  centralView.setUint32(20, centralCompressed, true);
  centralView.setUint32(24, centralUncompressed, true);
  centralView.setUint16(28, centralName.length, true);
  centralView.setUint16(30, centralExtra.length, true);
  centralView.setUint32(42, 0, true);
  central.set(centralName, 46);
  central.set(centralExtra, 46 + centralName.length);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  const entryCount = options.entryCount ?? 1;
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entryCount, true);
  eocdView.setUint16(10, entryCount, true);
  eocdView.setUint32(12, options.centralSize ?? central.byteLength, true);
  eocdView.setUint32(16, local.byteLength, true);

  const bytes = new Uint8Array(local.byteLength + central.byteLength + eocd.byteLength);
  bytes.set(local, 0);
  bytes.set(central, local.byteLength);
  bytes.set(eocd, local.byteLength + central.byteLength);
  return bytes;
}

/** 第二个本地头从第一个 16-byte descriptor 的最后 3 字节处开始；各字段仍能
 * 自洽，只有把 descriptor 纳入本地条目范围后才能识别该重叠。 */
function descriptorOverlapsNextEntryArchive(): Uint8Array {
  const firstCompressed = 200_000;
  // little-endian 为 00 50 4b 03；后三字节与下一本地头签名的前三字节重合。
  const firstUncompressed = 0x034B5000;
  const firstDataStart = 31;
  const descriptorStart = firstDataStart + firstCompressed;
  const secondLocalOffset = descriptorStart + 13;
  const centralOffset = secondLocalOffset + 32;
  const centralSize = 94;
  const eocdOffset = centralOffset + centralSize;
  const bytes = new Uint8Array(eocdOffset + 22);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(6, 0x0008, true);
  view.setUint16(8, 8, true);
  view.setUint16(26, 1, true);
  bytes[30] = 0x61;
  view.setUint32(descriptorStart, 0x08074b50, true);
  view.setUint32(descriptorStart + 4, 0, true);
  view.setUint32(descriptorStart + 8, firstCompressed, true);
  view.setUint32(descriptorStart + 12, firstUncompressed, true);

  view.setUint32(secondLocalOffset, 0x04034b50, true);
  view.setUint16(secondLocalOffset + 8, 0, true);
  view.setUint32(secondLocalOffset + 18, 1, true);
  view.setUint32(secondLocalOffset + 22, 1, true);
  view.setUint16(secondLocalOffset + 26, 1, true);
  bytes[secondLocalOffset + 30] = 0x62;

  const writeCentralEntry = (
    at: number,
    flags: number,
    method: number,
    compressed: number,
    uncompressed: number,
    localOffset: number,
    name: number,
  ) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 8, flags, true);
    view.setUint16(at + 10, method, true);
    view.setUint32(at + 20, compressed, true);
    view.setUint32(at + 24, uncompressed, true);
    view.setUint16(at + 28, 1, true);
    view.setUint32(at + 42, localOffset, true);
    bytes[at + 46] = name;
  };
  writeCentralEntry(centralOffset, 0x0008, 8, firstCompressed, firstUncompressed, 0, 0x61);
  writeCentralEntry(centralOffset + 47, 0, 0, 1, 1, secondLocalOffset, 0x62);

  view.setUint32(eocdOffset, 0x06054b50, true);
  view.setUint16(eocdOffset + 8, 2, true);
  view.setUint16(eocdOffset + 10, 2, true);
  view.setUint32(eocdOffset + 12, centralSize, true);
  view.setUint32(eocdOffset + 16, centralOffset, true);
  return bytes;
}

describe('XLSX 中央目录必须 fail-closed', () => {
  it('拒绝 SheetJS 仍可能接受的错误中央目录签名', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ centralSignature: 0 }))).toThrow(/条目签名无效/);
  });

  it('拒绝 EOCD 声明条目数大于实际目录条目数', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ entryCount: 2 }))).toThrow(/截断/);
  });

  it('拒绝中央目录长度越过 EOCD', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ centralSize: 48 }))).toThrow(/范围无效/);
  });

  it('拒绝中央目录报小、本地文件头报大的大小矛盾', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({
      centralCompressed: 1, centralUncompressed: 1,
      localCompressed: 100, localUncompressed: 100,
    }))).toThrow(/大小与中央目录不一致/);
  });

  it('拒绝中央目录与本地文件头压缩方法不一致', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ centralMethod: 0, localMethod: 8 })))
      .toThrow(/压缩方法与中央目录不一致/);
  });

  it('拒绝本地 extra 声明把压缩数据范围推过中央目录', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ localExtraLengthOverride: 0xFFFF })))
      .toThrow(/数据范围|extra.*越界/);
  });

  it('拒绝文件名、ZIP64 extra 和缺失的 data descriptor', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ localName: 'b' }))).toThrow(/文件名与中央目录不一致/);
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({
      centralExtra: new Uint8Array([0x01, 0x00, 0, 0]),
    }))).toThrow(/ZIP64 extra/);
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ centralFlags: 0x0008, localFlags: 0x0008 })))
      .toThrow(/data descriptor.*越过中央目录/);
  });

  it('接受规范的 12 字节无签名和 16 字节带签名 data descriptor', async () => {
    for (const descriptor of ['unsigned', 'signed'] as const) {
      const bytes = oneEntryArchive({
        centralFlags: 0x0008,
        localFlags: 0x0008,
        centralCrc: 0xD202EF8D,
        descriptor,
      });
      expect(() => assertXlsxArchiveBudget(bytes)).not.toThrow();
      const parsed = await JSZip.loadAsync(bytes, { checkCRC32: true });
      expect(Array.from(await parsed.file('a')!.async('uint8array'))).toEqual([0]);
    }
  });

  it('逐字段拒绝与中央目录不一致及 ZIP64 形式的 data descriptor', () => {
    const base: OneEntryArchiveOptions = {
      centralFlags: 0x0008,
      localFlags: 0x0008,
      centralCrc: 0xD202EF8D,
      descriptor: 'signed',
    };
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ ...base, descriptorCrc: 0 })))
      .toThrow(/data descriptor CRC 与中央目录不一致/);
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ ...base, descriptorCompressed: 2 })))
      .toThrow(/data descriptor 压缩大小与中央目录不一致/);
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({ ...base, descriptorUncompressed: 2 })))
      .toThrow(/data descriptor 展开大小与中央目录不一致/);
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({
      ...base,
      centralCompressed: 0,
      centralUncompressed: 0,
      descriptor: 'zip64-signed',
    }))).toThrow(/无法排除 ZIP64 descriptor/);
  });

  it('data descriptor 整段参与本地条目重叠检查', () => {
    expect(() => assertXlsxArchiveBudget(descriptorOverlapsNextEntryArchive()))
      .toThrow(/本地数据范围与其他条目重叠/);
  });

  it('允许 ZIP 规范允许的本地/中央非尺寸 extra 差异', () => {
    expect(() => assertXlsxArchiveBudget(oneEntryArchive({
      centralExtra: new Uint8Array([0x55, 0x54, 0, 0]),
      localExtra: new Uint8Array([0x56, 0x54, 0, 0]),
    }))).not.toThrow();
  });

  it('真实 SheetJS xlsx 及 JSZip streamFiles xlsx 均通过结构预检', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['测量值', '班组'], [10.1, '甲'], [10.2, '乙'],
    ]), '数据');
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    expect(() => assertXlsxArchiveBudget(bytes)).not.toThrow();

    const streamed = await (await JSZip.loadAsync(bytes)).generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      streamFiles: true,
    });
    const streamedView = new DataView(streamed.buffer, streamed.byteOffset, streamed.byteLength);
    let descriptorSignatures = 0;
    for (let i = 0; i + 4 <= streamed.byteLength; i++) {
      if (streamedView.getUint32(i, true) === 0x08074b50) descriptorSignatures++;
    }
    expect(descriptorSignatures).toBeGreaterThan(0);
    expect(() => assertXlsxArchiveBudget(streamed)).not.toThrow();
    expect(XLSX.read(streamed, { type: 'array' }).SheetNames).toEqual(['数据']);
    expect(await xlsxBytesToCsv(streamed)).toMatchObject({ sheetName: '数据' });
  });
});
