/**
 * PlatformAdapter — 平台能力抽象（交接文档 §4.2）。
 * Web 与桌面（Tauri）各自实现导入/导出，UI 与 core 不感知运行端。
 */
import { assertQprojExportByteLength, assertQprojExportText, assertTextImportSize } from './importLimits';
import { sessionLog } from '../store/sessionLog';

export interface ExportJob {
  defaultName: string; // 不含扩展名
  ext: string; // 'xlsx' | 'csv' | 'txt' | 'qproj'
  filterLabel: string;
  text?: string; // 文本载荷（与 bytes 二选一）
  bytes?: Uint8Array; // 二进制载荷（.xlsx）
}

export interface PickedFile {
  name: string;
  contents?: string; // 文本（csv/txt/qproj）
  bytes?: Uint8Array; // 二进制（xlsx/xls）
}

export interface DatasetMeta {
  name: string;
  saved_at: string;
  bytes: number;
}

export interface DatasetDbStats {
  count: number;
  total_bytes: number;
  path: string;
}

export interface DatasetClearReceipt {
  opId: string;
  committed: true;
  removed: number;
}

export interface DatasetSnapshotEntry extends DatasetMeta {
  json: string;
}

export interface DatasetSnapshot {
  /** 每次 put/remove/项目快照替换都会递增；数据与 revision 来自同一只读事务。 */
  revision: number;
  datasets: DatasetSnapshotEntry[];
}

export interface DatasetSnapshotRequest {
  /** 已完整内嵌于 recents 的数据集可排除；forceIncludeName 始终优先保留活动引用。 */
  excludeNames: string[];
  forceIncludeName: string | null;
  /** 最终 QPROJ 中 vault 增量的字节预算；Rust 在读取 json TEXT 前于 SQLite 内计算 JSON 转义开销。 */
  maxJsonBytes: number;
}

export interface DatasetImportEntry {
  name: string;
  json: string;
  savedAt: string;
}

/** 本机数据集库(桌面端 SQLite;Web 端为 null)。容量不受 localStorage ~5MB 限制。 */
export interface DatasetDb {
  put(name: string, json: string): Promise<void>;
  /** 原子只插入；名称已存在返回 false，容量/写入失败抛错。缺失时不得降级为 put。 */
  insert?(name: string, json: string): Promise<boolean>;
  get(name: string): Promise<string | null>;
  list(): Promise<DatasetMeta[]>;
  remove(name: string): Promise<boolean>;
  /** 删除与 opId 回执在同一 SQLite 事务中提交；同opId重试是幂等的。 */
  clear(opId: string): Promise<DatasetClearReceipt>;
  /** IPC 回复丢失时用持久回执裁决事务是否已提交。 */
  clearStatus(opId: string): Promise<DatasetClearReceipt | null>;
  stats(): Promise<DatasetDbStats>;
  /** 桌面端项目导出使用的 SQLite 只读事务快照。旧测试/非 Tauri 适配器可不实现。 */
  readSnapshot?(request: DatasetSnapshotRequest): Promise<DatasetSnapshot>;
  /**
   * 在一个 SQLite 事务中备份旧 vault、精确替换为导入快照并写 pending journal。
   * pendingStoresJson 只含小型 localStorage stores；崩溃恢复时用于完成另一半提交。
   */
  beginProjectImport?(entries: DatasetImportEntry[], pendingStoresJson: string): Promise<void>;
  commitProjectImport?(): Promise<void>;
  rollbackProjectImport?(): Promise<void>;
  pendingProjectImport?(): Promise<string | null>;
}

export interface PlatformAdapter {
  /** 是否为桌面端（Tauri 壳） */
  isDesktop: boolean;
  /**
   * 导出文件。返回落盘路径（桌面）或下载文件名（Web）；用户取消返回 null。
   * 桌面端文件已写入但目录同步未确认时，返回值在路径后附 {@link exportDirSyncWarningText} 后缀，
   * 各调用方的「已保存: …」提示与会话日志因此原样带出警告(返回值只用于显示)。
   */
  exportFile(job: ExportJob): Promise<string | null>;
  /** 打开数据文件选择对话框（csv/txt 读文本,xlsx/xls 读二进制）；取消返回 null。 */
  pickImportFile(): Promise<PickedFile | null>;
  /** 本机数据集库;仅桌面端可用。 */
  datasetDb: DatasetDb | null;
}

