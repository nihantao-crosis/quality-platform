/**
 * 项目文件 (.qproj) — 单机数据的完整备份与迁移。
 * 导出:全部 qp-* 本地存储打包为单个 JSON 文件;
 * 导入:白名单校验后写回并重载,另一台机器打开即完整恢复。
 */
import { errText, platform } from './adapter';
import { localDateStamp, sanitizeFileName, timestampTextOf } from './reportLabels';
import { isIsoCalendarDate } from './calendarDate';
import {
  MAX_QPROJ_IMPORT_BYTES,
  QprojExportSizeError,
  assertQprojExportByteLength,
  assertQprojExportText,
  qprojExportByteLength,
} from './importLimits';
import { worksheetResourceError, worksheetPendingCellsError, attributeChartResourceError, individualSeriesResourceError, fishboneResourceError, MAX_IMPORT_CELL_CHARS, MAX_DATASET_NAME_CHARS, MAX_RECENT_DATASETS, MAX_VAULT_DATASETS, MAX_SAVED_AT_CHARS, MAX_PARETO_CATEGORIES, MAX_SAVED_ANALYSES, MAX_ANALYSIS_DATA_ENTRIES, MAX_ANALYSIS_ID_CHARS, MAX_ANALYSIS_DATA_KEY_CHARS, MAX_ANALYSIS_LABEL_CHARS, AQL_COLS, MAX_AQL_RECORDS, MAX_LOT_SIZE, aqlRegimeAllows, auditAqlLedger, isAqlTransitionRecord, normalizeSwitchStatus, ruleKValueError, type AqlRegime, type NelsonRuleK, type SwitchStatus } from '../core';

/** 共享键放在无业务 store 副作用的项目层，启动预恢复不得反向加载 store。 */
export const QUARANTINE_STORAGE_KEY = 'qp-quarantine-v1';

/** 允许进出项目文件的存储键；各 store 仍须自行做字段级校验。 */
export const PROJECT_KEYS = [
  'qp-dataset-v1',
  'qp-recents-v1',
  'qp-attr-v1',
  'qp-specs-v1',
  'qp-fishbone-v1',
  'qp-analyses-v1',
  'qp-analysis-data-v1',
  'qp-pareto-v1',
  'qp-copy-sequences-v1',
  'qp-quarantine-v1',
  'qp-prefs-v1',
  'qp-aql-state-v1',
  'qp-active-ref-v1',
] as const;

const FORMAT = 'quality-platform-project';
// v2 把 SQLite vault/active-ref 与独立 AQL 责任账本定义为不可忽略的项目语义。
// v3 引入 snapshotVersion=6；v4 引入 snapshotVersion=7（MSA 真实追溯字段）。
// v5（v1.43）引入偏好键 capabilityWarningAcknowledgement，并由导出侧保证跨键不变量
// （活动表与同名最近条目一致、分析数据仓库无孤儿条目）；AQL 责任账本同时可含
// kind:'transition' 的人工状态转移记录（旧版 .qproj 读取器在格式层即提示升级，不会误报账本损坏）。
// 旧读取器必须在项目格式层明确提示升级，不能接受后再把新快照误报成“损坏”。
// 因此：任何新增偏好键/存储键/快照语义都必须同步提升本版本号（见 PREFS_STATE_KEYS 守卫测试）。
const FORMAT_VERSION = 5;
/** 跨键不变量从该格式版本起由写出侧保证；更早的历史文件走迁移降级而非整份拒绝。 */
const CROSS_KEY_INVARIANT_FORMAT_VERSION = 5;
/** 供跨版本兼容测试断言当前写出的格式版本。 */
export const PROJECT_FORMAT_VERSION = FORMAT_VERSION;

interface ProjectFile {
  format: typeof FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  stores: Record<string, string>;
  /** 桌面端 SQLite 数据集库快照(name → 数据集 JSON)。可选,旧版本读取时忽略。 */
  vault?: Record<string, string>;
  /** vault 与 revision 来自同一个 SQLite 只读事务。 */
  vaultRevision?: number;
}

type ProjectStoreBackup = Map<(typeof PROJECT_KEYS)[number], string | null>;
type ProjectStoreTarget = Partial<Record<(typeof PROJECT_KEYS)[number], string>>;

const PROJECT_IMPORT_JOURNAL_KEY = 'qp-project-import-journal-v2';
const PROJECT_IMPORT_JOURNAL_DB = 'quality-platform-project-import';
const PROJECT_IMPORT_JOURNAL_STORE = 'journals';
const PROJECT_IMPORT_JOURNAL_RECORD = 'active';

type ProjectImportPhase = 'stores-only' | 'before-vault' | 'vault-pending' | 'vault-committed'
  | 'rollback-intent' | 'rolled-back';

interface ProjectImportJournal {
  version: 2;
  target: ProjectStoreTarget;
  previous: Record<(typeof PROJECT_KEYS)[number], string | null>;
  phase: ProjectImportPhase;
  digest: string;
}

interface ProjectImportJournalReservation {
  version: 2;
  state: 'reserved';
  token: string;
}

type ProjectJournalBackend = 'indexeddb' | 'localStorage';

interface LoadedProjectImportJournal {
  journal: ProjectImportJournal;
  backend: ProjectJournalBackend;
}

interface IndexedDbJournalMarker {
  version: 2;
  backend: 'indexeddb';
  target: string;
  previous: string;
  phase: ProjectImportPhase;
  digest: string;
}

const PROJECT_KEY_SET: ReadonlySet<string> = new Set(PROJECT_KEYS);
/** 用作对象键会命中 Object.prototype 的保留名(盲审 P2:此前只在**读**侧拦,
 * 应用自己仍可创建这样的数据集,之后每次导出项目都失败且无自救路径)。 */
export const RESERVED_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
]);
const VAULT_PROTOTYPE_META_KEYS: ReadonlySet<string> = RESERVED_PROTOTYPE_KEYS;

/** 数据集名是否为保留原型键;写入口据此在**创建时**就拒绝。 */
export function reservedPrototypeNameError(name: string): string | null {
  return RESERVED_PROTOTYPE_KEYS.has(name.trim())
    ? `数据集名称「${name.trim()}」是 JavaScript 对象的保留名,会让规格记忆与项目导出错乱；请换一个名称`
    : null;
}

function vaultDatasetNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return '项目文件的 vault 数据集名称无效';
  if (name.length > MAX_DATASET_NAME_CHARS) {
    return `项目文件的 vault 数据集名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`;
  }
  if (VAULT_PROTOTYPE_META_KEYS.has(name.trim())) {
    return `项目文件的 vault 数据集名称「${name}」是保留的原型元键`;
  }
  return null;
}

function emptyVault(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function sameNameSet(actual: Iterable<string>, expected: ReadonlySet<string>): boolean {
  const names = new Set(actual);
  if (names.size !== expected.size) return false;
  for (const name of names) if (!expected.has(name)) return false;
  return true;
}

type ProjectLifecycleHooks = {
  /** 导入覆盖任何本地数据前停止采集、取消旧防抖等写入源。 */
  beforeMutation?: () => void;
  /** 取消新写入源后，等待已经提交到底层的写入完成。 */
  settleBeforeMutation?: () => void | Promise<void>;
  /**
   * 导出逐键取快照前停止采集并把在途持久化写入落稳。
   * 成功获取资源时可返回 cleanup；中央 lease 只释放本次真正取得的 cleanup。
   */
  beforeExport?: (owner: symbol) => void | (() => void) | Promise<void | (() => void)>;
  /** localStorage 因配额失败时，由 store 提供内存中的最新、已序列化快照覆盖旧磁盘值。 */
  projectStoreOverrides?: () => Partial<Record<(typeof PROJECT_KEYS)[number], string>>;
  /** 项目全部写入成功后冻结旧会话写源，直到调用方整页重载新项目。 */
  afterSuccessfulMutation?: () => void;
};

const projectLifecycleHooks = new Set<ProjectLifecycleHooks>();

/** 数据/MES 层以反向注册避免 project.ts 依赖 store，保持项目格式校验可独立测试。 */
export function registerProjectLifecycleHooks(hooks: ProjectLifecycleHooks): void {
  projectLifecycleHooks.add(hooks);
}

function prepareProjectMutation(): string | null {
  try {
    projectLifecycleHooks.forEach((hooks) => hooks.beforeMutation?.());
    return null;
  } catch (error) {
    return `停止当前数据写入失败，项目未导入：${errorMessage(error)}`;
  }
}

interface ProjectExportLease {
  overrides: Partial<Record<(typeof PROJECT_KEYS)[number], string>>;
  release(): void;
}

let activeProjectExportOwner: symbol | null = null;

async function prepareProjectExport(): Promise<ProjectExportLease> {
  // 中央互斥先于任何 hook：第二个入口快速拒绝，不会触碰第一个导出的资源。
  if (activeProjectExportOwner !== null) throw new Error('已有项目导出正在进行，请等待完成后重试');
  const owner = Symbol('project-export');
  activeProjectExportOwner = owner;
  const cleanups: Array<() => void> = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { cleanups[i](); } catch { /* cleanup 必须尽力执行完，不用后一项掩盖前一项 */ }
    }
    if (activeProjectExportOwner === owner) activeProjectExportOwner = null;
  };
  try {
    for (const hooks of projectLifecycleHooks) {
      const cleanup = await hooks.beforeExport?.(owner);
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    const overrides: Partial<Record<(typeof PROJECT_KEYS)[number], string>> = {};
    for (const hooks of projectLifecycleHooks) Object.assign(overrides, hooks.projectStoreOverrides?.() ?? {});
    return { overrides, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function settleProjectMutation(): Promise<string | null> {
  try {
    for (const hooks of projectLifecycleHooks) await hooks.settleBeforeMutation?.();
    return null;
  } catch (error) {
    return `等待当前数据写入结束失败，项目未导入：${errorMessage(error)}`;
  }
}

function finishProjectMutation(): void {
  projectLifecycleHooks.forEach((hooks) => hooks.afterSuccessfulMutation?.());
}

// 错误消息唯一实现(闭环终审 P2):Tauri 命令的拒绝值是裸字符串,
// instanceof Error 为 false 会把真实原因吞成「未知错误」——.qproj 导入回滚正踩这条路径
const errorMessage = errText;

type JsonObject = Record<string, unknown>;

function isObject(raw: unknown): raw is JsonObject {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function isStringArray(raw: unknown): raw is string[] {
  return Array.isArray(raw) && raw.every((value) => typeof value === 'string');
}

function isFiniteNumberArray(raw: unknown): raw is number[] {
  return Array.isArray(raw) && raw.every((value) => typeof value === 'number' && Number.isFinite(value));
}

function worksheetValidationError(raw: unknown, requireSavedAt: boolean): string | null {
  if (!isObject(raw)) return '数据集顶层不是对象';
  if (typeof raw.name !== 'string' || !raw.name.trim()) return '数据集名称无效';
  if (raw.name.length > MAX_DATASET_NAME_CHARS) {
    return `数据集名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`;
  }
  const colNames = raw.colNames;
  if (!Array.isArray(colNames) || colNames.length === 0) {
    return '数据集 colNames 必须是非空字符串数组';
  }
  if (!Array.isArray(raw.rows) || raw.rows.length < 2) return '数据集 rows 至少需要 2 行';
  if (raw.textCols !== undefined && !Array.isArray(raw.textCols)) {
    return '数据集 textCols 不是数组';
  }

  // 安全前置闸门：这里只读取顶层数组的 length。超行、超列或超单元格载荷
  // 必须在 colNames/rows/textCols/pendingCells 的任何逐项扫描、Set 分配之前拒绝。
  // 这既保护 .qproj，也保护启动时复用本校验器的 active/recent/vault 数据。
  const dimensionError = worksheetResourceError({
    rows: raw.rows.length,
    cols: colNames.length,
    textCols: Array.isArray(raw.textCols) ? raw.textCols.length : 0,
  });
  if (dimensionError) return `数据集超出资源上限：${dimensionError}`;

  if (raw.pendingCells !== undefined) {
    const pendingError = worksheetPendingCellsError(raw.pendingCells, {
      rows: raw.rows.length,
      cols: colNames.length,
    });
    if (pendingError) return `数据集 ${pendingError}`;
  }
  if (raw.indivSeries !== undefined) {
    if (!Array.isArray(raw.indivSeries)) return '数据集 indivSeries 必须是至少 2 项的有限数数组';
    // 同样先只读 length，避免超限独立序列先被 .every 全量扫描。
    const indivResourceError = individualSeriesResourceError(raw.indivSeries.length);
    if (indivResourceError) return `数据集超出资源上限：${indivResourceError}`;
  }

  // 通过维度预算后，以下深校验至多遍历产品明确支持的 200 万格。
  if (!isStringArray(colNames) || colNames.some((name) => !name.trim())) {
    return '数据集 colNames 必须是非空字符串数组';
  }
  if (raw.rows.some((row) => !isFiniteNumberArray(row) || row.length !== colNames.length)) {
    return '数据集矩阵包含非有限数，或行列数与 colNames 不一致';
  }
  if (Array.isArray(raw.textCols)) {
    for (const column of raw.textCols) {
      if (!isObject(column) || typeof column.name !== 'string' || !column.name.trim()
        || !isStringArray(column.values) || column.values.length !== raw.rows.length) {
        return '数据集文本列名称或行数与矩阵不一致';
      }
      if (column.sourceIndex !== undefined
        && (!Number.isInteger(column.sourceIndex) || (column.sourceIndex as number) < 0)) {
        return '数据集文本列 sourceIndex 无效';
      }
    }
  }
  const textNames = Array.isArray(raw.textCols)
    ? raw.textCols.map((column) => (column as JsonObject).name as string)
    : [];
  const normalizedNames = [...colNames, ...textNames].map((name) => name.trim());
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    return '数据集数值列与文本列名称必须唯一（忽略首尾空格）';
  }
  if (raw.isDemo !== undefined && typeof raw.isDemo !== 'boolean') return '数据集 isDemo 不是布尔值';
  if (raw.indivSeries !== undefined) {
    if (raw.indivSeries.length < 2 || !isFiniteNumberArray(raw.indivSeries)) {
      return '数据集 indivSeries 必须是至少 2 项的有限数数组';
    }
  }
  // 蜂群 P1-02:结构合法还不够——必须复用与 CSV/XLSX 同一套维度预算,
  // 否则 .qproj 可携带 250 万行写进 SQLite,之后每次启动都卡死。
  const resourceError = worksheetResourceError({
    rows: raw.rows.length,
    cols: colNames.length,
    textCols: Array.isArray(raw.textCols) ? raw.textCols.length : 0,
    maxCellChars: Array.isArray(raw.textCols)
      ? raw.textCols.reduce((worst: number, column) => {
        const values = (column as JsonObject).values;
        return Array.isArray(values)
          ? values.reduce((w: number, v) => Math.max(w, typeof v === 'string' ? v.length : 0), worst)
          : worst;
      }, 0)
      : 0,
    maxColumnNameChars: normalizedNames.reduce((worst, name) => Math.max(worst, name.length), 0),
  });
  if (resourceError) return `数据集超出资源上限：${resourceError}`;
  if (requireSavedAt && (typeof raw.savedAt !== 'string' || !raw.savedAt.trim())) {
    return '数据集缺少有效 savedAt';
  }
  if (typeof raw.savedAt === 'string' && raw.savedAt.length > MAX_SAVED_AT_CHARS) {
    return `数据集 savedAt 超过 ${MAX_SAVED_AT_CHARS} 字符上限`;
  }
  if (!requireSavedAt && raw.savedAt !== undefined && typeof raw.savedAt !== 'string') {
    return '数据集 savedAt 类型无效';
  }
  return null;
}

/**
 * 同名活动表与最近条目必须描述同一版本。对旧项目中可选字段缺失做稳定归一，
 * 既保留合法旧格式，又不会把字段顺序差异误判成矩阵冲突。
 * savedAt 只是写盘时间戳，不属于矩阵内容：内容逐位相同而时间不同并不代表回退旧矩阵，
 * 不参与比较（fix2609 GAP-4-11）。
 */
function sameWorksheetVersion(left: unknown, right: unknown): boolean {
  if (!isObject(left) || !isObject(right)) return false;
  const normalized = (value: JsonObject) => ({
    name: value.name,
    colNames: value.colNames,
    rows: value.rows,
    textCols: value.textCols ?? [],
    pendingCells: value.pendingCells ?? [],
    isDemo: value.isDemo === true,
    indivSeries: value.indivSeries ?? null,
  });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function paretoValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '帕累托数据顶层不是对象';
  if (typeof raw.name !== 'string' || !raw.name.trim()) return '帕累托数据集名称无效';
  if (raw.name.trim().length > MAX_IMPORT_CELL_CHARS) {
    return `帕累托数据集名称超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
  }
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) return '帕累托 rows 必须是非空数组';
  if (raw.rows.length > MAX_PARETO_CATEGORIES) {
    return `帕累托类别数超过 ${MAX_PARETO_CATEGORIES.toLocaleString()} 上限`;
  }
  if (raw.rows.some((row) => !isObject(row) || typeof row.name !== 'string' || !row.name.trim()
    || typeof row.count !== 'number' || !Number.isFinite(row.count) || row.count < 0)) {
    return '帕累托类别必须包含有效名称和非负有限频数';
  }
  const oversizedCategory = raw.rows.find((row) => (row as JsonObject).name != null
    && String((row as JsonObject).name).trim().length > MAX_IMPORT_CELL_CHARS);
  if (oversizedCategory) {
    return `帕累托单个类别名称超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
  }
  if (raw.rows.every((row) => (row as JsonObject).count === 0)) return '帕累托频数不能全部为 0';
  return null;
}

function pChartValidationError(raw: unknown): string | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return 'P 图数据缺少有效名称';
  if (raw.name.length > MAX_DATASET_NAME_CHARS) {
    return `P 图数据名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`;
  }
  if (!Array.isArray(raw.counts) || raw.counts.length < 2) {
    return 'P 图 counts 必须是至少 2 项的非负整数数组';
  }
  const resourceError = attributeChartResourceError(raw.counts.length);
  if (resourceError) return `P 图超出资源上限：${resourceError}`;
  if (raw.counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    return 'P 图 counts 必须是至少 2 项的非负整数数组';
  }
  if (raw.sampleSizes !== undefined) {
    if (!Array.isArray(raw.sampleSizes) || raw.sampleSizes.length !== raw.counts.length
      || raw.sampleSizes.some((n) => !Number.isSafeInteger(n) || n < 1)) {
      return 'P 图逐批样本量必须与 counts 等长且均为正整数';
    }
    if (raw.counts.some((count, index) => (count as number) > (raw.sampleSizes as number[])[index])) {
      return 'P 图不良数不能超过对应批次样本量';
    }
  } else {
    if (!Number.isSafeInteger(raw.sampleSize) || (raw.sampleSize as number) < 1) return 'P 图样本量无效';
    if (raw.counts.some((count) => (count as number) > (raw.sampleSize as number))) {
      return 'P 图不良数不能超过样本量';
    }
  }
  return null;
}

function cChartValidationError(raw: unknown): string | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return 'C 图数据缺少有效名称';
  if (raw.name.length > MAX_DATASET_NAME_CHARS) {
    return `C 图数据名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`;
  }
  if (!Array.isArray(raw.counts) || raw.counts.length < 2) {
    return 'C 图 counts 必须是至少 2 项的非负整数数组';
  }
  const resourceError = attributeChartResourceError(raw.counts.length);
  if (resourceError) return `C 图超出资源上限：${resourceError}`;
  if (raw.counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    return 'C 图 counts 必须是至少 2 项的非负整数数组';
  }
  return null;
}

function attrValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '计数图数据顶层不是对象';
  if (raw.p !== undefined) {
    const detail = pChartValidationError(raw.p);
    if (detail) return detail;
  }
  if (raw.c !== undefined) {
    const detail = cChartValidationError(raw.c);
    if (detail) return detail;
  }
  return null;
}

function specsValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '规格映射顶层不是对象';
  for (const [name, spec] of Object.entries(raw)) {
    if (!name.trim() || !isObject(spec)
      || typeof spec.lsl !== 'number' || !Number.isFinite(spec.lsl)
      || typeof spec.tgt !== 'number' || !Number.isFinite(spec.tgt)
      || typeof spec.usl !== 'number' || !Number.isFinite(spec.usl)) {
      return '规格映射必须包含有限数 lsl/tgt/usl';
    }
    if ((spec.lslOn !== undefined && typeof spec.lslOn !== 'boolean')
      || (spec.uslOn !== undefined && typeof spec.uslOn !== 'boolean')) {
      return '规格映射 lslOn/uslOn 必须是布尔值';
    }
    if (spec.lslOn === false && spec.uslOn === false) return '规格映射至少启用一侧规格限';
  }
  return null;
}

function fishboneDataValidationError(raw: unknown): string | null {
  if (!isObject(raw) || typeof raw.problem !== 'string' || !Array.isArray(raw.categories)
    || raw.categories.length !== 6) return '鱼骨图必须包含问题和完整 6M 分类';
  if (raw.categories.some((category) => !isObject(category) || typeof category.name !== 'string'
    || !Array.isArray(category.causes))) {
    return '鱼骨图分类或原因列表损坏';
  }
  const resourceError = fishboneResourceError(raw as unknown as {
    problem: string;
    categories: Array<{ name: string; causes: unknown[] }>;
  });
  if (resourceError) return resourceError;
  if (raw.categories.some((category) => (category as JsonObject).causes
    && ((category as JsonObject).causes as unknown[]).some((cause) => typeof cause !== 'string'))) {
    return '鱼骨图分类或原因列表损坏';
  }
  return null;
}

function fishboneValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '鱼骨图顶层不是对象';
  if ('data' in raw) {
    if (typeof raw.isDemo !== 'boolean') return '鱼骨图 isDemo 不是布尔值';
    return fishboneDataValidationError(raw.data);
  }
  return fishboneDataValidationError(raw);
}

/** spcRuleK 逐字段白名单校验:仅允许 k1–k8,范围与 core normalizeRuleK 同口径。
 * 运行时(localStorage/快照回放)非法值由 normalizeRuleK 整体回落标准值,不拒绝整份 prefs。 */
function spcRuleKValidationError(raw: unknown, label: string): string | null {
  if (!isObject(raw)) return `${label}不是有效对象`;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^k[1-8]$/.test(key)) return `${label}含有非白名单字段 ${key}`;
    const detail = ruleKValueError(key as keyof NelsonRuleK, value);
    if (detail) return `${label}无效：${detail}`;
  }
  return null;
}

/**
 * liveLedger:该载荷会成为当前活跃的 AQL 状态(独立账本 qp-aql-state-v1、旧 prefs 内嵌账本),
 * 须额外做 CORE-06 记录链重放交叉核对;历史分析卡里的旧快照只读且会被剥离,不做链审计,
 * 以免旧卡把整个分析库拖进隔离区。
 */
function aqlSwitchValidationError(rawSwitch: unknown, liveLedger = false): string | null {
  if (!isObject(rawSwitch)) return 'AQL 转移状态无效';
  const candidate = rawSwitch as Partial<SwitchStatus>;
  if (candidate.state !== undefined
    && candidate.state !== 'normal' && candidate.state !== 'tightened' && candidate.state !== 'reduced') {
    return 'AQL 检验状态无效';
  }
  const validResults = (value: unknown) => Array.isArray(value) && value.every((item) => item === 'A' || item === 'R');
  if (candidate.history !== undefined && !validResults(candidate.history)) return 'AQL 当前体系历史无效';
  if (candidate.sinceSwitch !== undefined && !validResults(candidate.sinceSwitch)) return 'AQL 转移窗口无效';
  if (candidate.note !== undefined && (typeof candidate.note !== 'string' || candidate.note.length > 500)) return 'AQL 状态说明无效';
  if (candidate.sequenceId !== undefined && (typeof candidate.sequenceId !== 'string'
    || !candidate.sequenceId.trim() || candidate.sequenceId.length > 120)) return 'AQL 检验序列号无效';
  if (candidate.switchingScore !== undefined
    && (!Number.isSafeInteger(candidate.switchingScore) || candidate.switchingScore < 0)) return 'AQL 转移得分无效';
  if (candidate.tightenedRejections !== undefined
    && (!Number.isSafeInteger(candidate.tightenedRejections) || candidate.tightenedRejections < 0)) return 'AQL 加严累计无效';
  for (const key of ['productionSteady', 'reducedApproved', 'suspended'] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'boolean') return `AQL 状态字段 ${key} 无效`;
  }
  if (candidate.records !== undefined && !Array.isArray(candidate.records)) return 'AQL 责任账本不是数组';
  if (Array.isArray(candidate.records) && candidate.records.length > MAX_AQL_RECORDS) {
    return `AQL 责任账本超过单项目 ${MAX_AQL_RECORDS} 条上限`;
  }
  const normalized = normalizeSwitchStatus(candidate);
  if (Array.isArray(candidate.records) && normalized.records.length !== candidate.records.length) {
    // S-2:v1.43 起账本可含 kind:'transition' 的人工状态转移记录(白名单 + 交叉校验在
    // normalizeSwitchStatus 内);未知 kind 或篡改的转移记录与损坏批次记录一样整本拒绝。
    const rawTransitions = (candidate.records as unknown[])
      .filter((record) => isObject(record) && record.kind === 'transition').length;
    return rawTransitions !== normalized.records.filter(isAqlTransitionRecord).length
      ? 'AQL 责任账本含有损坏或矛盾的状态转移记录'
      : 'AQL 责任账本含有损坏或矛盾记录';
  }
  if (candidate.state === 'reduced' && normalized.state !== 'reduced') {
    return 'AQL 放宽状态缺少转移得分、生产稳定或负责部门批准条件';
  }
  if (candidate.suspended === true
    && (candidate.state !== 'tightened' || !Number.isFinite(candidate.tightenedRejections)
      || candidate.tightenedRejections! < 5)) {
    return 'AQL 暂停状态与加严累计不一致';
  }
  if ((candidate.tightenedRejections ?? 0) >= 5 && candidate.suspended !== true) {
    return 'AQL 加严累计已达 5 批但未进入暂停状态';
  }
  if (candidate.suspended !== true && candidate.state !== 'tightened'
    && (candidate.tightenedRejections ?? 0) > 0) return 'AQL 非加严状态含有加严拒收累计';
  if (candidate.state === 'tightened' && (candidate.switchingScore ?? 0) > 0) return 'AQL 加严状态含有正常检验转移得分';
  if (liveLedger) {
    // CORE-06:状态级字段必须等于从记录链重放得到的状态;不一致按损坏 fail-closed(调用方保留原文)。
    const audit = auditAqlLedger(candidate);
    if (audit.status === 'mismatch') return `AQL 责任账本记录链与状态字段不一致：${audit.detail}`;
  }
  return null;
}

function aqlStateValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return 'AQL 业务状态不是有效对象';
  const allowed = new Set(['aqlLot', 'aqlLevel', 'aqlAQL', 'aqlRegime', 'aqlMethod', 'aqlAcMethod', 'aqlSwitch']);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) return `AQL 业务状态含有非白名单字段 ${extra}`;
  if (!Number.isSafeInteger(raw.aqlLot) || (raw.aqlLot as number) < 2
    || (raw.aqlLot as number) > MAX_LOT_SIZE) return 'AQL 批量超出允许范围';
  if (!['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'].includes(raw.aqlLevel as string)) {
    return 'AQL 检验水平无效';
  }
  if (typeof raw.aqlAQL !== 'number' || !AQL_COLS.includes(raw.aqlAQL)) {
    return 'AQL 值不在正式主表范围';
  }
  if (raw.aqlRegime !== undefined && raw.aqlRegime !== 'percent' && raw.aqlRegime !== 'per100') {
    return 'AQL 质量表示方式无效';
  }
  if (raw.aqlRegime !== undefined && !aqlRegimeAllows(raw.aqlRegime as AqlRegime, raw.aqlAQL)) {
    return '百分不合格品体系的 AQL 不能超过 10';
  }
  if (raw.aqlMethod !== 'gb' || raw.aqlAcMethod !== 'gb') return 'AQL 正式产品路径必须使用国标方案';
  if (!('aqlSwitch' in raw)) return 'AQL 业务状态缺少责任账本';
  return aqlSwitchValidationError(raw.aqlSwitch, true);
}