/** Web 下载与桌面落盘共用的最后一道项目文件大小闸门。 */
export function assertExportJobSize(job: ExportJob): void {
  if (!/^qproj$/i.test(job.ext)) return;
  if (job.bytes) assertQprojExportByteLength(job.bytes.byteLength);
  else assertQprojExportText(job.text ?? '');
}

/** 错误消息统一构造(第三轮 P3:曾有三份实现;Tauri 命令拒绝值是字符串,直接取 .message 会显示「undefined」)。
 * 复审 P2:空 message / null / 无原型对象都必须落到「未知错误」——否则界面会显示
 * 「undefined」「[object Object]」,String() 对 Object.create(null) 还会二次抛出。 */
export function errText(error: unknown): string {
  // 自审:整体包 try——`error.message` 可能是抛异常的 getter(实测会穿透到调用方),
  // String() 对 Object.create(null) 也会抛。任何异常都必须落到「未知错误」。
  try {
    if (error instanceof Error) return error.message || '未知错误';
    if (typeof error === 'string') return error || '未知错误';
    const text = String(error);
    return text && text !== 'undefined' && text !== 'null' ? text : '未知错误';
  } catch { return '未知错误'; }
}

/** 文本文件解码:先按 UTF-8 严格解码,失败回退 GB18030(中文 Windows Excel「另存为 CSV」
 * 默认编码)。两种编码都必须 fatal：非法字节不得用替换字符静默污染列名或数据。 */

export async function decodeTextFileBytes(f: Blob): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  // BOM 嗅探(第三轮 P3,与 Rust read_text_file 同口径):带 UTF-8 BOM 的文件按 UTF-8 权威解码,
  // 不再落 GB18030 回退——否则同一文件「菜单导入」与「拖入窗口」两条路径结果相反
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
    } catch {
      throw new Error('文件带 UTF-8 BOM，但内容包含非法 UTF-8 字节，已拒绝导入');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder('gb18030', { fatal: true });
    } catch {
      throw new Error('当前浏览器不支持 GB18030 解码，无法安全导入非 UTF-8 文本');
    }
    try {
      return decoder.decode(bytes);
    } catch {
      throw new Error('文件既不是有效 UTF-8，也不是有效 GB18030，已拒绝导入');
    }
  }
}

const BINARY_EXT = /\.(xlsx|xls)$/i;

/** Excel 导入文件上限（Web 和桌面端共用）。 */
export const MAX_XLSX_IMPORT_BYTES = 20 * 1024 * 1024;

export function assertXlsxImportSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Excel 文件大小无效');
  }
  if (byteLength > MAX_XLSX_IMPORT_BYTES) {
    throw new Error('Excel 文件超过 20 MB 导入上限');
  }
}

export type ExcelContainerKind = 'ooxml-zip' | 'biff8-ole';

/**
 * 扩展名只决定选择器如何读取文件，解析边界以载荷魔数为准。OOXML 是 ZIP；
 * Excel 97–2003 BIFF8 是 OLE Compound File，不得误送进 ZIP 中央目录预检。
 */
export function detectExcelContainer(bytes: Uint8Array): ExcelContainerKind | null {
  if (bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B) {
    const tail = (bytes[2] << 8) | bytes[3];
    // 本地文件头 / 空归档 EOCD / data descriptor / 中央目录。后两者也保留给
    // 最小化的 bomb 预检夹具，由中央目录校验继续 fail closed。
    if (tail === 0x0304 || tail === 0x0506 || tail === 0x0708 || tail === 0x0102) return 'ooxml-zip';
  }
  const oleMagic = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  if (bytes.byteLength >= oleMagic.length && oleMagic.every((value, index) => bytes[index] === value)) {
    return 'biff8-ole';
  }
  return null;
}