/** 批次720-B:逐列公差记忆的结构校验(偏好与分析快照共用)。 */
function gageTolByColValidationError(raw: unknown, where: string): string | null {
  if (raw === undefined) return null;
  if (!isObject(raw)) return `${where} gageTolByCol 不是对象`;
  const entries = Object.entries(raw);
  if (entries.length > 65) return `${where} gageTolByCol 超过 65 列上限`;
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${where} gageTolByCol 含空列名`;
    if (!isObject(entry)) return `${where} gageTolByCol.${key} 不是对象`;
    const mode = entry.mode;
    if (mode !== 'auto' && mode !== 'width' && mode !== 'upper' && mode !== 'lower' && mode !== 'none') {
      return `${where} gageTolByCol.${key} 公差模式无效`;
    }
    if (entry.value !== null && (typeof entry.value !== 'number' || !Number.isFinite(entry.value))) {
      return `${where} gageTolByCol.${key} 公差数值无效`;
    }
  }
  return null;
}

/**
 * 项目名长度上限(PLATFORM-06 复核):界面输入框、setProjectName 与偏好水合都截到此长度，
 * 避免超长项目名拖累侧栏渲染、偏好持久化与导出文件名。按 UTF-16 码元计(与 input maxLength 同口径)。
 */
export const MAX_PROJECT_NAME_CHARS = 120;
/**
 * 已持久化/项目文件中 projectName 的硬上限。v1.43 之前界面没有长度限制，120 字以内原样读回；
 * 121–4096 字的旧项目名按 {@link clampProjectName} 截断后接受(不因项目名整份拒绝旧 .qproj/偏好)；
 * 超过此值只可能是异常/构造载荷，按损坏拒绝。
 */
export const MAX_STORED_PROJECT_NAME_CHARS = 4096;

/** 项目名截到 {@link MAX_PROJECT_NAME_CHARS} 个 UTF-16 码元，且不留下半个代理对。 */
export function clampProjectName(name: string): string {
  if (name.length <= MAX_PROJECT_NAME_CHARS) return name;
  let cut = name.slice(0, MAX_PROJECT_NAME_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * 偏好 state 白名单。旧读取器会把白名单外字段判为“损坏”，所以这里新增键
 * 必须同步提升 FORMAT_VERSION（v5 新增 capabilityWarningAcknowledgement）。
 */
export const PREFS_STATE_KEYS: ReadonlySet<string> = new Set([
  'chartStyle', 'showGrid', 'projectName', 'lsl', 'usl', 'tgt', 'lslOn', 'uslOn', 'capabilityBins',
  'capSubgroupMode', 'capSubgroupSize', 'capValueCol', 'capSubgroupIdCol', 'capabilityWarningAcknowledgement',
  'gageUseReal', 'gageValueName', 'gagePartName', 'gageOperatorName',
  'gageGaugeName', 'gageReportBy', 'gageStudyDate', 'gageNotes',
  'gageTolMode', 'gageTolValue', 'gageStandard', 'gageBatchCols', 'gageTolByCol',
  'aqlLot', 'aqlLevel', 'aqlAQL', 'aqlRegime', 'aqlMethod', 'aqlAcMethod', 'aqlSwitch',
  'spcRules', 'spcRuleK', 'spcDataLayout', 'spcValueCol', 'spcSubgroupCol', 'spcStageCol',
  'spcSigmaMethod', 'spcShowZones',
  'doeView', 'doeTab', 'doeFactorCols', 'doeRespCol', 'doeModelTerms', 'doeIncludeCurvature',
  't1ColName', 't1Mu0', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
  'paretoView', 'paretoMergeOther', 'paretoThreshold',
]);

function prefsValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '偏好设置不是有效对象';
  const envelope = raw as { state?: unknown };
  if (!isObject(envelope.state)) {
    return '偏好设置缺少有效 state';
  }
  const state = envelope.state;
  const extraStateKey = Object.keys(state).find((key) => !PREFS_STATE_KEYS.has(key));
  if (extraStateKey) return `偏好设置含有非白名单字段 ${extraStateKey}`;
  const extraEnvelopeKey = Object.keys(raw).find((key) => key !== 'state' && key !== 'version');
  if (extraEnvelopeKey) return `偏好设置 envelope 含有非白名单字段 ${extraEnvelopeKey}`;
  if (raw.version !== undefined && (!Number.isSafeInteger(raw.version)
    || (raw.version as number) < 0 || (raw.version as number) > 3)) {
    return '偏好设置版本无效';
  }
  const enums: Array<[string, ReadonlySet<string>]> = [
    ['chartStyle', new Set(['经典', '现代', '高对比'])],
    ['capSubgroupMode', new Set(['spc', 'const', 'stacked'])],
    ['spcDataLayout', new Set(['auto', 'rows', 'stacked', 'columns', 'individuals'])],
    ['spcSigmaMethod', new Set(['pooled', 'classic'])],
    ['doeView', new Set(['main', 'interact', 'pareto', 'cube'])],
    ['doeTab', new Set(['analyze', 'create'])],
    ['paretoView', new Set(['pareto', 'fishbone'])],
    ['aqlMethod', new Set(['shift', 'gb'])],
    ['aqlAcMethod', new Set(['binom', 'gb'])],
    ['aqlRegime', new Set(['percent', 'per100'])],
    ['gageTolMode', new Set(['auto', 'width', 'upper', 'lower', 'none'])],
    ['gageStandard', new Set(['factory', 'aiag'])],
  ];
  for (const [key, allowed] of enums) {
    if (state[key] !== undefined && (typeof state[key] !== 'string' || !allowed.has(state[key]))) {
      return `偏好设置 ${key} 枚举值无效`;
    }
  }
  for (const key of ['lsl', 'usl', 'tgt'] as const) {
    if (state[key] !== undefined && (typeof state[key] !== 'number' || !Number.isFinite(state[key]))) {
      return `偏好设置 ${key} 不是有限数`;
    }
  }
  if (state.capabilityBins !== undefined
    && (!Number.isSafeInteger(state.capabilityBins) || (state.capabilityBins as number) < 5
      || (state.capabilityBins as number) > 40)) return '能力直方图分组数无效';
  if (state.capSubgroupSize !== undefined
    && (!Number.isSafeInteger(state.capSubgroupSize) || (state.capSubgroupSize as number) < 2
      || (state.capSubgroupSize as number) > 10)) return '能力子组大小无效';
  if (state.capabilityWarningAcknowledgement !== undefined
    && state.capabilityWarningAcknowledgement !== null
    && (typeof state.capabilityWarningAcknowledgement !== 'string'
      || state.capabilityWarningAcknowledgement.length > 4096)) {
    return '能力风险确认指纹无效';
  }
  if (state.t1Mu0 !== undefined && state.t1Mu0 !== null
    && (typeof state.t1Mu0 !== 'number' || !Number.isFinite(state.t1Mu0))) return '单样本检验目标值无效';
  if (state.paretoThreshold !== undefined && (typeof state.paretoThreshold !== 'number'
    || !Number.isFinite(state.paretoThreshold) || state.paretoThreshold < 0.5 || state.paretoThreshold > 1)) {
    return '帕累托合并阈值无效';
  }
  for (const key of ['doeFactorCols', 'doeModelTerms'] as const) {
    if (state[key] !== undefined && state[key] !== null && !isStringArray(state[key])) {
      return `偏好设置 ${key} 不是字符串数组`;
    }
  }
  if (state.spcRules !== undefined) {
    if (!isObject(state.spcRules) || Object.entries(state.spcRules).some(([key, value]) => !/^r[1-8]$/.test(key)
      || typeof value !== 'boolean')) return 'SPC 判异准则无效';
  }
  if (state.gageBatchCols !== undefined && state.gageBatchCols !== null && !isStringArray(state.gageBatchCols)) {
    return 'MSA 批量测量列不是字符串数组或 null';
  }
  if (Array.isArray(state.gageBatchCols)
    && (state.gageBatchCols.length > 64 || new Set(state.gageBatchCols).size !== state.gageBatchCols.length)) {
    return 'MSA 批量测量列必须去重且不超过 64 列';
  }
  {
    const detail = gageTolByColValidationError(state.gageTolByCol, '偏好设置');
    if (detail) return detail;
  }
  if (state.spcRuleK !== undefined) {
    const detail = spcRuleKValidationError(state.spcRuleK, 'SPC 判异参数');
    if (detail) return detail;
  }
  for (const key of ['showGrid', 'lslOn', 'uslOn', 'gageUseReal', 'doeIncludeCurvature', 'paretoMergeOther', 'spcShowZones'] as const) {
    if (state[key] !== undefined && typeof state[key] !== 'boolean') return `偏好设置 ${key} 不是布尔值`;
  }
  for (const key of [
    'projectName', 'capValueCol', 'capSubgroupIdCol',
    'gageValueName', 'gagePartName', 'gageOperatorName', 'spcValueCol', 'spcSubgroupCol',
    'spcStageCol', 'doeRespCol', 't1ColName', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
  ] as const) {
    if (state[key] !== undefined && state[key] !== null && typeof state[key] !== 'string') {
      return `偏好设置 ${key} 类型无效`;
    }
  }
  if (typeof state.projectName === 'string' && state.projectName.length > MAX_STORED_PROJECT_NAME_CHARS) {
    return `偏好设置 projectName 过长（${state.projectName.length.toLocaleString()} 字符，上限 ${MAX_STORED_PROJECT_NAME_CHARS.toLocaleString()}）`;
  }
  for (const [key, maxLength] of [
    ['gageGaugeName', 80], ['gageReportBy', 80], ['gageNotes', 200],
  ] as const) {
    if (state[key] !== undefined && (typeof state[key] !== 'string' || state[key].length > maxLength)) {
      return `偏好设置 ${key} 类型无效或过长`;
    }
  }
  if (state.gageStudyDate !== undefined && (typeof state.gageStudyDate !== 'string'
    || (state.gageStudyDate !== '' && !isIsoCalendarDate(state.gageStudyDate)))) {
    return '偏好设置 gageStudyDate 日期无效（须为真实存在的 YYYY-MM-DD）';
  }
  if ('aqlLot' in state && (!Number.isSafeInteger(state.aqlLot)
    || (state.aqlLot as number) < 2 || (state.aqlLot as number) > MAX_LOT_SIZE)) {
    return 'AQL 批量超出允许范围';
  }
  if ('aqlLevel' in state && !['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'].includes(state.aqlLevel as string)) {
    return 'AQL 检验水平无效';
  }
  if (state.gageTolValue !== undefined && state.gageTolValue !== null
    && (typeof state.gageTolValue !== 'number' || !Number.isFinite(state.gageTolValue))) {
    return 'MSA 过程公差数值无效';
  }
  if ('aqlAQL' in state && (typeof state.aqlAQL !== 'number' || !AQL_COLS.includes(state.aqlAQL))) {
    return 'AQL 值不在正式主表范围';
  }
  if (state.aqlRegime !== undefined && typeof state.aqlAQL === 'number'
    && !aqlRegimeAllows(state.aqlRegime as AqlRegime, state.aqlAQL)) {
    return '百分不合格品体系的 AQL 不能超过 10';
  }
  if (!('aqlSwitch' in state)) return null;
  return aqlSwitchValidationError(state.aqlSwitch, true);
}

function recentsValidationError(raw: unknown): string | null {
  if (!Array.isArray(raw)) return '最近数据集顶层不是数组';
  if (raw.length > MAX_RECENT_DATASETS) {
    return `最近数据集条目数 ${raw.length.toLocaleString()} 超过 ${MAX_RECENT_DATASETS} 条上限`;
  }
  const names = new Set<string>();
  for (const recent of raw) {
    if (!isObject(recent) || typeof recent.name !== 'string' || !recent.name.trim()
      || typeof recent.savedAt !== 'string' || !recent.savedAt.trim()) {
      return '最近数据集条目缺少有效 name/savedAt';
    }
    const name = recent.name.trim();
    if (recent.name.length > MAX_DATASET_NAME_CHARS) {
      return `最近数据集名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`;
    }
    if (recent.savedAt.length > MAX_SAVED_AT_CHARS) {
      return `最近数据集「${name}」的 savedAt 超过 ${MAX_SAVED_AT_CHARS} 字符上限`;
    }
    if (names.has(name)) return `最近数据集名称重复：${name}`;
    names.add(name);
    if (recent.data !== undefined) {
      const detail = worksheetValidationError(recent.data, true);
      if (detail) return `最近数据集「${recent.name}」损坏：${detail}`;
      if ((recent.data as JsonObject).name !== recent.name) return `最近数据集「${recent.name}」名称与内嵌数据不一致`;
    }
  }
  return null;
}

function snapshotValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '分析 snapshot 不是对象';
  if (raw.snapshotVersion !== undefined
    && (!Number.isSafeInteger(raw.snapshotVersion) || ![2, 3, 4, 5, 6, 7].includes(raw.snapshotVersion as number))) {
    return '分析 snapshotVersion 无效';
  }
  const enums: Array<[string, ReadonlySet<string>]> = [
    ['spcType', new Set(['xbar-r', 'xbar-s', 'i-mr', 'ewma', 'cusum', 'p', 'c'])],
    ['spcDataLayout', new Set(['auto', 'rows', 'stacked', 'columns', 'individuals'])],
    ['spcSigmaMethod', new Set(['pooled', 'classic'])],
    ['aqlLevel', new Set(['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'])],
    ['aqlMethod', new Set(['shift', 'gb'])],
    ['aqlAcMethod', new Set(['binom', 'gb'])],
    ['aqlRegime', new Set(['percent', 'per100'])],
    ['gageTolMode', new Set(['auto', 'width', 'upper', 'lower', 'none'])],
    ['gageStandard', new Set(['factory', 'aiag'])],
    ['doeView', new Set(['main', 'interact', 'pareto', 'cube'])],
    ['doeTab', new Set(['analyze', 'create'])],
    ['hypoTab', new Set(['anova', 't1', 't2', 'reg'])],
    ['paretoView', new Set(['pareto', 'fishbone'])],
    ['anovaMode', new Set(['stacked', 'wide', 'numfactor'])],
    ['capSubgroupMode', new Set(['spc', 'const', 'stacked'])],
  ];
  for (const [key, allowed] of enums) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !allowed.has(raw[key]))) {
      return `分析 snapshot.${key} 枚举值无效`;
    }
  }
  for (const key of ['lsl', 'usl', 'tgt', 'capabilityBins', 'aqlLot', 'aqlAQL', 'paretoThreshold'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) {
      return `分析 snapshot.${key} 不是有限数`;
    }
  }
  if (raw.capabilityBins !== undefined && (!Number.isSafeInteger(raw.capabilityBins)
    || (raw.capabilityBins as number) < 5 || (raw.capabilityBins as number) > 40)) {
    return '分析 snapshot.capabilityBins 无效';
  }
  if (raw.capSubgroupSize !== undefined && (!Number.isSafeInteger(raw.capSubgroupSize)
    || (raw.capSubgroupSize as number) < 2 || (raw.capSubgroupSize as number) > 10)) {
    return '分析 snapshot.capSubgroupSize 无效';
  }
  if (raw.capabilityWarningAcknowledgement !== undefined
    && raw.capabilityWarningAcknowledgement !== null
    && (typeof raw.capabilityWarningAcknowledgement !== 'string'
      || raw.capabilityWarningAcknowledgement.length > 4096)) {
    return '分析 snapshot.capabilityWarningAcknowledgement 无效';
  }
  if (raw.aqlLot !== undefined && (!Number.isSafeInteger(raw.aqlLot)
    || (raw.aqlLot as number) < 2 || (raw.aqlLot as number) > MAX_LOT_SIZE)) return '分析 AQL 批量无效';
  if (raw.aqlAQL !== undefined && (typeof raw.aqlAQL !== 'number' || !AQL_COLS.includes(raw.aqlAQL))) {
    return '分析 AQL 值不在正式主表范围';
  }
  if (raw.gageTolValue !== undefined && raw.gageTolValue !== null
    && (typeof raw.gageTolValue !== 'number' || !Number.isFinite(raw.gageTolValue))) {
    return '分析 MSA 过程公差数值无效';
  }
  if (raw.aqlRegime !== undefined && typeof raw.aqlAQL === 'number'
    && !aqlRegimeAllows(raw.aqlRegime as AqlRegime, raw.aqlAQL)) {
    return '分析百分不合格品体系的 AQL 不能超过 10';
  }
  if (raw.paretoThreshold !== undefined && ((raw.paretoThreshold as number) < 0.5
    || (raw.paretoThreshold as number) > 1)) return '分析帕累托阈值无效';
  if (raw.t1Mu0 !== undefined && raw.t1Mu0 !== null
    && (typeof raw.t1Mu0 !== 'number' || !Number.isFinite(raw.t1Mu0))) {
    return '分析 snapshot.t1Mu0 不是有限数或 null';
  }
  for (const key of ['doeFactorCols', 'doeModelTerms'] as const) {
    if (raw[key] !== undefined && raw[key] !== null && !isStringArray(raw[key])) {
      return `分析 snapshot.${key} 不是字符串数组或 null`;
    }
  }
  if (raw.gageBatchCols !== undefined && raw.gageBatchCols !== null && !isStringArray(raw.gageBatchCols)) {
    return '分析 snapshot.gageBatchCols 不是字符串数组或 null';
  }
  if (Array.isArray(raw.gageBatchCols)
    && (raw.gageBatchCols.length > 64 || new Set(raw.gageBatchCols).size !== raw.gageBatchCols.length)) {
    return '分析 snapshot.gageBatchCols 必须去重且不超过 64 列';
  }
  {
    const detail = gageTolByColValidationError(raw.gageTolByCol, '分析 snapshot');
    if (detail) return detail;
  }
  for (const key of [
    'lslOn', 'uslOn', 'gageUseReal', 'gageRequestedReal', 'gageSourceReal', 'doeIncludeCurvature', 'spcShowZones',
    'anovaShowDemo', 'paretoMergeOther', 'paretoShowDemo', 'fishboneIsDemo',
  ] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return `分析 snapshot.${key} 不是布尔值`;
  }
  for (const key of [
    'spcStageCol', 'spcValueCol', 'spcSubgroupCol', 'capValueCol', 'capSubgroupIdCol', 'gageValueName', 'gagePartName', 'gageOperatorName',
    'doeRespCol', 'anovaRespName', 'anovaFactorName', 't1ColName', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
  ] as const) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') {
      return `分析 snapshot.${key} 类型无效`;
    }
  }
  for (const [key, maxLength] of [
    ['gageGaugeName', 80], ['gageReportBy', 80], ['gageNotes', 200],
  ] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || (raw[key] as string).length > maxLength)) {
      return `分析 snapshot.${key} 类型无效或过长`;
    }
  }
  if (raw.gageStudyDate !== undefined && (typeof raw.gageStudyDate !== 'string'
    || (raw.gageStudyDate !== '' && !isIsoCalendarDate(raw.gageStudyDate)))) {
    return '分析 snapshot.gageStudyDate 日期无效（须为真实存在的 YYYY-MM-DD）';
  }
  for (const key of ['spcResolvedLayout', 'spcResolvedVariableName', 'spcResolvedRoleNote', 'activeVar'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') return `分析 snapshot.${key} 不是字符串`;
  }
  if (raw.spcRules !== undefined
    && (!isObject(raw.spcRules) || Object.entries(raw.spcRules).some(([key, value]) => !/^r[1-8]$/.test(key)
      || typeof value !== 'boolean'))) return '分析 snapshot.spcRules 无效';
  if (raw.spcRuleK !== undefined) {
    const detail = spcRuleKValidationError(raw.spcRuleK, '分析 snapshot.spcRuleK ');
    if (detail) return detail;
  }
  if (raw.sourceData !== undefined && raw.sourceDataKey !== undefined) {
    return '分析 snapshot 不能同时包含 sourceData 与 sourceDataKey';
  }
  if (raw.sourceData !== undefined) {
    const detail = worksheetValidationError(raw.sourceData, false);
    if (detail) return `分析内嵌工作表损坏：${detail}`;
  }
  if (raw.sourceDataKey !== undefined && (typeof raw.sourceDataKey !== 'string' || !raw.sourceDataKey.trim())) {
    return '分析 sourceDataKey 无效';
  }
  if (typeof raw.sourceDataKey === 'string' && raw.sourceDataKey.length > MAX_ANALYSIS_DATA_KEY_CHARS) {
    return `分析 sourceDataKey 超过 ${MAX_ANALYSIS_DATA_KEY_CHARS} 字符上限`;
  }
  // 快照缺失标记（fix2609 M4）：导出侧把悬空卡降级为此形态，读取侧必须同口径接受（写读对称）。
  if (raw.sourceMissing !== undefined) {
    if (raw.sourceMissing !== true) return '分析 snapshot.sourceMissing 只能为 true';
    if (raw.sourceData !== undefined || raw.sourceDataKey !== undefined) {
      return '分析 snapshot 标记为快照缺失（sourceMissing）时不能同时包含 sourceData 或 sourceDataKey';
    }
  }
  if (raw.pChartData !== undefined) {
    const detail = pChartValidationError(raw.pChartData);
    if (detail) return `分析 P 图快照损坏：${detail}`;
  }
  if (raw.cChartData !== undefined) {
    const detail = cChartValidationError(raw.cChartData);
    if (detail) return `分析 C 图快照损坏：${detail}`;
  }
  if (raw.paretoData !== undefined) {
    const detail = paretoValidationError(raw.paretoData);
    if (detail) return `分析帕累托快照损坏：${detail}`;
  }
  if (raw.fishboneData !== undefined) {
    const detail = fishboneDataValidationError(raw.fishboneData);
    if (detail) return `分析鱼骨快照损坏：${detail}`;
  }
  if (raw.aqlSwitch !== undefined) {
    const detail = aqlSwitchValidationError(raw.aqlSwitch);
    if (detail) return detail;
  }
  return null;
}

// snapshotVersion=5 是首个保存 P/C 计数载荷的分析快照版本。更早/无版本
// 记录可以继续被读取，但 restore 会因无法精确重建而 fail-closed。
const ATTRIBUTE_PAYLOAD_SNAPSHOT_VERSION = 5;

/**
 * SPC 属性图是 kind + spcType + payload 的联合约束，不能把三种载荷当作
 * 独立可选字段。本闸门只查字段存在性，应在计数/工作表数组遍历前执行。
 */
export function spcPayloadContractError(kind: unknown, raw: unknown): string | null {
  if (!isObject(raw)) return null; // 顶层结构由 snapshotValidationError 给出更精确文案
  const hasP = raw.pChartData !== undefined;
  const hasC = raw.cChartData !== undefined;
  const hasSourceData = raw.sourceData !== undefined;
  const hasSourceDataKey = raw.sourceDataKey !== undefined;

  if (kind !== 'spc') {
    return hasP || hasC ? '非 SPC 分析不能携带 P/C 图载荷' : null;
  }

  if (raw.spcType === 'p') {
    if (hasC || hasSourceData || hasSourceDataKey) {
      return 'SPC P 图快照只能携带 pChartData，不能携带 cChartData/sourceData/sourceDataKey';
    }
    if (!hasP && typeof raw.snapshotVersion === 'number'
      && raw.snapshotVersion >= ATTRIBUTE_PAYLOAD_SNAPSHOT_VERSION) {
      return '现代 SPC P 图快照缺少匹配的 pChartData';
    }
    return null;
  }

  if (raw.spcType === 'c') {
    if (hasP || hasSourceData || hasSourceDataKey) {
      return 'SPC C 图快照只能携带 cChartData，不能携带 pChartData/sourceData/sourceDataKey';
    }
    if (!hasC && typeof raw.snapshotVersion === 'number'
      && raw.snapshotVersion >= ATTRIBUTE_PAYLOAD_SNAPSHOT_VERSION) {
      return '现代 SPC C 图快照缺少匹配的 cChartData';
    }
    return null;
  }

  return hasP || hasC ? '非 P/C 的 SPC 快照不能携带 pChartData/cChartData' : null;
}

function analysesValidationError(raw: unknown): string | null {
  if (!Array.isArray(raw)) return '分析历史顶层不是数组';
  if (raw.length > MAX_SAVED_ANALYSES) {
    return `分析历史超过 ${MAX_SAVED_ANALYSES} 条上限`;
  }
  const kinds = new Set(['spc', 'capability', 'gagerr', 'anova', 'pareto', 'doe', 'aql', 'summary']);
  const ids = new Set<string>();
  for (const analysis of raw) {
    if (!isObject(analysis)) return '分析历史条目不是对象';
    for (const key of ['id', 'title', 'datasetName', 'metric', 'status', 'statusColor', 'statusBg'] as const) {
      if (typeof analysis[key] !== 'string') return `分析历史 ${key} 不是字符串`;
    }
    const id = analysis.id as string;
    if (!id.trim() || id.length > MAX_ANALYSIS_ID_CHARS) {
      return `分析历史 id 必须非空且不超过 ${MAX_ANALYSIS_ID_CHARS} 字符`;
    }
    if (ids.has(id)) return `分析历史含有重复 id「${id}」`;
    ids.add(id);
    if ((analysis.datasetName as string).length > MAX_DATASET_NAME_CHARS) {
      return `分析历史 datasetName 超过 ${MAX_DATASET_NAME_CHARS} 字符上限`;
    }
    for (const key of ['title', 'metric', 'status'] as const) {
      if ((analysis[key] as string).length > MAX_ANALYSIS_LABEL_CHARS) {
        return `分析历史 ${key} 超过 ${MAX_ANALYSIS_LABEL_CHARS} 字符上限`;
      }
    }
    // P1-3:颜色字段会拼进导出 HTML 的 style 属性,必须是严格 hex,阻断事件属性注入。
    for (const key of ['statusColor', 'statusBg'] as const) {
      if (!/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(analysis[key] as string)) {
        return `分析历史 ${key} 不是合法十六进制颜色`;
      }
    }
    if (typeof analysis.kind !== 'string' || !kinds.has(analysis.kind)) return '分析历史 kind 无效';
    if (typeof analysis.createdAt !== 'number' || !Number.isFinite(analysis.createdAt)) return '分析历史 createdAt 无效';
    // 联合契约只查存在性，先于 payload/source 的数组遍历；双载荷和异类
    // 载荷因此不会再被“truthy 优先级”解读成某一张图。
    const contractDetail = spcPayloadContractError(analysis.kind, analysis.snapshot);
    if (contractDetail) return contractDetail;
    const detail = snapshotValidationError(analysis.snapshot);
    if (detail) return detail;
  }
  return null;
}

/** 与 analyses.ts 的恢复路由保持同一语义，但不反向加载业务 store。 */
function analysisUsesWorksheetSnapshot(analysis: JsonObject, snapshot: JsonObject): boolean {
  if (analysis.kind === 'spc') {
    return snapshot.spcType !== 'p' && snapshot.spcType !== 'c'
      && snapshot.pChartData === undefined && snapshot.cChartData === undefined;
  }
  if (analysis.kind === 'gagerr') {
    return snapshot.gageRequestedReal === true || snapshot.gageSourceReal === true;
  }
  return analysis.kind === 'capability' || analysis.kind === 'anova'
    || analysis.kind === 'doe' || analysis.kind === 'summary';
}

/**
 * v4+ 工作表快照已承诺精确回放，因此必须恰有一个来源。无 snapshotVersion 的旧
 * SPC/能力/真实 MSA 仍可通过同名 recent 回看。
 * ANOVA/DOE/摘要自带 snapshotVersion 的写出侧（v1.32 起，snapshotVersion≥5）总会附带来源，
 * 因此带版本号却缺来源才是损坏；无 snapshotVersion 的 v1.29/v1.30 旧卡片从未保存来源，
 * store 启动照常接受，回看时由恢复器 fail-closed 提示“数据快照缺失”。这类卡片必须
 * 可随项目导出/导入，否则一张旧卡就会阻断整份备份与恢复（fix2609 PLATFORM-04）。
 * 快照库被隔离/替换后悬空的卡片由导出侧降级为 snapshot.sourceMissing=true（去掉 sourceDataKey），
 * 与上述旧卡同口径：读取侧放行、回看 fail-closed（fix2609 M4）。
 */
function analysisRequiresExactWorksheetSource(analysis: JsonObject, snapshot: JsonObject): boolean {
  if (!analysisUsesWorksheetSnapshot(analysis, snapshot)) return false;
  if (analysis.kind === 'anova' || analysis.kind === 'doe' || analysis.kind === 'summary') {
    return typeof snapshot.snapshotVersion === 'number';
  }
  return typeof snapshot.snapshotVersion === 'number' && snapshot.snapshotVersion >= 4;
}

/** 错误文案给出用户在“已保存分析”里能看到的标题与保存时间，而不只是内部 id。 */
function analysisLabel(analysis: JsonObject): string {
  const when = typeof analysis.createdAt === 'number' && Number.isFinite(new Date(analysis.createdAt).getTime())
    ? `，保存于 ${timestampTextOf(analysis.createdAt)}`
    : '';
  return `「${String(analysis.title)}」（数据集 ${String(analysis.datasetName)}${when}，id ${String(analysis.id)}）`;
}

function analysisDataValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '分析数据仓库顶层不是对象';
  const entries = Object.entries(raw);
  if (entries.length > MAX_ANALYSIS_DATA_ENTRIES) {
    return `分析数据仓库超过 ${MAX_ANALYSIS_DATA_ENTRIES} 个工作表上限`;
  }
  for (const [key, source] of entries) {
    if (!key.trim()) return '分析数据仓库含空键';
    if (key.length > MAX_ANALYSIS_DATA_KEY_CHARS) {
      return `分析数据仓库 key 超过 ${MAX_ANALYSIS_DATA_KEY_CHARS} 字符上限`;
    }
    const detail = worksheetValidationError(source, false);
    if (detail) return `分析数据「${key}」损坏：${detail}`;
  }
  return null;
}

function quarantineValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '损坏数据隔离区不是有效对象';
  if (Object.keys(raw).length > PROJECT_KEYS.length) return '损坏数据隔离区条目过多';
  for (const [key, entry] of Object.entries(raw)) {
    if (!PROJECT_KEY_SET.has(key) || key === 'qp-quarantine-v1' || !isObject(entry)
      || typeof entry.raw !== 'string' || typeof entry.detail !== 'string' || !entry.detail.trim()
      || typeof entry.detectedAt !== 'string' || !entry.detectedAt.trim()) {
      return '损坏数据隔离区条目结构无效';
    }
  }
  return null;
}

/** 各持久化 store 的共享运行时结构校验；项目导入与 store 启动恢复使用同一口径。 */
export function projectStoreValidationError(key: string, raw: unknown): string | null {
  switch (key) {
    case 'qp-dataset-v1': return worksheetValidationError(raw, true);
    case 'qp-recents-v1': return recentsValidationError(raw);
    case 'qp-attr-v1': return attrValidationError(raw);
    case 'qp-specs-v1': return specsValidationError(raw);
    case 'qp-fishbone-v1': return fishboneValidationError(raw);
    case 'qp-analyses-v1': return analysesValidationError(raw);
    case 'qp-analysis-data-v1': return analysisDataValidationError(raw);
    case 'qp-pareto-v1': return paretoValidationError(raw);
    case 'qp-quarantine-v1': return quarantineValidationError(raw);
    case 'qp-copy-sequences-v1': {
      if (!isObject(raw)) return '副本名称记录必须为对象';
      for (const [name, sequence] of Object.entries(raw)) {
        if (!name.trim() || !Number.isSafeInteger(sequence) || (sequence as number) < 1) {
          return '副本名称记录必须由非空源名称和正整数序号组成';
        }
      }
      return null;
    }
    case 'qp-prefs-v1': return prefsValidationError(raw);
    case 'qp-aql-state-v1': return aqlStateValidationError(raw);
    default: return null;
  }
}

/** 分析数据仓库里真正被分析卡片 snapshot.sourceDataKey 引用的键。 */
function referencedAnalysisDataKeys(analyses: unknown): Set<string> {
  const referenced = new Set<string>();
  if (!Array.isArray(analyses)) return referenced;
  for (const analysis of analyses) {
    if (!isObject(analysis) || !isObject(analysis.snapshot)) continue;
    const key = analysis.snapshot.sourceDataKey;
    if (typeof key === 'string') referenced.add(key);
  }
  return referenced;
}

/**
 * 引用了 snapshot.sourceDataKey、但该键不在 analysisData 中的卡片；analysisData 缺失/不可用时
 * 即全部引用卡片。用于导出失败文案指认用户在「已保存分析」里能看到的记录。
 */
function analysesReferencingMissingData(analyses: unknown, analysisData: unknown): JsonObject[] {
  if (!Array.isArray(analyses)) return [];
  return analyses.filter((analysis): analysis is JsonObject => {
    if (!isObject(analysis) || !isObject(analysis.snapshot)) return false;
    const key = analysis.snapshot.sourceDataKey;
    return typeof key === 'string'
      && !(isObject(analysisData) && Object.prototype.hasOwnProperty.call(analysisData, key));
  });
}

/** 导出失败文案里至多列出 3 张卡片，超出以“等”收尾（总数由调用方单独给出）。 */
function analysisLabelList(analyses: JsonObject[]): string {
  const shown = analyses.slice(0, 3).map(analysisLabel).join('、');
  return analyses.length > 3 ? `${shown}等` : shown;
}

/** 供 store 侧导出钩子复用同一卡片标签口径（标题/数据集/保存时间/id，至多 3 条）。 */
export function analysisLabelListText(analyses: ReadonlyArray<object>): string {
  return analysisLabelList(analyses.filter(isObject) as JsonObject[]);
}

/** 一键删除入口的文案；侧栏按钮与导出提示共用，避免两处说法漂移。 */
export const REMOVE_SNAPSHOT_MISSING_LABEL = '删除全部快照缺失记录';

/**
 * 导出侧把悬空卡片降级为「快照缺失」形态：去掉 sourceDataKey、加 sourceMissing:true。
 * 与 PLATFORM-04 旧卡同口径（读取侧放行、回看 fail-closed），悬空旧卡不再阻断整份备份；
 * 只改导出件，本机 live 记录不动（fix2609 M4）。
 */
function markAnalysesSnapshotMissing(analyses: unknown[], dangling: ReadonlySet<JsonObject>): unknown[] {
  return analyses.map((analysis) => {
    if (!isObject(analysis) || !dangling.has(analysis) || !isObject(analysis.snapshot)) return analysis;
    const snapshot: JsonObject = { ...analysis.snapshot, sourceMissing: true };
    delete snapshot.sourceDataKey;
    return { ...analysis, snapshot };
  });
}

/**
 * 孤儿分析数据是残留而非损坏（卡片被删/启动归一化丢弃后尽力而为的 prune 可能失败），
 * 没有任何入口能再读到它。导出前与旧版文件导入时共用本原语丢弃残留（fix2609 GAP-4-12）。
 * 返回 null 表示没有孤儿；kept 为空对象时调用方应整键省略。
 */
function pruneUnreferencedAnalysisData(
  analyses: unknown,
  analysisData: unknown,
): { kept: JsonObject; dropped: string[] } | null {
  if (!isObject(analysisData)) return null;
  const referenced = referencedAnalysisDataKeys(analyses);
  const dropped = Object.keys(analysisData).filter((key) => !referenced.has(key));
  if (dropped.length === 0) return null;
  const kept = Object.fromEntries(Object.entries(analysisData).filter(([key]) => referenced.has(key)));
  return { kept, dropped };
}

/**
 * 旧版（formatVersion < 5）项目的跨键残留迁移。v1.43 之前的写出侧从不保证这两条不变量：
 * - v1.29/v1.30 撤销/重做只写活动表、Web 端最近列表写盘失败被静默放弃，
 *   会让同名最近条目的内嵌副本落后于活动表；
 * - 分析数据仓库的 prune 是尽力而为，可能留下没有卡片引用的残留条目。
 * 与 dataStore 启动时 coordinateRecentsWithActive 同一口径：活动表是用户最后看到并写入的
 * 版本，最近条目只能跟随；残留分析数据直接丢弃。直接就地修复 parsedStores，返回改动的键。
 * v5 起写出侧自校验保证这两条不变量，因此 v5 文件仍按原规则严格拒绝（疑似篡改/回退）。
 */
function migrateLegacyCrossKeyResidue(
  formatVersion: number,
  parsedStores: Map<string, unknown>,
  vaultEntries: ReadonlyArray<[string, string]>,
  activeRef: string | undefined,
): { changed: Set<string>; notes: string[] } {
  const changed = new Set<string>();
  const notes: string[] = [];
  const prefix = `旧版项目（格式 v${formatVersion}）`;
  const recents = parsedStores.get('qp-recents-v1');
  if (Array.isArray(recents)) {
    const storedActive = parsedStores.get('qp-dataset-v1');
    const actives: JsonObject[] = [];
    if (isObject(storedActive)) actives.push(storedActive);
    if (activeRef !== undefined && !(isObject(storedActive) && storedActive.name === activeRef)) {
      const entry = vaultEntries.find(([name]) => name === activeRef);
      // localStorage 与 vault 同名活动表互相不一致时不在此裁决，交给下方严格校验拒绝。
      if (entry) actives.push(JSON.parse(entry[1]) as JsonObject);
    }
    let next: unknown[] = recents;
    for (const active of actives) {
      const index = next.findIndex((entry) => isObject(entry) && entry.name === active.name);
      if (index < 0) continue;
      const recent = next[index];
      if (!isObject(recent) || recent.data === undefined || sameWorksheetVersion(active, recent.data)) continue;
      if (next === recents) next = [...recents];
      next[index] = { name: recent.name, savedAt: active.savedAt, data: active };
      notes.push(`${prefix}最近列表中「${String(active.name)}」的内嵌副本与活动数据集不一致（旧版撤销/写盘失败残留），已按活动数据集更新`);
    }
    if (next !== recents) {
      parsedStores.set('qp-recents-v1', next);
      changed.add('qp-recents-v1');
    }
  }
  const pruned = pruneUnreferencedAnalysisData(
    parsedStores.get('qp-analyses-v1'),
    parsedStores.get('qp-analysis-data-v1'),
  );
  if (pruned) {
    if (Object.keys(pruned.kept).length > 0) parsedStores.set('qp-analysis-data-v1', pruned.kept);
    else parsedStores.delete('qp-analysis-data-v1');
    changed.add('qp-analysis-data-v1');
    notes.push(`${prefix}含 ${pruned.dropped.length} 条没有分析卡片引用的残留分析数据，已丢弃（不影响任何已保存分析）`);
  }
  return { changed, notes };
}

type ValidatedProjectFile =
  | { file: ProjectFile; error: null; notes: string[] }
  | { file: null; error: string };

function validateProjectFile(text: string): ValidatedProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '')); // 去 BOM（导出文本统一带 BOM）
  } catch {
    return { file: null, error: '不是有效的项目文件（JSON 解析失败）' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { file: null, error: '不是质量分析平台的项目文件' };
  }
  const file = raw as ProjectFile;
  if (file.format !== FORMAT) return { file: null, error: '不是质量分析平台的项目文件' };
  if (!Number.isSafeInteger(file.formatVersion) || file.formatVersion < 1) {
    return { file: null, error: `项目文件版本 ${file.formatVersion} 无效` };
  }
  if (file.formatVersion > FORMAT_VERSION) {
    return {
      file: null,
      error: `项目文件版本 ${file.formatVersion} 高于当前应用支持的 ${FORMAT_VERSION},请升级应用`,
    };
  }
  if (file.vaultRevision !== undefined
    && (!Number.isSafeInteger(file.vaultRevision) || file.vaultRevision < 0)) {
    return { file: null, error: '项目文件的 vault revision 无效' };
  }
  if (!file.stores || typeof file.stores !== 'object' || Array.isArray(file.stores)) {
    return { file: null, error: '项目文件缺少有效 stores 数据' };
  }

  let knownStoreCount = 0;
  let activeRef: string | undefined;
  const parsedStores = new Map<string, unknown>();
  // active-ref 是裸数据集名；其余已知 store 必须是合法 JSON 并通过各自运行时结构校验。
  for (const [k, v] of Object.entries(file.stores)) {
    if (!PROJECT_KEY_SET.has(k)) continue; // 未知键不导入，但也不能让未知键冒充有效项目内容
    knownStoreCount++;
    if (typeof v !== 'string') return { file: null, error: `项目数据「${k}」损坏` };
    if (k === 'qp-active-ref-v1') {
      if (!v.trim()) return { file: null, error: '项目活动数据集引用为空' };
      activeRef = v;
      continue;
    }
    try {
      const parsed = JSON.parse(v);
      const detail = projectStoreValidationError(k, parsed);
      if (detail) return { file: null, error: `项目数据「${k}」损坏：${detail}` };
      parsedStores.set(k, parsed);
    } catch {
      return { file: null, error: `项目数据「${k}」损坏` };
    }
  }
  const vault = validateVault(file.vault);
  if (vault.error) return { file: null, error: vault.error };
  if (knownStoreCount === 0 && vault.entries.length === 0) {
    return { file: null, error: '项目文件没有可识别的 stores 数据，已拒绝空项目替换' };
  }
  // 跨键不变量的格式版本门：v5 起由写出侧保证并严格校验；更早的历史文件先迁移降级，
  // 迁移结果仍要通过下方同一组严格校验（不是删掉校验）。
  const notes: string[] = [];
  let stores = file.stores;
  if (file.formatVersion < CROSS_KEY_INVARIANT_FORMAT_VERSION) {
    const migrated = migrateLegacyCrossKeyResidue(file.formatVersion, parsedStores, vault.entries, activeRef);
    if (migrated.changed.size > 0) {
      stores = { ...file.stores };
      for (const key of migrated.changed) {
        if (!parsedStores.has(key)) {
          delete stores[key];
          continue;
        }
        const value = parsedStores.get(key);
        const detail = projectStoreValidationError(key, value);
        if (detail) return { file: null, error: `项目数据「${key}」迁移后仍无效：${detail}` };
        stores[key] = JSON.stringify(value);
      }
      if (!PROJECT_KEYS.some((key) => typeof stores[key] === 'string') && vault.entries.length === 0) {
        return { file: null, error: '项目文件没有可识别的 stores 数据，已拒绝空项目替换' };
      }
    }
    notes.push(...migrated.notes);
  }
  const recents = parsedStores.get('qp-recents-v1');
  const ensureActiveRecentAgreement = (active: unknown, label: string): string | null => {
    if (!isObject(active) || !Array.isArray(recents) || typeof active.name !== 'string') return null;
    const recent = recents.find((entry) => isObject(entry) && entry.name === active.name);
    if (!isObject(recent) || recent.data === undefined) return null;
    return sameWorksheetVersion(active, recent.data)
      ? null
      : `${label}「${active.name}」与同名最近数据集内容不一致，项目可能回退旧矩阵`;
  };
  const storedActive = parsedStores.get('qp-dataset-v1');
  const storedRecentError = ensureActiveRecentAgreement(storedActive, '项目活动数据集');
  if (storedRecentError) return { file: null, error: storedRecentError };
  if (activeRef !== undefined) {
    const activeVaultEntry = vault.entries.find(([name]) => name === activeRef);
    if (activeVaultEntry) {
      const vaultActive = JSON.parse(activeVaultEntry[1]) as unknown;
      const vaultRecentError = ensureActiveRecentAgreement(vaultActive, '项目 SQLite 活动数据集');
      if (vaultRecentError) return { file: null, error: vaultRecentError };
      if (isObject(storedActive) && storedActive.name === activeRef
        && !sameWorksheetVersion(storedActive, vaultActive)) {
        return {
          file: null,
          error: `项目活动数据集「${activeRef}」在 localStorage 与 vault 中版本不一致`,
        };
      }
    }
  }
  const analyses = parsedStores.get('qp-analyses-v1');
  const analysisData = parsedStores.get('qp-analysis-data-v1');
  const referencedAnalysisData = new Set<string>();
  if (Array.isArray(analyses)) {
    for (const analysis of analyses as JsonObject[]) {
      const snapshot = analysis.snapshot as JsonObject;
      if (analysisRequiresExactWorksheetSource(analysis, snapshot)
        && snapshot.sourceData === undefined && snapshot.sourceDataKey === undefined
        && snapshot.sourceMissing !== true) {
        return {
          file: null,
          error: `分析历史${analysisLabel(analysis)}是工作表型分析，但没有 sourceData 或 sourceDataKey`,
        };
      }
      if (isObject(snapshot.sourceData)
        && (snapshot.sourceData as JsonObject).name !== analysis.datasetName) {
        return {
          file: null,
          error: `分析历史${analysisLabel(analysis)}的 datasetName 与内嵌工作表 name 不一致`,
        };
      }
      if (typeof snapshot.sourceDataKey === 'string') referencedAnalysisData.add(snapshot.sourceDataKey);
      if (typeof snapshot.sourceDataKey === 'string'
        && (!isObject(analysisData) || !Object.prototype.hasOwnProperty.call(analysisData, snapshot.sourceDataKey))) {
        return {
          file: null,
          // 本机导出由 buildProjectJson 的悬空引用预检先行拦截并给出删除指引；走到这里的是
          // 外来/被改动的项目文件，指引对象是导出该文件的一端。
          error: `分析历史${analysisLabel(analysis)}引用的数据「${snapshot.sourceDataKey}」未包含在项目文件中；`
            + '项目文件不完整，请在导出端左侧「已保存分析」中删除该记录后重新导出',
        };
      }
      if (typeof snapshot.sourceDataKey === 'string' && isObject(analysisData)) {
        const source = analysisData[snapshot.sourceDataKey];
        if (isObject(source) && source.name !== analysis.datasetName) {
          return {
            file: null,
            error: `分析历史${analysisLabel(analysis)}的 datasetName 与引用工作表 name 不一致`,
          };
        }
      }
    }
  }
  if (isObject(analysisData)) {
    const orphan = Object.keys(analysisData).find((key) => !referencedAnalysisData.has(key));
    if (orphan) {
      // 写出侧导出前已裁掉孤儿，v5 文件带孤儿只可能是手工修改/篡改；没有对应卡片可指认，保留内部键。
      return {
        file: null,
        error: `分析数据「${orphan}」没有对应的分析历史引用：项目文件含有未被任何已保存分析引用的分析数据，`
          + '文件可能被手工修改，请使用应用重新导出',
      };
    }
  }
  if (activeRef !== undefined && !vault.entries.some(([name]) => name === activeRef)) {
    return { file: null, error: `项目活动数据集引用「${activeRef}」在 vault 中没有对应数据集` };
  }
  return { file: stores === file.stores ? file : { ...file, stores }, error: null, notes };
}

function validateVault(raw: unknown): { entries: Array<[string, string]>; error: null } | { entries: []; error: string } {
  if (raw === undefined) return { entries: [], error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries: [], error: '项目文件的 vault 数据损坏' };
  }
  const names = Object.keys(raw);
  if (names.length > MAX_VAULT_DATASETS) {
    return {
      entries: [],
      error: `项目文件的 vault 数据集数量 ${names.length.toLocaleString()} 超过 ${MAX_VAULT_DATASETS.toLocaleString()} 条上限`,
    };
  }
  const entries: Array<[string, string]> = [];
  for (const name of names) {
    const json = (raw as Record<string, unknown>)[name];
    const nameError = vaultDatasetNameError(name);
    if (nameError) return { entries: [], error: nameError };
    if (typeof json !== 'string') return { entries: [], error: `项目库数据集「${name}」损坏` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { entries: [], error: `项目库数据集「${name}」损坏（JSON 解析失败）` };
    }
    const detail = worksheetValidationError(parsed, true);
    if (detail) return { entries: [], error: `项目库数据集「${name}」损坏：${detail}` };
    if ((parsed as JsonObject).name !== name) {
      return { entries: [], error: `项目库数据集「${name}」的名称与内容不一致` };
    }
    entries.push([name, json]);
  }
  return { entries, error: null };
}

function snapshotProjectStores(): ProjectStoreBackup {
  const backup: ProjectStoreBackup = new Map();
  for (const k of PROJECT_KEYS) backup.set(k, localStorage.getItem(k));
  return backup;
}

function backupAsRecord(backup: ProjectStoreBackup): ProjectImportJournal['previous'] {
  return Object.fromEntries(
    PROJECT_KEYS.map((key) => [key, backup.get(key) ?? null]),
  ) as ProjectImportJournal['previous'];
}

function normalizedProjectTarget(stores: Record<string, string>): ProjectStoreTarget {
  const target: ProjectStoreTarget = Object.create(null) as ProjectStoreTarget;
  for (const key of PROJECT_KEYS) {
    const value = stores[key];
    if (typeof value === 'string') target[key] = value;
  }
  return target;
}

function digestText(text: string): string {
  // 两路 32-bit FNV 只用于发现截断/静默改写，不承担密码学鉴权。
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function journalBodyDigest(
  target: ProjectStoreTarget,
  previous: ProjectImportJournal['previous'],
): string {
  const orderedTarget = Object.fromEntries(PROJECT_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(target, key))
    .map((key) => [key, target[key]]));
  const orderedPrevious = Object.fromEntries(PROJECT_KEYS.map((key) => [key, previous[key]]));
  return digestText(JSON.stringify({ version: 2, target: orderedTarget, previous: orderedPrevious }));
}

function makeProjectImportJournal(
  stores: Record<string, string>,
  backup: ProjectStoreBackup,
  phase: ProjectImportPhase,
): ProjectImportJournal {
  const target = normalizedProjectTarget(stores);
  const previous = backupAsRecord(backup);
  return { version: 2, target, previous, phase, digest: journalBodyDigest(target, previous) };
}

function projectJournalValidationError(raw: unknown): string | null {
  if (!isObject(raw) || raw.version !== 2 || !isObject(raw.target) || !isObject(raw.previous)
    || typeof raw.digest !== 'string'
    || !['stores-only', 'before-vault', 'vault-pending', 'vault-committed', 'rollback-intent', 'rolled-back']
      .includes(raw.phase as string)) {
    return '项目导入 journal 结构无效';
  }
  const target = raw.target as Record<string, unknown>;
  const previous = raw.previous as Record<string, unknown>;
  for (const [key, value] of Object.entries(target)) {
    if (!PROJECT_KEY_SET.has(key) || typeof value !== 'string') return `journal 目标 store「${key}」无效`;
    if (key === 'qp-active-ref-v1') {
      if (!value.trim()) return 'journal 活动数据集引用为空';
      continue;
    }
    try {
      const detail = projectStoreValidationError(key, JSON.parse(value));
      if (detail) return `journal 目标 store「${key}」损坏：${detail}`;
    } catch {
      return `journal 目标 store「${key}」JSON 损坏`;
    }
  }
  for (const key of PROJECT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(previous, key)
      || (previous[key] !== null && typeof previous[key] !== 'string')) {
      return `journal 导入前 store「${key}」无效`;
    }
  }
  if (Object.keys(previous).some((key) => !PROJECT_KEY_SET.has(key))) return 'journal 导入前 stores 含未知键';
  const expected = journalBodyDigest(
    raw.target as ProjectStoreTarget,
    raw.previous as ProjectImportJournal['previous'],
  );
  if (raw.digest !== expected) return '项目导入 journal 校验摘要不匹配';
  return null;
}

function parseProjectImportJournal(raw: unknown): ProjectImportJournal {
  const detail = projectJournalValidationError(raw);
  if (detail) throw new Error(detail);
  return raw as unknown as ProjectImportJournal;
}

function desiredProjectStoreValue(
  image: ProjectStoreTarget | ProjectStoreBackup | ProjectImportJournal['previous'],
  key: (typeof PROJECT_KEYS)[number],
): string | null {
  if (image instanceof Map) return image.get(key) ?? null;
  const value = image[key];
  return typeof value === 'string' ? value : null;
}

/**
 * journal 已耐久后才能调用。先删除目标缺失键，再按净容量增量从小到大写；
 * 因而最终能容纳的项目不会因“先写大键、后删旧键”的瞬时峰值失败。
 */
function applyProjectStoreImage(
  image: ProjectStoreTarget | ProjectStoreBackup | ProjectImportJournal['previous'],
): string | null {
  try {
    const current = new Map<(typeof PROJECT_KEYS)[number], string | null>();
    for (const key of PROJECT_KEYS) current.set(key, localStorage.getItem(key));
    for (const key of PROJECT_KEYS) {
      if (desiredProjectStoreValue(image, key) !== null) continue;
      localStorage.removeItem(key);
      if (localStorage.getItem(key) !== null) throw new Error(`本地存储「${key}」删除后读回不一致`);
      current.set(key, null);
    }
    const writes = PROJECT_KEYS
      .filter((key) => desiredProjectStoreValue(image, key) !== null)
      .sort((left, right) => {
        const leftValue = desiredProjectStoreValue(image, left)!;
        const rightValue = desiredProjectStoreValue(image, right)!;
        return (leftValue.length - (current.get(left)?.length ?? 0))
          - (rightValue.length - (current.get(right)?.length ?? 0));
      });
    for (const key of writes) {
      const value = desiredProjectStoreValue(image, key)!;
      // 即使当前文本相同也重写一次：恢复必须验证存储层仍可提交，
      // 不能把上次进程留下的偶然相同内容当作本次耐久成功。
      localStorage.setItem(key, value);
      if (localStorage.getItem(key) !== value) throw new Error(`本地存储「${key}」写入后读回不一致`);
      current.set(key, value);
    }
    // 最终再完整读回，防止 Storage 替身在后续写入时淘汰先前的键。
    for (const key of PROJECT_KEYS) {
      if (localStorage.getItem(key) !== desiredProjectStoreValue(image, key)) {
        throw new Error(`本地存储「${key}」最终读回不一致`);
      }
    }
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function restoreProjectStores(backup: ProjectStoreBackup | ProjectImportJournal['previous']): boolean {
  return applyProjectStoreImage(backup) === null;
}

function supportsIndexedDbJournal(): boolean {
  return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function';
}

function isProjectImportJournalReservation(raw: unknown): raw is ProjectImportJournalReservation {
  return isObject(raw)
    && raw.version === 2
    && raw.state === 'reserved'
    && typeof raw.token === 'string'
    && raw.token.length >= 1
    && raw.token.length <= 128;
}

function newProjectImportJournalToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `journal-${uuid}` : `journal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openProjectJournalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_IMPORT_JOURNAL_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECT_IMPORT_JOURNAL_STORE)) {
        request.result.createObjectStore(PROJECT_IMPORT_JOURNAL_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其他窗口阻塞'));
  });
}

async function readIndexedDbJournal(): Promise<unknown | null> {
  const db = await openProjectJournalDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_IMPORT_JOURNAL_STORE, 'readonly');
      const request = tx.objectStore(PROJECT_IMPORT_JOURNAL_STORE).get(PROJECT_IMPORT_JOURNAL_RECORD);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? tx.error ?? new Error('IndexedDB journal 读取失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB journal 读取事务失败'));
    });
  } finally {
    db.close();
  }
}

async function writeIndexedDbJournal(value: ProjectImportJournal | null): Promise<void> {
  const db = await openProjectJournalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_IMPORT_JOURNAL_STORE, 'readwrite');
      const store = tx.objectStore(PROJECT_IMPORT_JOURNAL_STORE);
      if (value === null) store.delete(PROJECT_IMPORT_JOURNAL_RECORD);
      else store.put(value, PROJECT_IMPORT_JOURNAL_RECORD);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB journal 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB journal 写入事务失败'));
    });
  } finally {
    db.close();
  }
}

/**
 * 固定 record 是 IndexedDB 中的真实互斥边界。add 只在不存在时成功，
 * 两个同时进入的标签页不会像 get→put 那样相互覆盖。reserved
 * 占位不含业务镜像：若此时崩溃，尚未改写任何 store，启动可直接清理。
 */