/** 单个 zip 条目解压后上限。 */
export const MAX_XLSX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 全部条目解压后累计上限。 */
export const MAX_XLSX_TOTAL_BYTES = 192 * 1024 * 1024;
/** 条目数上限(zip bomb 常用海量小条目)。 */
export const MAX_XLSX_ENTRIES = 4096;
/** 单条目最大压缩比。 */
export const MAX_XLSX_RATIO = 400;

/**
 * 结构性拒绝的统一处置指引:这类包 SheetJS 本身能读,只是导入守卫为堵住「预扫描与 SheetJS
 * 读到不同部件」而更严;Excel/WPS 另存会重写成规范形制。
 */
export const XLSX_RESAVE_HINT = '可用 Excel/WPS 打开后另存再导入';

/** 结构预检后交给实际流式解压校验的中央目录声明。 */
export interface XlsxArchiveEntryBudget {
  name: string;
  crc32: number;
  compressedBytes: number;
  uncompressedBytes: number;
}

function decodeXlsxEntryName(
  bytes: Uint8Array,
  start: number,
  length: number,
  utf8: boolean,
  entry: number,
): string {
  const raw = bytes.subarray(start, start + length);
  let name: string;
  if (utf8) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new Error(`Excel ZIP 第 ${entry} 个条目的 UTF-8 文件名无效`);
    }
  } else {
    // OPC/XLSX 的部件名是 URI；常规包内路径均为 ASCII。非 UTF-8 的扩展字节
    // 在不同 ZIP 解码器间没有统一映射，无法和实际解压项可靠对应，故 fail closed。
    if (raw.some((value) => value > 0x7F)) {
      throw new Error(`Excel ZIP 第 ${entry} 个条目使用无法可靠解码的文件名`);
    }
    name = new TextDecoder('utf-8').decode(raw);
  }
  if (
    name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
    || name.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Excel ZIP 第 ${entry} 个条目的文件名路径不安全`);
  }
  // PLATFORM-09-final:SheetJS 以 CFB 容器承载 ZIP,查找部件时先剥 ^Root Entry/ 再比较
  // (safegetzipfile),而 cfb_add 又原样保留以「Root Entry/」开头的条目名。于是
  // 「Root Entry/xl/worksheets/sheet1.xml」等影子条目排在前面即可遮蔽正常部件——守卫按
  // JSZip 精确名预扫描的是正常条目,SheetJS 实际解析的却是未经预算扫描的影子。规范 OOXML
  // 包没有这种前缀,直接拒绝;大小写变体虽不会被 SheetJS 剥,同属异常命名,一并 fail closed。
  if (/^root entry\//i.test(name)) {
    throw new Error(
      `Excel ZIP 第 ${entry} 个条目「${name}」以「Root Entry/」开头，会在 SheetJS 查找中遮蔽正常部件，已拒绝导入；${XLSX_RESAVE_HINT}`,
    );
  }
  return name;
}

function byteRangesEqual(
  bytes: Uint8Array,
  leftStart: number,
  rightStart: number,
  length: number,
): boolean {
  for (let i = 0; i < length; i++) {
    if (bytes[leftStart + i] !== bytes[rightStart + i]) return false;
  }
  return true;
}

/** ZIP extra 是 id/length/value 的 TLV 串。ZIP64 会把可信大小移到 extra 中，
 * 当前预检不解释该变体，因此必须 fail closed，不能继续相信 32-bit 占位值。 */
function assertZipExtraFields(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  length: number,
  label: string,
): void {
  const end = start + length;
  if (!Number.isSafeInteger(end) || start < 0 || end > bytes.byteLength) {
    throw new Error(`Excel ZIP ${label} extra 范围越界`);
  }
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw new Error(`Excel ZIP ${label} extra 字段截断`);
    const id = view.getUint16(offset, true);
    const payloadLength = view.getUint16(offset + 2, true);
    const next = offset + 4 + payloadLength;
    if (next > end) throw new Error(`Excel ZIP ${label} extra 字段长度越界`);
    if (id === 0x0001) throw new Error('Excel ZIP 使用 ZIP64 extra，当前无法证明解压边界，已拒绝导入');
    offset = next;
  }
}

/**
 * **解压前**读 ZIP 中央目录做规模预检(蜂群 P2-04)。
 * 此前只在 SheetJS 解析完成后才判工作表范围——约 70 KB 的高压缩 xlsx 可展开出
 * 2620 万字符,独立探针实测在限制生效前已增加约 130 MiB RSS(另一例 0.29 MB → 205 MiB)。
 * 中央目录里就有每个条目的压缩前/后大小,不解压即可判定。
 */
export function assertXlsxArchiveBudget(bytes: Uint8Array): XlsxArchiveEntryBudget[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部回扫 End Of Central Directory(签名 0x06054b50),最多回看 64KiB+22
  const maxBack = Math.min(bytes.byteLength, 65_557);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - maxBack && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Excel 文件不是有效的 xlsx(未找到 ZIP 目录)');
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntryCount = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error('Excel ZIP 使用了不支持的分卷目录，已拒绝导入');
  }
  if (eocd + 22 + commentLength !== bytes.byteLength) {
    throw new Error('Excel ZIP 目录注释长度越界，文件可能已损坏');
  }
  if (entryCount === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) {
    throw new Error('Excel ZIP 使用 ZIP64 目录，当前无法证明解压边界，已拒绝导入');
  }
  const centralEnd = centralOffset + centralSize;
  if (
    !Number.isSafeInteger(centralEnd)
    || centralOffset > eocd
    || centralEnd !== eocd
  ) {
    throw new Error('Excel ZIP 中央目录范围无效，文件可能已损坏');
  }
  if (entryCount > MAX_XLSX_ENTRIES) {
    throw new Error(`Excel 文件含 ${entryCount} 个内部条目，超过 ${MAX_XLSX_ENTRIES} 上限（疑似压缩炸弹）`);
  }
  let offset = centralOffset;
  let total = 0;
  const entries: XlsxArchiveEntryBudget[] = [];
  const entryNames = new Set<string>();
  const localRanges: Array<{
    start: number;
    end: number;
    entry: number;
    hasDataDescriptor: boolean;
  }> = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > centralEnd) {
      throw new Error(`Excel ZIP 中央目录在第 ${i + 1} 个条目前截断`);
    }
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`Excel ZIP 中央目录第 ${i + 1} 个条目签名无效`);
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLen + extraLen + commentLen;
    if (nextOffset > centralEnd) {
      throw new Error(`Excel ZIP 中央目录第 ${i + 1} 个条目长度越界`);
    }
    if (nameLen === 0) throw new Error(`Excel ZIP 第 ${i + 1} 个条目文件名为空`);
    if (diskStart !== 0) throw new Error(`Excel ZIP 第 ${i + 1} 个条目位于不支持的分卷`);
    const hasDataDescriptor = (flags & 0x0008) !== 0;
    if ((flags & 0x0041) !== 0) throw new Error(`Excel ZIP 第 ${i + 1} 个条目使用加密，已拒绝导入`);
    if (method !== 0 && method !== 8) {
      throw new Error(`Excel ZIP 第 ${i + 1} 个条目使用不支持的压缩方法 ${method}`);
    }
    if (compressed === 0xFFFFFFFF || uncompressed === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
      throw new Error('Excel ZIP 条目使用 ZIP64 占位值，当前无法证明解压边界，已拒绝导入');
    }
    if (method === 0 && compressed !== uncompressed) {
      throw new Error(`Excel ZIP 第 ${i + 1} 个存储条目的压缩与展开大小不一致`);
    }
    if (uncompressed > MAX_XLSX_ENTRY_BYTES) {
      throw new Error(`Excel 内部条目解压后 ${(uncompressed / 1048576).toFixed(1)} MB，超过 ${MAX_XLSX_ENTRY_BYTES / 1048576} MB 上限`);
    }
    if (uncompressed > 0 && compressed === 0) {
      throw new Error('Excel 内部条目压缩大小为 0，文件可能是压缩炸弹');
    }
    if (compressed > 0 && uncompressed / compressed > MAX_XLSX_RATIO) {
      throw new Error(`Excel 内部条目压缩比 ${Math.round(uncompressed / compressed)}:1，超过 ${MAX_XLSX_RATIO}:1 上限（疑似压缩炸弹）`);
    }
    total += uncompressed;
    if (total > MAX_XLSX_TOTAL_BYTES) {
      throw new Error(`Excel 解压后累计 ${(total / 1048576).toFixed(0)} MB，超过 ${MAX_XLSX_TOTAL_BYTES / 1048576} MB 上限`);
    }
    if (localHeaderOffset + 30 > centralOffset || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Excel ZIP 第 ${i + 1} 个条目的本地文件头无效`);
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    const localCrc = view.getUint32(localHeaderOffset + 14, true);
    const localCompressed = view.getUint32(localHeaderOffset + 18, true);
    const localUncompressed = view.getUint32(localHeaderOffset + 22, true);
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    if (localFlags !== flags) throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 flags 与中央目录不一致`);
    if (localMethod !== method) throw new Error(`Excel ZIP 第 ${i + 1} 个条目的压缩方法与中央目录不一致`);
    if (hasDataDescriptor) {
      // bit 3 允许本地头先写 0、在流末尾补 descriptor；部分写入器也会回填
      // 已知值。无论哪种情况，数据边界只取已通过 ZIP64 检查的中央目录值。
      if (localCompressed === 0xFFFFFFFF || localUncompressed === 0xFFFFFFFF) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的本地头使用 ZIP64 大小，当前无法证明 data descriptor 边界，已拒绝导入`);
      }
      if (localCrc !== 0 && localCrc !== crc) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的本地头 CRC 与中央目录不一致`);
      }
      if (
        (localCompressed !== 0 && localCompressed !== compressed)
        || (localUncompressed !== 0 && localUncompressed !== uncompressed)
      ) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的本地头大小与中央目录不一致`);
      }
    } else {
      if (localCrc !== crc) throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 CRC 与中央目录不一致`);
      if (localCompressed !== compressed || localUncompressed !== uncompressed) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的压缩或展开大小与中央目录不一致`);
      }
    }
    if (localNameLen !== nameLen) throw new Error(`Excel ZIP 第 ${i + 1} 个条目的文件名长度与中央目录不一致`);

    const centralNameStart = offset + 46;
    const centralExtraStart = centralNameStart + nameLen;
    const localNameStart = localHeaderOffset + 30;
    const localExtraStart = localNameStart + localNameLen;
    const dataStart = localExtraStart + localExtraLen;
    const dataEnd = dataStart + compressed;
    if (!Number.isSafeInteger(dataEnd) || dataStart > centralOffset || dataEnd > centralOffset) {
      throw new Error(`Excel ZIP 第 ${i + 1} 个条目的压缩数据范围越过中央目录`);
    }
    if (!byteRangesEqual(bytes, centralNameStart, localNameStart, nameLen)) {
      throw new Error(`Excel ZIP 第 ${i + 1} 个条目的文件名与中央目录不一致`);
    }
    const entryName = decodeXlsxEntryName(bytes, centralNameStart, nameLen, (flags & 0x0800) !== 0, i + 1);
    if (entryNames.has(entryName)) {
      throw new Error(`Excel ZIP 含重复内部条目「${entryName}」，无法逐项核验解压输出`);
    }
    entryNames.add(entryName);
    assertZipExtraFields(bytes, view, centralExtraStart, extraLen, `中央目录第 ${i + 1} 项`);
    assertZipExtraFields(bytes, view, localExtraStart, localExtraLen, `本地文件头第 ${i + 1} 项`);
    // ZIP 规范允许本地头与中央目录携带不同的非尺寸 extra（Excel 生成的
    // 正常工作簿确有这种情况）。两份都已独立做 TLV 边界检查并拒绝 ZIP64，
    // 不应再要求字节完全相同，否则会误伤合法 xlsx。
    let localEntryEnd = dataEnd;
    if (hasDataDescriptor) {
      // descriptor 没有独立长度字段。中央目录的 32-bit 压缩大小先确定
      // dataEnd，再只接受规范中的 12 字节无签名或 16 字节带签名形式。
      // ZIP64 的 20/24 字节形式已由目录占位值和 extra 检查 fail closed。
      const descriptorStart = dataEnd;
      if (descriptorStart + 12 > centralOffset) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 data descriptor 范围越过中央目录`);
      }
      const hasDescriptorSignature = view.getUint32(descriptorStart, true) === 0x08074b50;
      const descriptorFieldsStart = descriptorStart + (hasDescriptorSignature ? 4 : 0);
      localEntryEnd = descriptorFieldsStart + 12;
      if (!Number.isSafeInteger(localEntryEnd) || localEntryEnd > centralOffset) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 data descriptor 范围越过中央目录`);
      }
      const descriptorCrc = view.getUint32(descriptorFieldsStart, true);
      const descriptorCompressed = view.getUint32(descriptorFieldsStart + 4, true);
      const descriptorUncompressed = view.getUint32(descriptorFieldsStart + 8, true);
      if (descriptorCrc !== crc) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 data descriptor CRC 与中央目录不一致`);
      }
      if (descriptorCompressed !== compressed) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 data descriptor 压缩大小与中央目录不一致`);
      }
      if (descriptorUncompressed !== uncompressed) {
        throw new Error(`Excel ZIP 第 ${i + 1} 个条目的 data descriptor 展开大小与中央目录不一致`);
      }
    }
    localRanges.push({
      start: localHeaderOffset,
      end: localEntryEnd,
      entry: i + 1,
      hasDataDescriptor,
    });
    entries.push({
      name: entryName,
      crc32: crc,
      compressedBytes: compressed,
      uncompressedBytes: uncompressed,
    });
    offset = nextOffset;
  }
  if (offset !== centralEnd) {
    throw new Error('Excel ZIP 中央目录条目数或目录长度不一致');
  }
  localRanges.sort((a, b) => a.start - b.start);
  for (let i = 0; i < localRanges.length; i++) {
    const current = localRanges[i];
    const next = localRanges[i + 1];
    if (next && next.start < current.end) {
      throw new Error(`Excel ZIP 第 ${next.entry} 个条目的本地数据范围与其他条目重叠`);
    }
    if (current.hasDataDescriptor) {
      const nextBoundary = next?.start ?? centralOffset;
      if (current.end !== nextBoundary) {
        throw new Error(`Excel ZIP 第 ${current.entry} 个条目的 data descriptor 后存在无法解释的字节，无法排除 ZIP64 descriptor`);
      }
    }
  }
  return entries;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------- Web 实现：blob 下载 ----------