async function reserveIndexedDbJournal(): Promise<ProjectImportJournalReservation> {
  const reservation: ProjectImportJournalReservation = {
    version: 2,
    state: 'reserved',
    token: newProjectImportJournalToken(),
  };
  const db = await openProjectJournalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_IMPORT_JOURNAL_STORE, 'readwrite');
      const request = tx.objectStore(PROJECT_IMPORT_JOURNAL_STORE)
        .add(reservation, PROJECT_IMPORT_JOURNAL_RECORD);
      request.onerror = () => reject(request.error ?? new Error('已有未完成的项目导入 journal'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB journal 预留失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB journal 预留事务失败'));
    });
  } finally {
    db.close();
  }
  return reservation;
}

async function replaceIndexedDbJournalReservation(
  reservation: ProjectImportJournalReservation,
  journal: ProjectImportJournal,
): Promise<void> {
  const db = await openProjectJournalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECT_IMPORT_JOURNAL_STORE, 'readwrite');
      const store = tx.objectStore(PROJECT_IMPORT_JOURNAL_STORE);
      const read = store.get(PROJECT_IMPORT_JOURNAL_RECORD);
      read.onsuccess = () => {
        const current: unknown = read.result;
        if (!isProjectImportJournalReservation(current) || current.token !== reservation.token) {
          tx.abort();
          reject(new Error('IndexedDB journal 预留所有权丢失'));
          return;
        }
        store.put(journal, PROJECT_IMPORT_JOURNAL_RECORD);
      };
      read.onerror = () => reject(read.error ?? tx.error ?? new Error('IndexedDB journal 预留读取失败'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB journal 记录写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB journal 记录写入事务失败'));
    });
  } finally {
    db.close();
  }
}

function indexedDbMarker(journal: ProjectImportJournal): IndexedDbJournalMarker {
  return {
    version: 2,
    backend: 'indexeddb',
    target: digestText(JSON.stringify(journal.target)),
    previous: digestText(JSON.stringify(journal.previous)),
    phase: journal.phase,
    digest: journal.digest,
  };
}

function writeJournalMarker(value: unknown): void {
  const encoded = JSON.stringify(value);
  localStorage.setItem(PROJECT_IMPORT_JOURNAL_KEY, encoded);
  if (localStorage.getItem(PROJECT_IMPORT_JOURNAL_KEY) !== encoded) {
    throw new Error('项目导入 journal marker 写入后读回不一致');
  }
}

function removeJournalMarker(): void {
  localStorage.removeItem(PROJECT_IMPORT_JOURNAL_KEY);
  if (localStorage.getItem(PROJECT_IMPORT_JOURNAL_KEY) !== null) {
    throw new Error('项目导入 journal marker 未能删除');
  }
}

/** stageProjectImportJournal 失败且完整 IDB journal 未能撤销时的标记。 */
const STAGED_JOURNAL_RESIDUAL = 'projectImportJournalResidual';

async function stageProjectImportJournal(
  stores: Record<string, string>,
  backup: ProjectStoreBackup,
  phase: ProjectImportPhase,
): Promise<LoadedProjectImportJournal> {
  if (localStorage.getItem(PROJECT_IMPORT_JOURNAL_KEY) !== null) {
    throw new Error('已有未完成的项目导入 journal，请先重启恢复');
  }
  const journal = makeProjectImportJournal(stores, backup, phase);
  if (!supportsIndexedDbJournal()) {
    // 受限 WebView/测试环境的明确 fallback：必须在改写任何业务键之前整体落盘；
    // 写不下就拒绝导入，不宣称解决接近 localStorage 配额的场景。
    writeJournalMarker({ ...journal, backend: 'localStorage' });
    return { journal, backend: 'localStorage' };
  }
  const reservation = await reserveIndexedDbJournal();
  try {
    await replaceIndexedDbJournalReservation(reservation, journal);
    writeJournalMarker(indexedDbMarker(journal));
  } catch (error) {
    // 这里的 record 可能已是完整 journal。无 marker 的完整 IDB journal 是启动恢复
    // 事实（裁决规则不变），所以清理后必须读回确认：确认已删除（或仅剩不含业务镜像的
    // reserved 占位）才可对调用方宣称「项目未改写」并放行编辑；否则失败之后的编辑会在
    // 下次启动被这份 journal 静默覆盖（fix2609j PLATFORM-08），调用方必须锁定并要求重启。
    try { await writeIndexedDbJournal(null); } catch { /* 下方读回裁决 */ }
    let cleanupConfirmed = false;
    try {
      const residual = await readIndexedDbJournal();
      cleanupConfirmed = residual === null || isProjectImportJournalReservation(residual);
    } catch { /* 无法读回按未清理处理 */ }
    if (!cleanupConfirmed) {
      throw Object.assign(new Error(errorMessage(error)), {
        cause: error,
        [STAGED_JOURNAL_RESIDUAL]: true,
      });
    }
    throw error;
  }
  return { journal, backend: 'indexeddb' };
}

function stageJournalFailure(error: unknown): ProjectApplyResult {
  if (typeof error === 'object' && error !== null
    && (error as Record<string, unknown>)[STAGED_JOURNAL_RESIDUAL] === true) {
    return projectApplyFailure(
      `无法建立项目导入 journal：${errorMessage(error)}；已写入 IndexedDB 的导入 journal 未能撤销，`
      + '下次启动会按该 journal 收口本次导入。为防止之后的编辑被启动恢复覆盖，页面已锁定，请立即重新启动应用',
      true,
    );
  }
  return projectApplyFailure(`无法建立项目导入 journal，项目未改写：${errorMessage(error)}`);
}

function stageProjectImportJournalSync(
  stores: Record<string, string>,
  backup: ProjectStoreBackup,
): LoadedProjectImportJournal {
  if (localStorage.getItem(PROJECT_IMPORT_JOURNAL_KEY) !== null) {
    throw new Error('已有未完成的项目导入 journal，请先重启恢复');
  }
  const journal = makeProjectImportJournal(stores, backup, 'stores-only');
  writeJournalMarker({ ...journal, backend: 'localStorage' });
  return { journal, backend: 'localStorage' };
}

async function updateProjectImportJournal(
  loaded: LoadedProjectImportJournal,
  phase: ProjectImportPhase,
): Promise<LoadedProjectImportJournal> {
  const journal = { ...loaded.journal, phase };
  if (loaded.backend === 'indexeddb') {
    await writeIndexedDbJournal(journal);
    writeJournalMarker(indexedDbMarker(journal));
  } else {
    writeJournalMarker({ ...journal, backend: 'localStorage' });
  }
  return { journal, backend: loaded.backend };
}

async function clearProjectImportJournal(loaded: LoadedProjectImportJournal | null): Promise<void> {
  if (loaded?.backend === 'indexeddb') await writeIndexedDbJournal(null);
  removeJournalMarker();
}

function clearProjectImportJournalSync(): void {
  removeJournalMarker();
}

async function loadProjectImportJournal(): Promise<LoadedProjectImportJournal | null> {
  let encoded: string | null;
  try { encoded = localStorage.getItem(PROJECT_IMPORT_JOURNAL_KEY); } catch (error) {
    const failure = new Error(`读取项目导入 journal marker 失败：${errorMessage(error)}`) as Error & {
      cause?: unknown;
    };
    failure.cause = error;
    throw failure;
  }
  // 支持 IDB 时每次都探测固定 record；marker 不得再是唯一入口。
  // 这也能在旧 localStorage fallback 与 IDB artifact 同时出现时
  // 显式报冲突，而不是先用一个、数次重启后才偶然发现另一个。
  const indexedRaw = supportsIndexedDbJournal() ? await readIndexedDbJournal() : null;
  if (indexedRaw !== null) {
    if (isProjectImportJournalReservation(indexedRaw)) {
      if (encoded !== null) {
        throw new Error('IndexedDB journal 预留与 localStorage marker 冲突');
      }
      // reserved 提交后、完整 journal 写入前崩溃：业务 stores
      // 尚未改写，删除占位即可。删除失败必须 fail closed。
      await writeIndexedDbJournal(null);
      return null;
    }
    const journal = parseProjectImportJournal(indexedRaw);
    if (encoded === null) {
      // IDB 记录先于 marker 耐久；完整无 marker journal 是恢复事实。
      return { journal, backend: 'indexeddb' };
    }
    let indexedMarker: unknown;
    try { indexedMarker = JSON.parse(encoded); } catch {
      // 完整、校验通过的 IDB record 是权威副本；损坏的小 marker
      // 可以删除并继续恢复，不留下永久人工介入点。
      removeJournalMarker();
      return { journal, backend: 'indexeddb' };
    }
    if (!isObject(indexedMarker) || indexedMarker.backend !== 'indexeddb') {
      throw new Error('IndexedDB journal 与 localStorage journal marker 冲突');
    }
    if (typeof indexedMarker.digest !== 'string' || indexedMarker.digest !== journal.digest) {
      throw new Error('IndexedDB journal 与启动 marker 摘要不一致');
    }
    return { journal, backend: 'indexeddb' };
  }
  if (encoded === null) return null;
  let marker: unknown;
  try { marker = JSON.parse(encoded); } catch { throw new Error('项目导入 journal marker 已损坏'); }
  if (isObject(marker) && marker.backend === 'indexeddb') {
    if (!supportsIndexedDbJournal()) throw new Error('journal 位于 IndexedDB，但当前环境无法读取');
    // 清理 record 已提交、marker 删除前中断；业务 stores
    // 在删 IDB 前已经读回确认，因此只需收掉旧 marker。
    removeJournalMarker();
    return null;
  }
  if (!isObject(marker) || marker.backend !== 'localStorage') {
    throw new Error('项目导入 journal marker 类型无效');
  }
  return { journal: parseProjectImportJournal(marker), backend: 'localStorage' };
}

/** 启动快速路径：读取失败按“可能存在”处理，后续完整恢复会 fail closed。 */
export function hasPendingProjectImportJournal(): boolean {
  // IndexedDB 无法同步探测。支持 IDB 的宿主必须走完整启动恢复，
  // 不能再用 localStorage marker 当唯一快速路径。
  if (supportsIndexedDbJournal()) return true;
  try { return localStorage.getItem(PROJECT_IMPORT_JOURNAL_KEY) !== null; } catch { return true; }
}

/**
 * 清除全部业务数据前的统一 journal 边界。先按既有协议收口任何
 * 未完成导入；只有已经确定前向/回滚且 artifact 全部清理后才放行清库。
 */
export async function settleProjectImportRecoveryBeforeDataClear(): Promise<void> {
  const recovery = await recoverPendingProjectImport();
  // 不管本次恢复是否成功，都再确认固定 IDB record 与 marker
  // 已一起清理；清库不得绕过隐藏的孤儿 artifact。
  const remaining = await loadProjectImportJournal();
  if (remaining !== null) {
    throw new Error(recovery.error ?? '项目导入 journal 未能完整清理');
  }
  if (recovery.reloadRequired) {
    // 持久 stores 已被前向完成/回滚，但当前内存还是恢复前镜像。
    // 若继续清库后又明确未提交，放行 UI 会让旧内存覆盖恢复结果；
    // 因此先重载对齐，再由用户重试清库。
    throw new Error(recovery.error ?? '未完成的项目导入已收口，需要重新启动后再清除数据');
  }
  if (recovery.error) throw new Error(recovery.error);
}

function hasAtomicProjectImport(db: NonNullable<typeof platform.datasetDb>): boolean {
  return typeof db.beginProjectImport === 'function'
    && typeof db.commitProjectImport === 'function'
    && typeof db.rollbackProjectImport === 'function'
    && typeof db.pendingProjectImport === 'function';
}

/**
 * 启动/下一次导入时收口 Web/SQLite 两层 journal。
 * Web stores 的全量 staging 优先放 IndexedDB（localStorage 只留小 marker）；
 * SQLite backup 仍是旧 vault 的唯一副本，不把整库复制进 JS。
 */
export interface PendingProjectRecoveryResult {
  recovered: boolean;
  error: string | null;
  /** 持久层已前向完成或已确定回滚；已初始化的 Zustand 必须重载才能对齐。 */
  reloadRequired: boolean;
}

interface SqlitePendingEnvelope {
  target: ProjectStoreTarget;
  previous: ProjectImportJournal['previous'] | null;
}

function parseSqlitePendingEnvelope(encoded: string): SqlitePendingEnvelope {
  const parsed = JSON.parse(encoded) as unknown;
  if (!isObject(parsed)) throw new Error('SQLite journal stores 不是对象');
  const targetRaw = parsed.version === 1 && isObject(parsed.target) ? parsed.target : parsed;
  const target: ProjectStoreTarget = Object.create(null) as ProjectStoreTarget;
  for (const [key, value] of Object.entries(targetRaw)) {
    if (!PROJECT_KEY_SET.has(key) || typeof value !== 'string') throw new Error(`SQLite journal store「${key}」无效`);
    target[key as keyof ProjectStoreTarget] = value;
  }
  let previous: ProjectImportJournal['previous'] | null = null;
  if (parsed.version === 1) {
    if (!isObject(parsed.previous)) throw new Error('SQLite journal 缺少导入前 stores');
    previous = Object.create(null) as ProjectImportJournal['previous'];
    for (const key of PROJECT_KEYS) {
      const value = parsed.previous[key];
      if (value !== null && typeof value !== 'string') throw new Error(`SQLite journal 旧 store「${key}」无效`);
      previous[key] = value;
    }
  }
  const validation = projectJournalValidationError({
    version: 2,
    target,
    previous: previous ?? Object.fromEntries(PROJECT_KEYS.map((key) => [key, null])),
    phase: 'vault-pending',
    digest: journalBodyDigest(target, previous ?? Object.fromEntries(
      PROJECT_KEYS.map((key) => [key, null]),
    ) as ProjectImportJournal['previous']),
  });
  if (validation) throw new Error(validation);
  return { target, previous };
}

async function clearRecoveredJournal(
  loaded: LoadedProjectImportJournal | null,
): Promise<string | null> {
  if (!loaded) return null;
  try {
    await clearProjectImportJournal(loaded);
    return null;
  } catch (error) {
    return `项目导入已确定收口，但 journal 未能清理：${errorMessage(error)}`;
  }
}