const webAdapter: PlatformAdapter = {
  isDesktop: false,
  datasetDb: null,
  async exportFile(job) {
    assertExportJobSize(job);
    const name = `${job.defaultName}.${job.ext}`;
    const blob = job.bytes
      ? new Blob([job.bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' })
      : new Blob(['﻿' + (job.text ?? '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return name;
  },
  async pickImportFile() {
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.csv,.txt,.xlsx,.xls,.qproj';
      inp.onchange = async () => {
        try {
          const f = inp.files?.[0];
          if (!f) return resolve(null);
          if (BINARY_EXT.test(f.name)) {
            assertXlsxImportSize(f.size); // 读取前拒绝过大文件
            const bytes = new Uint8Array(await f.arrayBuffer());
            assertXlsxImportSize(bytes.byteLength); // 读取后再校验实际载荷
            resolve({ name: f.name, bytes });
          } else {
            assertTextImportSize(f.name, f.size); // 文本读取前按 CSV/TXT 与 QPROJ 分别限流
            resolve({ name: f.name, contents: await decodeTextFileBytes(f) });
          }
        } catch (error) {
          reject(error);
        }
      };
      inp.oncancel = () => resolve(null);
      inp.click();
    });
  },
};

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 桌面实现：原生对话框 + Rust 命令落盘 ----------
const desktopDatasetDb: DatasetDb = {
  async put(name, json) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('db_put_dataset', { name, json, savedAt: new Date().toISOString() });
  },
  async insert(name, json) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('db_insert_dataset', { name, json, savedAt: new Date().toISOString() });
  },
  async get(name) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('db_get_dataset', { name });
  },
  async list() {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DatasetMeta[]>('db_list_datasets');
  },
  async remove(name) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('db_delete_dataset', { name });
  },
  async clear(opId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DatasetClearReceipt>('db_clear_all_datasets', { opId });
  },
  async clearStatus(opId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DatasetClearReceipt | null>('db_get_clear_status', { opId });
  },
  async stats() {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DatasetDbStats>('db_stats');
  },
  async readSnapshot(request) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DatasetSnapshot>('db_read_snapshot', {
      excludeNames: request.excludeNames,
      forceIncludeName: request.forceIncludeName,
      maxJsonBytes: request.maxJsonBytes,
    });
  },
  async beginProjectImport(entries, pendingStoresJson) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('db_begin_project_import', { entries, pendingStoresJson });
  },
  async commitProjectImport() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('db_commit_project_import');
  },
  async rollbackProjectImport() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('db_rollback_project_import');
  },
  async pendingProjectImport() {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('db_pending_project_import');
  },
};