async function rollbackPendingSqliteImport(
  db: NonNullable<typeof platform.datasetDb>,
  previous: ProjectStoreBackup | ProjectImportJournal['previous'],
  loaded: LoadedProjectImportJournal | null,
  reason: string,
  options: { intentBeforeRestore?: boolean } = {},
): Promise<PendingProjectRecoveryResult> {
  let rollbackJournal = loaded;
  const persistRollbackIntent = async (): Promise<string | null> => {
    if (!rollbackJournal || rollbackJournal.journal.phase === 'rollback-intent') return null;
    try {
      rollbackJournal = await updateProjectImportJournal(rollbackJournal, 'rollback-intent');
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  };
  if (options.intentBeforeRestore) {
    const intentError = await persistRollbackIntent();
    if (intentError) {
      return {
        recovered: false,
        error: `${reason}；无法耐久数据库回滚意图：${intentError}。SQLite journal 与备份已保留`,
        reloadRequired: false,
      };
    }
  }
  if (!restoreProjectStores(previous)) {
    return {
      recovered: false,
      error: `${reason}；本地存储尚未完整恢复，SQLite journal 与唯一旧 vault 备份已保留`,
      reloadRequired: false,
    };
  }
  // 必须在 SQLite rollback 之前耐久意图。否则 rollback 已提交、
  // Web journal 清理又失败时，pending=null 会被下次启动误判为 commit 已耐久。
  const intentError = await persistRollbackIntent();
  if (intentError) {
    return {
      recovered: false,
      error: `${reason}；无法耐久数据库回滚意图：${intentError}。SQLite journal 与备份已保留`,
      reloadRequired: false,
    };
  }
  try {
    await db.rollbackProjectImport!();
  } catch (rollbackError) {
    // rollback 也可能“已耐久但 IPC reject”；不能在 pending 已清时误报未回滚。
    let pending: string | null;
    try { pending = await db.pendingProjectImport!(); } catch (statusError) {
      return {
        recovered: false,
        error: `${reason}；本地存储已恢复，但数据库回滚状态无法确认：${errorMessage(statusError)}。journal 与备份已保留`,
        reloadRequired: false,
      };
    }
    if (pending !== null) {
      return {
        recovered: false,
        error: `${reason}；数据库回滚失败：${errorMessage(rollbackError)}。SQLite journal 与备份已保留`,
        reloadRequired: false,
      };
    }
  }
  if (rollbackJournal) {
    try {
      rollbackJournal = await updateProjectImportJournal(rollbackJournal, 'rolled-back');
    } catch (error) {
      return {
        recovered: false,
        error: `${reason}；数据库已回滚，但 Web journal 未能标记 rolled-back：${errorMessage(error)}。rollback-intent 已保留供下次恢复`,
        reloadRequired: false,
      };
    }
  }
  if (!restoreProjectStores(previous)) {
    return {
      recovered: false,
      error: `${reason}；数据库已回滚，但导入前 stores 最终读回失败；rolled-back journal 已保留`,
      reloadRequired: false,
    };
  }
  const cleanupError = await clearRecoveredJournal(rollbackJournal);
  return {
    recovered: false,
    error: cleanupError ?? `${reason}；本地存储与数据库已完整回滚`,
    reloadRequired: cleanupError === null,
  };
}

async function commitPendingSqliteImport(
  db: NonNullable<typeof platform.datasetDb>,
  target: ProjectStoreTarget,
  previous: ProjectStoreBackup | ProjectImportJournal['previous'],
  loaded: LoadedProjectImportJournal | null,
): Promise<PendingProjectRecoveryResult> {
  try {
    await db.commitProjectImport!();
  } catch (error) {
    let pending: string | null;
    try {
      pending = await db.pendingProjectImport!();
    } catch (statusError) {
      // 不知道 commit 是否耐久：任何前向/回滚都可能造成跨层混合。
      return {
        recovered: false,
        error: `项目导入提交 IPC 失败，且无法确认 SQLite journal 状态：${errorMessage(statusError)}。已保留可恢复态，请重启后重试`,
        reloadRequired: false,
      };
    }
    if (pending !== null) {
      return rollbackPendingSqliteImport(
        db,
        previous,
        loaded,
        `项目导入提交未耐久（${errorMessage(error)}）`,
        { intentBeforeRestore: true },
      );
    }
    // pending=null 是 SQLite 的耐久事实：commit 已成功，IPC 只丢了回复。
    // 此时绝不能把 stores 回滚到旧项目；反而再次前向确保 target。
    const storeError = applyProjectStoreImage(target);
    if (storeError) {
      return {
        recovered: false,
        error: `SQLite 已提交新 vault，但重新确保目标 stores 失败：${storeError}。Web journal 已保留，请释放空间后重启`,
        reloadRequired: false,
      };
    }
  }
  if (loaded) {
    try {
      loaded = await updateProjectImportJournal(loaded, 'vault-committed');
    } catch (error) {
      return {
        recovered: false,
        error: `SQLite 已提交新 vault，但无法更新 Web journal：${errorMessage(error)}。目标 stores 已保持，请重启恢复`,
        reloadRequired: false,
      };
    }
  }
  const cleanupError = await clearRecoveredJournal(loaded);
  if (cleanupError) return { recovered: false, error: cleanupError, reloadRequired: false };
  return {
    recovered: true,
    error: null,
    reloadRequired: true,
  };
}

async function recoverStoresOnlyJournal(
  loaded: LoadedProjectImportJournal,
): Promise<PendingProjectRecoveryResult> {
  const targetError = applyProjectStoreImage(loaded.journal.target);
  if (targetError === null) {
    const cleanupError = await clearRecoveredJournal(loaded);
    return cleanupError
      ? { recovered: false, error: cleanupError, reloadRequired: false }
      : { recovered: true, error: null, reloadRequired: true };
  }
  if (!restoreProjectStores(loaded.journal.previous)) {
    return {
      recovered: false,
      error: `写入待恢复的目标 stores 失败（${targetError}），导入前 stores 也尚未完整恢复；journal 已保留`,
      reloadRequired: false,
    };
  }
  const cleanupError = await clearRecoveredJournal(loaded);
  return {
    recovered: false,
    error: cleanupError ?? `写入待恢复的目标 stores 失败（${targetError}），原项目已完整回滚`,
    reloadRequired: cleanupError === null,
  };
}

export async function recoverPendingProjectImport(): Promise<PendingProjectRecoveryResult> {
  let loaded: LoadedProjectImportJournal | null;
  try {
    loaded = await loadProjectImportJournal();
  } catch (error) {
    return { recovered: false, error: `检查未完成项目导入失败：${errorMessage(error)}`, reloadRequired: false };
  }
  const db = platform.datasetDb;
  const atomic = Boolean(db && hasAtomicProjectImport(db));
  let pending: string | null = null;
  if (atomic) {
    try {
      pending = await db!.pendingProjectImport!();
    } catch (error) {
      return { recovered: false, error: `检查未完成项目导入失败：${errorMessage(error)}`, reloadRequired: false };
    }
  }

  if (pending !== null && db) {
    let envelope: SqlitePendingEnvelope;
    try {
      envelope = parseSqlitePendingEnvelope(pending);
    } catch (error) {
      const previous = loaded?.journal.previous;
      if (!previous) {
        return {
          recovered: false,
          error: `未完成的 SQLite journal 损坏，且没有可验证的导入前 stores；journal 与备份已保留：${errorMessage(error)}`,
          reloadRequired: false,
        };
      }
      return rollbackPendingSqliteImport(db, previous, loaded, `未完成的 SQLite journal 损坏：${errorMessage(error)}`);
    }
    if (loaded && loaded.journal.digest !== journalBodyDigest(
      envelope.target,
      envelope.previous ?? loaded.journal.previous,
    )) {
      return {
        recovered: false,
        error: 'SQLite journal 与 Web journal 的目标/导入前 stores 不一致；已保留两层备份并阻止启动',
        reloadRequired: false,
      };
    }
    let previous = envelope.previous ?? loaded?.journal.previous;
    if (!previous) {
      try { previous = backupAsRecord(snapshotProjectStores()); } catch {
        return { recovered: false, error: '无法读取当前 stores 作为旧版 journal 回滚副本', reloadRequired: false };
      }
    }
    if (loaded && (loaded.journal.phase === 'rollback-intent'
      || loaded.journal.phase === 'rolled-back')) {
      return rollbackPendingSqliteImport(db, previous, loaded, '恢复上次已耐久的回滚意图');
    }
    const writeError = applyProjectStoreImage(envelope.target);
    if (writeError) {
      return rollbackPendingSqliteImport(db, previous, loaded, `写入待恢复的目标 stores 失败（${writeError}）`);
    }
    return commitPendingSqliteImport(db, envelope.target, previous, loaded);
  }

  if (!loaded) return { recovered: false, error: null, reloadRequired: false };
  if (loaded.journal.phase === 'stores-only') return recoverStoresOnlyJournal(loaded);
  if (!atomic || !db) {
    return {
      recovered: false,
      error: '项目导入涉及 SQLite vault，但当前无法确认其提交状态；journal 已保留',
      reloadRequired: false,
    };
  }
  if (loaded.journal.phase === 'rollback-intent' || loaded.journal.phase === 'rolled-back') {
    // pending=null + rollback phase 只能表示 rollback 已耐久；绝不能前向写 target。
    if (!restoreProjectStores(loaded.journal.previous)) {
      return {
        recovered: false,
        error: 'SQLite 已回滚，但导入前 stores 尚未完整恢复；rollback journal 已保留',
        reloadRequired: false,
      };
    }
    if (loaded.journal.phase !== 'rolled-back') {
      try { loaded = await updateProjectImportJournal(loaded, 'rolled-back'); } catch (error) {
        return {
          recovered: false,
          error: `SQLite 已回滚，但 Web journal 未能标记 rolled-back：${errorMessage(error)}`,
          reloadRequired: false,
        };
      }
    }
    const cleanupError = await clearRecoveredJournal(loaded);
    return {
      recovered: false,
      error: cleanupError ?? '上次项目导入已完整回滚',
      reloadRequired: cleanupError === null,
    };
  }
  if (loaded.journal.phase === 'before-vault') {
    if (!restoreProjectStores(loaded.journal.previous)) {
      return { recovered: false, error: 'SQLite 事务未开始，但导入前 stores 尚未完整恢复；journal 已保留', reloadRequired: false };
    }
    const cleanupError = await clearRecoveredJournal(loaded);
    return {
      recovered: false,
      error: cleanupError ?? '上次项目导入在 SQLite 事务开始前中断，原 stores 已恢复',
      reloadRequired: cleanupError === null,
    };
  }
  // phase=vault-pending/committed 且 pending=null：SQLite commit 已耐久。
  const storeError = applyProjectStoreImage(loaded.journal.target);
  if (storeError) {
    return {
      recovered: false,
      error: `SQLite 已提交新 vault，但目标 stores 尚未完整恢复：${storeError}。journal 已保留`,
      reloadRequired: false,
    };
  }
  const cleanupError = await clearRecoveredJournal(loaded);
  return cleanupError
    ? { recovered: false, error: cleanupError, reloadRequired: false }
    : { recovered: true, error: null, reloadRequired: true };
}

/**
 * 读取侧（store 启动校验）隔离损坏键时，只把原文复制进隔离区、内存降级为空，live 键原样保留。
 * 导出侧须与读取侧同口径（fix2609j PLATFORM-05）：live 值与隔离区中该键的 raw/latestRaw
 * 逐字相同，说明损坏原文已随 qp-quarantine-v1 附件带出，此时按降级视图（该键缺省）导出，
 * 不再整份拒绝。原文未进隔离区时仍 fail-closed——降级会让备份里再也找不回它。
 * AQL 责任账本损坏是显式 fail-closed 设计（appStore requirePersistedAqlState），不在此放行。
 */
const QUARANTINE_DEGRADE_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  'qp-aql-state-v1',
  QUARANTINE_STORAGE_KEY,
  'qp-active-ref-v1',
]);

function quarantinedRawTextsByKey(
  storeOverrides: Partial<Record<(typeof PROJECT_KEYS)[number], string>>,
): Map<string, Set<string>> {
  const byKey = new Map<string, Set<string>>();
  let encoded: string | null | undefined;
  try {
    encoded = Object.prototype.hasOwnProperty.call(storeOverrides, QUARANTINE_STORAGE_KEY)
      ? storeOverrides[QUARANTINE_STORAGE_KEY]
      : localStorage.getItem(QUARANTINE_STORAGE_KEY);
  } catch {
    return byKey;
  }
  if (encoded == null) return byKey;
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); } catch { return byKey; }
  if (quarantineValidationError(parsed) !== null || !isObject(parsed)) return byKey;
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isObject(entry)) continue;
    const texts = new Set<string>();
    if (typeof entry.raw === 'string') texts.add(entry.raw);
    if (typeof entry.latestRaw === 'string') texts.add(entry.latestRaw);
    byKey.set(key, texts);
  }
  return byKey;
}

let lastProjectExportDegradedStores: string[] = [];

/** 最近一次 buildProjectJson 因「已隔离」而按降级视图省略的业务键（供导出成功提示明示）。 */
export function getLastProjectExportDegradedStores(): string[] {
  return [...lastProjectExportDegradedStores];
}

export function buildProjectJson(
  appVersion: string,
  allowEmpty = false,
  storeOverrides: Partial<Record<(typeof PROJECT_KEYS)[number], string>> = {},
): string {
  const stores: Record<string, string> = {};
  let knownStoreCount = 0;
  lastProjectExportDegradedStores = [];
  const quarantinedTexts = quarantinedRawTextsByKey(storeOverrides);
  const degradedStores: string[] = [];
  const quarantinedCorrupt = (key: string, value: string): boolean => (
    !QUARANTINE_DEGRADE_EXCLUDED_KEYS.has(key) && quarantinedTexts.get(key)?.has(value) === true
  );
  // 分析数据快照库损坏时先记下而不立即抛：是否阻断取决于是否仍有卡片引用它（见循环后）。
  let corruptAnalysisDataDetail: string | null = null;
  // 逐键校验的解析结果留给下方跨键预检/裁剪复用：快照库最多 40 份工作表，不再整库重复解析。
  const parsedStores = new Map<string, unknown>();
  for (const k of PROJECT_KEYS) {
    let v: string | null;
    if (Object.prototype.hasOwnProperty.call(storeOverrides, k)) {
      v = storeOverrides[k] ?? null;
    } else {
      try {
        v = localStorage.getItem(k);
      } catch (error) {
        const failure = new Error(`读取项目数据「${k}」失败，项目未导出：${errorMessage(error)}`) as Error & {
          cause?: unknown;
        };
        failure.cause = error;
        throw failure;
      }
    }
    if (v == null) continue;
    if (k === 'qp-active-ref-v1') {
      if (!v.trim()) throw new Error('活动数据集引用为空，项目未导出');
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        if (quarantinedCorrupt(k, v)) {
          degradedStores.push(k);
          continue;
        }
        if (k === 'qp-analysis-data-v1') {
          corruptAnalysisDataDetail = 'JSON 损坏';
          continue;
        }
        throw new Error(`项目数据「${k}」JSON 损坏，项目未导出`);
      }
      const detail = projectStoreValidationError(k, parsed);
      if (detail && quarantinedCorrupt(k, v)) {
        // 与读取侧降级视图一致：该键按缺省导出，损坏原文随隔离区附件带出。
        degradedStores.push(k);
        continue;
      }
      if (detail && k === 'qp-analysis-data-v1') {
        corruptAnalysisDataDetail = `损坏：${detail}`;
        continue;
      }
      if (detail) throw new Error(`项目数据「${k}」损坏，项目未导出：${detail}`);
      parsedStores.set(k, parsed);
    }
    stores[k] = v;
    knownStoreCount += 1;
  }
  // 分析快照库与卡片的跨键一致性在这里用本机可执行的指引拦截（fix2609 M4(b)）：否则要么只报
  // 「JSON 损坏」不给出路，要么落到下方自校验只给内部去重键，用户在「最需要备份时」无从下手。
  let exportedAnalyses = parsedStores.get('qp-analyses-v1');
  if (corruptAnalysisDataDetail !== null) {
    const referencing = analysesReferencingMissingData(exportedAnalyses, undefined);
    // 无卡片引用的损坏库与孤儿同属残留（没有任何入口能再读到它）：不写入导出件，也不阻断备份；
    // 本机 live 键不动，已隔离的原文随 qp-quarantine-v1 / 墓地键照常导出。
    // 仍有卡片引用时不降级：损坏原文此刻未必已进隔离区，降级后备份里就再也找不回它。
    if (referencing.length > 0) {
      throw new Error(
        `项目数据「qp-analysis-data-v1」（分析数据快照库）${corruptAnalysisDataDetail}，项目未导出。`
        + `有 ${referencing.length} 条已保存分析引用该库：${analysisLabelList(referencing)}。`
        + '处理办法：本地存储空间充足时，保存一条新的工作表型分析即可替换损坏的快照库（损坏原文会先复制到隔离区），'
        + '之后这些记录会在导出件中标记为「快照缺失」；'
        + `或在左侧「已保存分析」中点击「${REMOVE_SNAPSHOT_MISSING_LABEL}」后重试`,
      );
    }
  } else {
    const dangling = analysesReferencingMissingData(exportedAnalyses, parsedStores.get('qp-analysis-data-v1'));
    if (dangling.length > 0 && Array.isArray(exportedAnalyses)) {
      // 快照库曾被隔离/替换：这些卡片已无法回看，降级为「快照缺失」形态随备份导出（fix2609 M4），
      // 不再要求用户先在侧栏找出并删掉它们（侧栏只列前 6 条，旧卡可能根本看不到）。
      exportedAnalyses = markAnalysesSnapshotMissing(exportedAnalyses, new Set(dangling));
      stores['qp-analyses-v1'] = JSON.stringify(exportedAnalyses);
    }
  }
  // 孤儿分析数据是尽力而为 prune 失败后的残留：导出前丢弃，而不是让自校验把整份备份阻断
  // （本机最需要备份时反而导不出）。两键都已通过上方逐键校验，这里只做子集裁剪。
  if (stores['qp-analysis-data-v1'] !== undefined) {
    const pruned = pruneUnreferencedAnalysisData(exportedAnalyses, parsedStores.get('qp-analysis-data-v1'));
    if (pruned) {
      if (Object.keys(pruned.kept).length > 0) stores['qp-analysis-data-v1'] = JSON.stringify(pruned.kept);
      else {
        delete stores['qp-analysis-data-v1'];
        knownStoreCount -= 1;
      }
    }
  }
  // 自审:隔离区墓地键(qp-quarantine-v1.corrupt-*)不在 PROJECT_KEYS 里,此前导出时被
  // 静默丢弃——恰恰是「数据已损坏、最需要备份」的场景。按前缀扫描附加进去(原样透传,
  // 不参与 projectStoreValidationError:墓地里存的本来就是损坏原文)。
  // **单向**:导入侧刻意不还原(业务写入只遍历 PROJECT_KEYS)——墓地是随文件
  // 带走的取证附件,写回会把 A 项目的损坏残片串进 B 项目;本机墓地由「选项→清除本地存储」清理。
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`)) continue;
      const v = localStorage.getItem(k);
      if (v != null) stores[k] = v;
    }
  } catch { /* 读取失败不阻断导出:墓地是附加证据 */ }
  // 空判据按 **PROJECT_KEYS 命中数** 判(自审 P3):只剩墓地键时 stores 非空会绕过这里,
  // 落到下游自校验被 knownStoreCount===0 拒绝,用户拿到的是打偏的「自校验失败」文案。
  if (!allowEmpty && knownStoreCount === 0) throw new Error('当前项目没有可导出的持久化数据');
  const file: ProjectFile = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion,
    // exportedAt 固定为 UTC ISO(机器可比对);文件名用本地日期(localDateStamp),两者口径不同是有意的

    exportedAt: new Date().toISOString(),
    stores,
  };
  const encoded = JSON.stringify(file, null, 2);
  // 项目文本即使尚未嵌入桌面 vault，也必须先满足同一导入上限。
  assertQprojExportText(encoded);
  // Web 项目不含 SQLite 活动引用，可立即执行完整的自导入校验。
  if (Object.keys(stores).length > 0 && stores['qp-active-ref-v1'] === undefined) {
    const checked = validateProjectFile(encoded);
    if (checked.file === null) throw new Error(`生成的项目文件未通过自校验：${checked.error}`);
  }
  lastProjectExportDegradedStores = degradedStores;
  return encoded;
}

/** 完整导出:桌面端把 SQLite 数据集库一并嵌入(排除最近列表里已带全量数据的,避免双份)。 */
export async function buildProjectJsonFull(appVersion: string): Promise<string> {
  const lease = await prepareProjectExport();
  try {
  const base = JSON.parse(buildProjectJson(appVersion, true, lease.overrides)) as ProjectFile;
  const activeRef = base.stores['qp-active-ref-v1'];
  const db = platform.datasetDb;
  if (activeRef !== undefined && !activeRef.trim()) {
    throw new Error('活动数据集引用为空，项目未导出');
  }
  if (activeRef !== undefined) {
    const nameError = vaultDatasetNameError(activeRef);
    if (nameError) throw new Error(`${nameError}，项目未导出`);
  }
  if (activeRef !== undefined && !db) {
    throw new Error(`活动数据集「${activeRef}」仅存在于本机库，但当前无法读取数据集库，项目未导出`);
  }
  if (db) {
    try {
      // 最近列表中已随 stores 携带完整数据的数据集,不再重复嵌入
      const inRecents = new Set<string>();
      try {
        const recents = JSON.parse(base.stores['qp-recents-v1'] ?? '[]') as Array<{ name: string; data?: unknown }>;
        for (const r of recents) if (r.data != null) inRecents.add(r.name);
      } catch { /* 解析失败按全部嵌入处理 */ }
      // 必须用无原型容器：普通对象的 vault['__proto__'] 会改变原型而不是新建数据集，
      // 导致数据库名称集与最终 JSON 名称集不对称。保留元键仍在边界显式拒绝。
      const vault = emptyVault();
      const baseBytes = qprojExportByteLength(JSON.stringify(base, null, 2));
      assertQprojExportByteLength(baseBytes);
      const snapshot = db.readSnapshot ? await db.readSnapshot({
        excludeNames: [...inRecents],
        forceIncludeName: activeRef ?? null,
        maxJsonBytes: MAX_QPROJ_IMPORT_BYTES - baseBytes,
      }) : null;
      if (snapshot) base.vaultRevision = snapshot.revision;
      const metas = snapshot?.datasets ?? await db.list();
      if (metas.length > MAX_VAULT_DATASETS) {
        throw new Error(
          `本机数据集库数量 ${metas.length.toLocaleString()} 超过 ${MAX_VAULT_DATASETS.toLocaleString()} 条上限`,
        );
      }
      const listedNames = new Set<string>();
      for (const meta of metas) {
        const nameError = vaultDatasetNameError(meta?.name);
        if (nameError) throw new Error(nameError);
        if (listedNames.has(meta.name)) throw new Error(`数据集库返回了重复名称「${meta.name}」`);
        listedNames.add(meta.name);
      }
      const selectedMetas = metas.filter((meta) => !inRecents.has(meta.name) || meta.name === activeRef);
      const expectedVaultNames = new Set(selectedMetas.map((meta) => meta.name));
      // SQLite bytes 是各数据集 JSON 的 UTF-8 字节数。其与 base 之和是最终 QPROJ 的下界；
      // 若下界已超限，无需再把所有大字符串读进 WebView 内存。
      const knownVaultBytes = selectedMetas.reduce((sum, meta) => {
        if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0) return sum;
        const next = sum + meta.bytes;
        // 损坏的元数据不能让累加越过 JS 安全整数后反而绕过上限。
        return Number.isSafeInteger(next) && next <= MAX_QPROJ_IMPORT_BYTES
          ? next
          : MAX_QPROJ_IMPORT_BYTES + 1;
      }, 0);
      assertQprojExportByteLength(
        qprojExportByteLength(JSON.stringify(base, null, 2)) + knownVaultBytes,
        true,
      );
      for (const meta of selectedMetas) {
        // 活动引用必须始终随 vault 导出；即使最近列表意外含有同名全量副本也不能省略。
        const json = 'json' in meta ? meta.json : await db.get(meta.name);
        if (json == null) throw new Error(`数据集「${meta.name}」在导出期间不可读取`);
        Object.defineProperty(vault, meta.name, {
          value: json, enumerable: true, configurable: true, writable: true,
        });
      }
      if (activeRef !== undefined && !Object.prototype.hasOwnProperty.call(vault, activeRef)) {
        const snapshotEntry = snapshot?.datasets.find((entry) => entry.name === activeRef);
        const json = snapshot ? (snapshotEntry?.json ?? null) : await db.get(activeRef);
        if (json == null) throw new Error(`活动数据集「${activeRef}」在导出期间不可读取`);
        Object.defineProperty(vault, activeRef, {
          value: json, enumerable: true, configurable: true, writable: true,
        });
        expectedVaultNames.add(activeRef);
      }
      const checkedVault = validateVault(vault);
      if (checkedVault.error) throw new Error(checkedVault.error);
      if (!sameNameSet(Object.keys(vault), expectedVaultNames)) {
        throw new Error('数据集库名称集与项目 vault 名称集不一致');
      }
      // 桌面端即使为空库也写出 vault:{}，使导入端能区分「显式空快照」与
      // 「旧版项目未携带 vault」，从而精确恢复名称集。
      base.vault = vault;
    } catch (error) {
      if (error instanceof QprojExportSizeError) throw error;
      // 完整项目不能在库读取失败时静默降级成残缺备份。
      const failure = new Error(`读取本机数据集库失败，项目未导出：${errorMessage(error)}`) as Error & {
        cause?: unknown;
      };
      failure.cause = error;
      throw failure;
    }
  }
  const encoded = JSON.stringify(base, null, 2);
  // 元数据只能做下界预判；JSON 转义、名称和结构开销必须以最终实际 UTF-8+BOM 字节数收口。
  assertQprojExportText(encoded);
  const checked = validateProjectFile(encoded);
  if (checked.file === null) throw new Error(`生成的完整项目文件未通过自校验：${checked.error}`);
  return encoded;
  } finally {
    lease.release();
  }
}

/** 导出项目文件（原生保存对话框 / 浏览器下载）。projectName 用作默认文件名。 */
export async function exportProject(appVersion: string, projectName = '质检项目'): Promise<string | null> {
  const stamp = localDateStamp(); // 与报表导出同一本地日期口径(闭环审核 P3)
  const safe = sanitizeFileName(projectName).trim() || '质检项目';
  return platform.exportFile({
    defaultName: `${safe}_${stamp}`,
    ext: 'qproj',
    filterLabel: '质量分析平台项目',
    text: await buildProjectJsonFull(appVersion),
  });
}

/** 校验并应用项目文件;成功返回 null,失败返回错误信息。应用后需整页重载。 */
export function applyProjectJson(text: string): string | null {
  const validated = validateProjectFile(text);
  if (validated.file === null) return validated.error;
  if (validated.file.stores['qp-active-ref-v1'] !== undefined) {
    return '项目包含仅存于数据集库的活动数据集，请使用完整项目导入';
  }
  const prepareError = prepareProjectMutation();
  if (prepareError) return prepareError;
  let backup: ProjectStoreBackup;
  try {
    backup = snapshotProjectStores();
  } catch {
    return '读取当前本地存储失败，项目未导入';
  }
  let staged: LoadedProjectImportJournal;
  try {
    // 保留给旧内部调用/单测的同步 API；产品 UI 使用 applyProjectText，
    // 后者在 Web 端优先把全量 journal 放进 IndexedDB。
    staged = stageProjectImportJournalSync(validated.file.stores, backup);
  } catch (error) {
    return `无法建立项目导入 journal，项目未改写：${errorMessage(error)}`;
  }
  const storeError = applyProjectStoreImage(staged.journal.target);
  if (storeError) {
    const restored = restoreProjectStores(staged.journal.previous);
    if (restored) {
      try { clearProjectImportJournalSync(); } catch (error) {
        return `写入本地存储失败（${storeError}），原项目已回滚，但 journal 未清理：${errorMessage(error)}`;
      }
      return `写入本地存储失败（${storeError}），原项目已回滚`;
    }
    return '写入本地存储失败，且原项目回滚不完整；journal 已保留，请勿继续使用当前页面';
  }
  try {
    clearProjectImportJournalSync();
  } catch (error) {
    return `项目 stores 已完整写入，但 journal 未能清理：${errorMessage(error)}`;
  }
  return null;
}

export function isProjectFile(name: string): boolean {
  return /\.qproj$/i.test(name);
}

export interface ProjectApplyResult {
  error: string | null;
  note?: string;
  /** true 表示 journal/跨层提交尚未确定收口，当前页面必须保持锁定并重启恢复。 */
  lockRequired: boolean;
}

function projectApplyFailure(error: string | null, lockRequired = false): ProjectApplyResult {
  return { error, lockRequired };
}

/**
 * 导入后的本机库快照 = vault ∪ 最近列表中带全量数据的条目。
 * 桌面完整导出为避免双份，把最近列表已内嵌全量数据的数据集从 vault 中省略；而导入对本机库
 * 是精确替换（SQLite 先清空再只插入快照）。若只按 vault 替换，这些数据集恢复后只剩
 * 最近列表里的副本，被新数据集挤出最近列表即永久丢失（fix2609 PLATFORM-01）。
 * 同名以 vault 为准；保留原型名跳过；超出库上限的最近条目不入库（仍留在最近列表）并计数。
 */
function projectLibraryEntries(
  stores: Record<string, string>,
  vaultEntries: ReadonlyArray<[string, string]>,
): { entries: Array<[string, string]>; fromRecents: number; skipped: number } {
  const entries: Array<[string, string]> = [...vaultEntries];
  const names = new Set(vaultEntries.map(([name]) => name));
  let fromRecents = 0;
  let skipped = 0;
  let recents: unknown;
  try {
    recents = stores['qp-recents-v1'] === undefined ? [] : JSON.parse(stores['qp-recents-v1']);
  } catch {
    recents = []; // validateProjectFile 已校验；这里不会失败
  }
  if (!Array.isArray(recents)) return { entries, fromRecents, skipped };
  for (const recent of recents) {
    if (!isObject(recent) || typeof recent.name !== 'string' || !isObject(recent.data)) continue;
    if (names.has(recent.name) || vaultDatasetNameError(recent.name)) continue;
    if (entries.length >= MAX_VAULT_DATASETS) {
      skipped += 1;
      continue;
    }
    names.add(recent.name);
    entries.push([recent.name, JSON.stringify(recent.data)]);
    fromRecents += 1;
  }
  return { entries, fromRecents, skipped };
}

function libraryRestoreDetail(library: { fromRecents: number; skipped: number }): string {
  const parts: string[] = [];
  if (library.fromRecents > 0) parts.push(`其中 ${library.fromRecents} 个来自最近列表内嵌的完整数据`);
  if (library.skipped > 0) parts.push(`${library.skipped} 个最近数据集因库容量上限仅保留在最近列表`);
  return parts.length > 0 ? `（${parts.join('；')}）` : '';
}

function joinNotes(...parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return kept.length > 0 ? kept.join('；') : undefined;
}

/** 完整导入:stores 写回 localStorage;文件带 vault 且本端为桌面时,把库数据集恢复进 SQLite。
 * error 非空即失败;lockRequired=true 时必须保持全局锁定直到重启恢复。 */
export async function applyProjectText(text: string): Promise<ProjectApplyResult> {
  const validated = validateProjectFile(text);
  if (validated.file === null) return projectApplyFailure(validated.error);
  const vault = validateVault(validated.file.vault);
  if (vault.error) return projectApplyFailure(vault.error);
  // 旧版文件没有 vault 字段时不应擦除本机库；新版显式 vault:{} 则表示快照就是空集。
  const hasVaultSnapshot = Object.prototype.hasOwnProperty.call(validated.file, 'vault');
  const library = projectLibraryEntries(validated.file.stores, vault.entries);
  const migrationNote = joinNotes(...validated.notes);

  const db = platform.datasetDb;
  const activeRef = validated.file.stores['qp-active-ref-v1'];
  if (activeRef !== undefined && !db) {
    return projectApplyFailure(`项目活动数据集「${activeRef}」仅存在于本机数据集库，当前环境无法完整导入`);
  }
  const prepareError = prepareProjectMutation();
  if (prepareError) return projectApplyFailure(prepareError);
  const settleError = await settleProjectMutation();
  if (settleError) return projectApplyFailure(settleError);
  const pendingRecovery = await recoverPendingProjectImport();
  if (pendingRecovery.reloadRequired) {
    return projectApplyFailure(
      pendingRecovery.error ?? '上次未完成的项目导入已恢复；请重新加载应用后再导入新项目',
      true,
    );
  }
  if (pendingRecovery.error) return projectApplyFailure(pendingRecovery.error, true);
  const atomicImport = Boolean(db && hasVaultSnapshot && hasAtomicProjectImport(db));
  const vaultBackup = new Map<string, string | null>();
  const existingVaultNames = new Set<string>();
  if (db && hasVaultSnapshot && !atomicImport) {
    // 显式 vault 是完整快照而非 upsert 补丁。在改写任何 store 前备份「已有∪导入」的
    // 全部名称，后续才能删除快照外残留且在任一失败点完整回滚。
    try {
      const metas = await db.list();
      for (const meta of metas) {
        if (typeof meta?.name !== 'string' || !meta.name) throw new Error('数据集库返回了无效名称');
        existingVaultNames.add(meta.name);
      }
      const affectedNames = new Set([...existingVaultNames, ...library.entries.map(([name]) => name)]);
      for (const name of affectedNames) {
        const original = await db.get(name);
        if (existingVaultNames.has(name) && original == null) {
          throw new Error(`数据集「${name}」在导入备份期间不可读取`);
        }
        vaultBackup.set(name, original);
      }
    } catch (error) {
      return projectApplyFailure(`读取本机数据集库失败，项目未导入：${errorMessage(error)}`);
    }
  }

  let storeBackup: ProjectStoreBackup;
  try {
    storeBackup = snapshotProjectStores();
  } catch {
    return projectApplyFailure('读取当前本地存储失败，项目未导入');
  }

  if (db && hasVaultSnapshot && atomicImport) {
    const entries = library.entries.map(([name, json]) => {
      let savedAt = new Date(0).toISOString();
      try {
        const parsed = JSON.parse(json) as { savedAt?: unknown };
        if (typeof parsed.savedAt === 'string' && parsed.savedAt) savedAt = parsed.savedAt;
      } catch { /* validateVault 已校验；这里只取展示时间 */ }
      return { name, json, savedAt };
    });
    let staged: LoadedProjectImportJournal;
    try {
      staged = await stageProjectImportJournal(validated.file.stores, storeBackup, 'before-vault');
    } catch (error) {
      return stageJournalFailure(error);
    }
    const previous = staged.journal.previous;
    let beginError: unknown = null;
    try {
      await db.beginProjectImport!(entries, JSON.stringify({
        version: 1,
        target: staged.journal.target,
        previous,
      }));
    } catch (error) {
      beginError = error;
      let pending: string | null;
      try { pending = await db.pendingProjectImport!(); } catch (statusError) {
        return projectApplyFailure(
          `SQLite 事务开始 IPC 失败，且无法确认 journal 状态：${errorMessage(statusError)}。两层 journal 已保留，请重启恢复`,
          true,
        );
      }
      if (pending === null) {
        try { await clearProjectImportJournal(staged); } catch (cleanupError) {
          return projectApplyFailure(
            `SQLite 事务未开始（${errorMessage(error)}），但 Web journal 未能清理：${errorMessage(cleanupError)}`,
            true,
          );
        }
        return projectApplyFailure(`SQLite 事务未能开始，项目未导入：${errorMessage(error)}`);
      }
      // begin 已在 SQLite 耐久，只是 IPC 丢了成功回复；继续同一恢复流程。
    }
    try {
      staged = await updateProjectImportJournal(staged, 'vault-pending');
    } catch (error) {
      const rollback = await rollbackPendingSqliteImport(
        db,
        previous,
        staged,
        `SQLite 事务已开始，但 Web journal 无法进入 vault-pending 阶段：${errorMessage(error)}`,
      );
      return projectApplyFailure(
        rollback.error ?? 'Web journal 阶段更新失败，原项目已回滚',
        !rollback.reloadRequired,
      );
    }
    const storeError = applyProjectStoreImage(staged.journal.target);
    if (storeError) {
      const rollback = await rollbackPendingSqliteImport(
        db,
        previous,
        staged,
        `写入项目本地存储失败（${storeError}）`,
      );
      return projectApplyFailure(rollback.error, !rollback.reloadRequired);
    }
    const committed = await commitPendingSqliteImport(db, staged.journal.target, previous, staged);
    if (!committed.recovered) return projectApplyFailure(committed.error, !committed.reloadRequired);
    finishProjectMutation();
    return {
      error: null,
      note: joinNotes(
        `已在单一 SQLite 事务中恢复 ${library.entries.length} 个数据集到本机数据集库${libraryRestoreDetail(library)}${beginError ? '（IPC 回复丢失已根据 journal 确认）' : ''}`,
        migrationNote,
      ),
      lockRequired: false,
    };
  }
  let staged: LoadedProjectImportJournal;
  try {
    staged = await stageProjectImportJournal(validated.file.stores, storeBackup, 'stores-only');
  } catch (error) {
    return stageJournalFailure(error);
  }
  const storeError = applyProjectStoreImage(staged.journal.target);
  if (storeError) {
    if (!restoreProjectStores(staged.journal.previous)) {
      return projectApplyFailure(`写入本地存储失败（${storeError}），且原项目回滚不完整；journal 已保留`, true);
    }
    const cleanupError = await clearRecoveredJournal(staged);
    return projectApplyFailure(
      cleanupError ?? `写入本地存储失败（${storeError}），原项目已回滚`,
      cleanupError !== null,
    );
  }
  const stagingCleanupError = await clearRecoveredJournal(staged);
  if (stagingCleanupError) return projectApplyFailure(stagingCleanupError, true);

  if (!hasVaultSnapshot) {
    finishProjectMutation();
    return { error: null, note: migrationNote, lockRequired: false };
  }
  if (!db) {
    finishProjectMutation();
    return vault.entries.length === 0
      ? { error: null, note: migrationNote, lockRequired: false }
      : {
        error: null,
        note: joinNotes(`项目内含 ${vault.entries.length} 个库数据集,仅桌面版可恢复,本次已跳过`, migrationNote),
        lockRequired: false,
      };
  }

  const attempted: string[] = [];
  const attemptedSet = new Set<string>();
  const markAttempted = (name: string) => {
    if (!attemptedSet.has(name)) { attemptedSet.add(name); attempted.push(name); }
  };
  try {
    for (const [name, json] of library.entries) {
      // 先记录再写：即使底层在部分写入后抛错，也会尝试恢复当前条目。
      markAttempted(name);
      await db.put(name, json);
    }
    const importedNames = new Set(library.entries.map(([name]) => name));
    for (const name of existingVaultNames) {
      if (importedNames.has(name)) continue;
      markAttempted(name);
      if (!await db.remove(name)) throw new Error(`无法删除项目快照外的数据集「${name}」`);
    }
    const restoredMetas = await db.list();
    if (!sameNameSet(restoredMetas.map((meta) => meta.name), importedNames)) {
      throw new Error('导入后的数据集库名称集与项目 vault 快照不一致');
    }
  } catch (error) {
    let vaultRestored = true;
    for (const name of attempted.reverse()) {
      try {
        const original = vaultBackup.get(name);
        if (original == null) await db.remove(name);
        else await db.put(name, original);
      } catch {
        vaultRestored = false;
      }
    }
    const storesRestored = restoreProjectStores(storeBackup);
    const rollback = vaultRestored && storesRestored
      ? '原项目与数据集库已回滚'
      : '回滚不完整，请勿继续使用当前页面并从备份恢复';
    return projectApplyFailure(
      `写入本机数据集库失败，项目未导入：${errorMessage(error)}；${rollback}`,
      !(vaultRestored && storesRestored),
    );
  }

  finishProjectMutation();
  return {
    error: null,
    note: joinNotes(`已恢复 ${library.entries.length} 个数据集到本机数据集库${libraryRestoreDetail(library)}`, migrationNote),
    lockRequired: false,
  };
}