/**
 * 5a G16 尾巴:save_text_file / save_binary_file 返回 Option<String>——非 null 表示「文件已原子写入，
 * 但父目录 fsync 未确认」(断电后目录项可能丢失)。这是警告不是失败:照常返回路径，并附后缀。
 */
export function exportDirSyncWarningText(detail: string): string {
  const compact = detail.replace(/\s+/g, ' ').trim();
  const shown = compact.length > 160 ? `${compact.slice(0, 159)}…` : compact;
  return `（文件已保存，但未能确认目录同步${shown ? `：${shown}` : ''}；建议确认文件存在后再关闭电源）`;
}

const desktopAdapter: PlatformAdapter = {
  isDesktop: true,
  datasetDb: desktopDatasetDb,
  async exportFile(job) {
    assertExportJobSize(job); // 打开保存对话框前拒绝，不让用户误以为已生成可用备份
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({
      title: '导出报表',
      defaultPath: `${job.defaultName}.${job.ext}`,
      filters: [{ name: job.filterLabel, extensions: [job.ext] }],
    });
    if (!path) return null;
    const warning = job.bytes
      ? await invoke<string | null>('save_binary_file', { path, dataB64: toBase64(job.bytes) })
      : await invoke<string | null>('save_text_file', { path, contents: '﻿' + (job.text ?? '') });
    if (typeof warning === 'string') {
      sessionLog(`导出警告 · 文件已保存，但未能确认目录同步 · ${path} · ${warning}`);
      return `${path}${exportDirSyncWarningText(warning)}`;
    }
    return path;
  },
  async pickImportFile() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await open({
      title: '导入数据',
      multiple: false,
      filters: [{ name: '数据 / 项目文件', extensions: ['csv', 'txt', 'xlsx', 'xls', 'qproj'] }],
    });
    if (!path || Array.isArray(path)) return null;
    const name = path.split(/[\\/]/).pop() ?? path;
    if (BINARY_EXT.test(name)) {
      const b64 = await invoke<string>('read_binary_file', { path });
      const bytes = fromBase64(b64);
      assertXlsxImportSize(bytes.byteLength); // Rust 已限制，JS 边界再防御一次
      return { name, bytes };
    }
    const contents = await invoke<string>('read_text_file', { path });
    return { name, contents };
  },
};

export const platform: PlatformAdapter = isTauri() ? desktopAdapter : webAdapter;
