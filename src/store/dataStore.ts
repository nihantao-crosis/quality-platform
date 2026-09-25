/**
 * 活动数据集 store — 变量模型 + 计数模型（P/C）+ 文本分组列。
 * localStorage 持久化：偏好由 appStore persist,数据集与最近列表在此维护。
 */
import { create } from 'zustand';
import { markLocalWrite, watchExternalWrite } from './crossTab';
import { MAX_IMPORT_DATA_ROWS, MAX_IMPORT_CELL_CHARS, MAX_COLUMN_NAME_CHARS, MAX_DATASET_NAME_CHARS, MAX_RECENT_DATASETS, MAX_PARETO_CATEGORIES, worksheetResourceError, worksheetPendingCellsError, attributeChartResourceError,
  buildData, computeVarModel, updateVarModelCell, computePChart, computeCChart, evalFormula, truthy, FormulaError, prepareSpcData, isDoeAnalysisColumn, worksheetDisplayOrder, worksheetNumericColumnCodes, mean, stdev, capabilityWarningFingerprint,
  type VarModel, type PChartModel, type CChartModel, type TextColumn, type SpcPreparedData, type SpecLimits,
} from '../core';
import { appUnpersistedStateLabels, useApp } from './appStore';
import { sessionLog } from './sessionLog';
import { errText, platform } from '../platform/adapter';
import { reservedPrototypeNameError, hasPendingProjectImportJournal, projectStoreValidationError, recoverPendingProjectImport, registerProjectLifecycleHooks, STORAGE_SPACE_RELEASE_HINT } from '../platform/project';
import { preserveCorruptStore } from './quarantine';

const LS_DATASET = 'qp-dataset-v1';
const LS_RECENTS = 'qp-recents-v1';
const LS_ATTR = 'qp-attr-v1';
const LS_PARETO = 'qp-pareto-v1';
/** 活动数据集超出 localStorage 配额时的恢复标记(桌面端,数据在 SQLite 库中) */
const LS_ACTIVE_REF = 'qp-active-ref-v1';
/** 「另存为副本」的每个源数据集高水位；避免最近列表截断后复用旧名。 */
const LS_COPY_SEQUENCES = 'qp-copy-sequences-v1';
/** 启动时发现损坏 store 后保存原始文本，后续正常工作可覆盖 live key 而不销毁恢复证据。 */
const MAX_MES_SUBGROUPS = 200;

/** 本会话内所有已见数据集名（包括已从最近列表滑出的名称）。 */
const knownDatasetNames = new Set<string>();
/** 演示表首次编辑是同步 API；候选名在首次只插入确认前始终带持久化保护标记。 */
const unclaimedCopyNames = new Set<string>();
const sessionClaimedCopyNames = new Set<string>();
/**
 * 本会话由确定性派生(子集/标准化/转置/堆叠，modelOptions.derivedFrom)写入、此后未经编辑的数据集：
 * 名称 → { 写入时的 savedAt, 源表签名 }。只有最近列表中同名条目的 savedAt 仍与之相同(编辑、撤销、
 * 另一窗口改写都会换 savedAt)、且本次派生的源表签名与记录一致(源表未被编辑)，才算「原样结果」。
 * 文件导入、剪贴板粘贴、DOE、随机数据不可由同一操作重新得到，从不登记(fix2609d G4c)。
 * 不落盘：重启后一律视为可能已编辑，按改名策略保守处理。
 */
const pristineDatasets = new Map<string, { savedAt: string; source: string }>();
let lastWorksheetStamp = 0;

interface StoredDataset {
  name: string;
  colNames: string[];
  rows: number[][];
  textCols: TextColumn[];
  /** 尚未录入的占位单元格；与数值分离，允许“实测值确为 0”。 */
  pendingCells?: PendingCell[];
  /** 历史恢复/内置研究需要保留的模型语义；普通导入省略。 */
  isDemo?: boolean;
  /** 仅当 I-MR 序列不同于 rows 行优先展平值时保存，避免普通数据重复占空间。 */
  indivSeries?: number[];
  savedAt: string;
  /** 首次创建未确认；重启/项目恢复后仍不能退化为同名 upsert。 */
  vaultInsertOnly?: true;
}

export interface DatasetModelOptions {
  isDemo?: boolean;
  indivSeries?: number[];
  /** 仅用于“另存为副本”等列结构完全不变的切换；普通导入必须清除旧 SPC 角色。 */
  preserveSpcRoles?: boolean;
  /** 历史恢复/同结构副本会在随后回放规格；普通同名重导入必须忘掉旧内容的规格。 */
  preserveSpecs?: boolean;
  /** restore 前安全副本：活动槽只尝试 localStorage，不发普通 vault 镜像；随后由不可合并 put 独立确认。 */
  independentRecoveryCopy?: boolean;
  /**
   * 同名数据集写入策略(STORE-04/UI-04):派生(子集/标准化/转置/堆叠/随机)、文件/剪贴板导入、
   * 工作表粘贴、DOE 等「新建类」入口置 'rename'——目标名已被内容不同(或内容无法核对)的数据集占用时
   * 改名为「名 (2)」写入，绝不整键覆盖旧数据集(最近列表/本机库/撤销栈/规格记忆)。
   * 唯一例外见 derivedFrom。省略时保持按名替换语义(回看快照、另存副本等调用方已自行保证名称语义)。
   */
  onNameConflict?: 'rename';
  /**
   * 确定性派生(子集/标准化/转置/堆叠)的源表签名(derivationSourceStamp，名称+内容指纹)。只有带此签名的
   * 'rename' 写入才登记「原样结果」：之后同一源表(内容未变)再做同一派生、且旧结果未经编辑时按名替换(沿用其规格记忆，
   * 结果带 replacedPristine 供提示)。Web 端专用——桌面端被挤出条目已有只插入归档，一律改名。
   */
  derivedFrom?: string;
  /**
   * Web 端挤出确认的操作标识(fix2609d G4c)：省略时用请求名。请求名每次都会变的入口(DOE 名含时间戳)
   * 必须传稳定值(如 'doe-create')，否则「60 秒内再次执行同一操作」永远对不上。
   */
  confirmKey?: string;
  /**
   * Web 端(无本机库)新建类写入会把某数据集挤出最近列表时，默认先拒绝并提示备份(fix2609b M1)。
   * 用户确认后由调用方带 true 重试；同一操作 60 秒内再次执行也视为确认。
   */
  allowEviction?: boolean;
}

/** Web 端新建类写入会把数据集挤出最近列表(浏览器端无法恢复)，等待用户确认。 */
export class DatasetEvictionError extends Error {
  readonly evicted: string[];
  constructor(message: string, evicted: string[]) {
    super(message);
    this.name = 'DatasetEvictionError';
    this.evicted = evicted;
  }
}

export interface PendingCell { row: number; col: number }

/** 派生数据集(转置/堆叠)的写入结果：name 为实际名称(同名改名时带序号)，requested 为请求名。 */
export interface DerivedDatasetResult { name: string; requested: string; outcome: PersistOutcome }

export interface ParetoRow { name: string; count: number }
export interface ParetoModel { name: string; rows: ParetoRow[] }

export interface RecentEntry {
  name: string;
  savedAt: string;
  /** 完整数据。桌面端条目过大导致配额超限时持久化为轻量条目(数据在 SQLite 库),加载时回落。 */
  data?: StoredDataset;
}

const DEMO_COLS = ['直径1', '直径2', '直径3', '直径4', '直径5'];

function demoInit(): { model: VarModel; p: PChartModel; c: CChartModel } {
  const D = buildData();
  const model = computeVarModel('质检数据.mtw', DEMO_COLS, D.subs.map((s) => s.vals), {
    indivSeries: D.indiv,
    isDemo: true,
  });
  return {
    model,
    p: computePChart(D.pdef, D.pN, '演示 · 装配线不良', true),
    c: computeCChart(D.cdata, '演示 · 表面缺陷', true),
  };
}

let quarantineWarned = false;
let quarantineFailureWarned = false;
const protectedCorruptStores = new Map<string, { raw: string; detail: string }>();
/** localStorage 落盘失败时仍供 .qproj 完整导出的最新内存快照。 */
const dirtyProjectStores = new Map<string, string>();
/**
 * 本窗口最后一次成功写入或启动读入的 LS_DATASET 原文(fix2609m A1)。dropStaleActiveSlot 只在 live 值与它逐字相等
 * (即槽里确实是本窗口自己的旧副本)时才删除；另一窗口刚写入的同名更新版本是它唯一的落盘副本，绝不能当过时副本删掉。
 */
let ownActiveSlotRaw: string | null = null;

function quarantineCorruptStore(key: string, raw: string, detail: string): boolean {
  const preserved = preserveCorruptStore(key, raw, detail);
  if (!preserved) protectedCorruptStores.set(key, { raw, detail });
  if (preserved) {
    protectedCorruptStores.delete(key);
  }
  if (preserved && !quarantineWarned) {
    quarantineWarned = true;
    try {
      useApp.getState().showToast('检测到损坏的本地数据，原始文本已保留在隔离区；请导入项目备份或在“选项”中确认清除');
    } catch { /* 非浏览器环境忽略 */ }
  }
  if (!preserved && !quarantineFailureWarned) {
    quarantineFailureWarned = true;
    try {
      useApp.getState().showToast('检测到损坏的本地数据，但存储已满、暂时无法复制到隔离区；已禁止覆盖原值，请先释放空间或确认清除');
    } catch { /* 非浏览器环境忽略 */ }
  }
  return preserved;
}

/**
 * localStorage 既可能被旧版本、手工编辑或中断写入污染，也可能来自导入的 .qproj。
 * 启动恢复与项目导入必须共用同一套字段级校验；损坏值只被隔离，不在后台静默删除，
 * 以便用户仍可从项目备份或桌面数据集库恢复原始数据。
 */
/**
 * 把 JSON 解析出来的普通对象转成 **null 原型** 查表(盲审 P2)。
 * `map[model.name]` 这种按用户输入取值的写法,在名字是 `__proto__`/`constructor`/
 * `toString` 等 Object.prototype 成员时会命中原型链:`saved` 被判为真,展开出一个
 * 没有 lsl/tgt/usl 的对象,于是**静默沿用上一个数据集的规格**(能力分析直接算错)。
 * 只在这一处收口,五个 SpecMap 读取点全部受益。
 */
export function toLookupMap<T>(raw: unknown): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, T>)) out[k] = v;
  }
  return out;
}

export function loadValidatedStoreJson<T>(key: string): T | null {
  let text: string | null;
  try { text = localStorage.getItem(key); } catch { return null; }
  if (text == null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    quarantineCorruptStore(key, text, 'JSON 解析失败或写入被截断');
    return null;
  }
  const detail = projectStoreValidationError(key, raw);
  if (detail) {
    quarantineCorruptStore(key, text, detail);
    return null;
  }
  return raw as T;
}

interface NormalizedImportColumns {
  colNames: string[];
  textCols: TextColumn[];
  changed: boolean;
}

/**
 * 导入 API 历史上返回 void，直接拒绝会让旧 UI 在成功提示之前抛出未捕获异常。
 * 因此在 store 边界做稳定、可见的规范化：空名换成 C#/T#，重名按出现顺序追加 (2)/(3)。
 * 数值列与文本列共用同一名称空间，避免后续 indexOf(name) 串列。
 */
function normalizeImportColumns(colNames: string[], textCols: TextColumn[]): NormalizedImportColumns {
  const used = new Set<string>();
  let changed = false;
  const unique = (raw: string, fallback: string) => {
    const trimmed = raw.trim();
    const base = trimmed || fallback;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base} (${suffix++})`;
    used.add(candidate);
    if (candidate !== raw) changed = true;
    return candidate;
  };
  const numeric = colNames.map((name, index) => unique(name, `C${index + 1}`));
  const text = textCols.map((column, index) => ({
    ...column,
    name: unique(column.name, `T${index + 1}`),
    values: [...column.values],
  }));
  return { colNames: numeric, textCols: text, changed };
}

function nextUniqueColumnName(base: string, used: Iterable<string>): string {
  const names = new Set(used);
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} (${suffix})`)) suffix++;
  return `${base} (${suffix})`;
}

let storageWarned = false;
/**
 * 备份指引的唯一口径(fix2609b M4)：文件菜单里真实存在的入口是「保存项目文件…」（Ctrl+S）；
 * 「导出项目汇总…」只是汇总报表，不能恢复数据，文案绝不能把用户引到那里。
 */
export const PROJECT_BACKUP_HINT = '「文件 → 保存项目文件…」（Ctrl+S）';

/** 同名改名后，原冲突数据集写入完成时的实际位置(提示按此生成，不写死「保留在最近列表」)。 */
export type ConflictDatasetLocation = 'recents' | 'vault' | 'lost';

/** P0-5:持久化结果契约——只有 persisted=true 才允许 UI 显示绿色成功。 */
export interface PersistOutcome {
  persisted: boolean;
  archiving: boolean;
  /** 实际写入的数据集名；onNameConflict='rename' 改名时与请求名不同，调用方提示须以此为准。 */
  name?: string;
  /** 本次写入把哪些数据集挤出了最近列表(桌面端已补入本机库；Web 端无法恢复)。 */
  evicted?: string[];
  /** 改名写入时，原同名数据集现在的位置：最近列表 / 本机数据集库 / 已移出(Web 端不可恢复)。 */
  conflictLocation?: ConflictDatasetLocation;
  /** 按名替换了本会话未经编辑的同名派生结果(源表未变，可由同一操作重新得到)；提示须明示。 */
  replacedPristine?: boolean;
  /** SQLite 归档的真实完成承诺。archiving 只表示已发起，覆盖数据前必须 await 此承诺。 */
  durability?: Promise<void>;
  /** 校验拒绝原因(第三轮 P3):调用方据此区分「被拒」与「存储空间不足」,不再错报 */
  rejected?: string;
  /** 写入口过滤掉的非法行数,toast 如实告知 */
  droppedRows?: number;
}

interface RequiredVaultSnapshot { data: StoredDataset; bytes: number }
/**
 * localStorage 超限后仍必须保全的精确快照。按数据集名保留 latest，
 * 不能用一个全局 active 槽位：A 归档失败后切到 B，B 的本地保存成功不得清掉 A。
 */
const requiredVaultSnapshots = new Map<string, RequiredVaultSnapshot>();
let requiredVaultSnapshotBytes = 0;
/** 有界 map 装不下当前快照时的唯一溢出槽；清空前禁止替换数据集。 */
let overflowRequiredVaultSnapshot: RequiredVaultSnapshot | null = null;
let currentActiveUnpersistedFlag = false;
let recentsUnpersistedFlag = false;
let recentsPersistenceWarned = false;
/** 分析回看专用副本已用唯一名称独立写入 SQLite，可安全继续目标恢复。 */
let independentlyDurableRecoveryCopy: string | null = null;
let activeUnpersistedFlag = false;
interface PendingCellPersistence { data: StoredDataset; recents: RecentEntry[] }
let pendingCellPersistence: PendingCellPersistence | null = null;
let pendingCellPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 最近列表只能落下轻量引用时，对应活动表在 SQLite durable 前不得切换。
 * Map 按名称保留 latest 对象引用，迟到旧 put 不能释放新版本的闸门。
 */
const lightweightRecentDurability = new Map<string, StoredDataset>();

function syncActiveUnpersisted(): void {
  const next = currentActiveUnpersistedFlag
    || recentsUnpersistedFlag
    || requiredVaultSnapshots.size > 0
    || overflowRequiredVaultSnapshot !== null
    || lightweightRecentDurability.size > 0;
  if (activeUnpersistedFlag === next) return;
  activeUnpersistedFlag = next;
  try { useData.setState({ activeUnpersisted: next }); } catch { /* store 尚未就绪时忽略 */ }
}

/** 设置当前活动表状态；全局警告还会受其他数据集的必保快照维持。 */
function setActiveUnpersisted(v: boolean) {
  currentActiveUnpersistedFlag = v;
  syncActiveUnpersisted();
}

function setRecentsUnpersisted(v: boolean): void {
  recentsUnpersistedFlag = v;
  try { useData.setState({ recentsUnpersisted: v }); } catch { /* store 尚未就绪时忽略 */ }
  syncActiveUnpersisted();
  if (!v) {
    recentsPersistenceWarned = false;
    independentlyDurableRecoveryCopy = null;
    return;
  }
  sessionLog(`最近数据集列表未能持久化 · 活动表仍为权威版本，离开前请${PROJECT_BACKUP_HINT}备份`);
  if (recentsPersistenceWarned) return;
  recentsPersistenceWarned = true;
  try {
    useApp.getState().showToast(`最近数据集列表未能保存（浏览器存储空间不足）；当前活动表仍为最新版本，请尽快${PROJECT_BACKUP_HINT}备份，腾出空间前将暂停切换其他数据集`);
  } catch { /* 非 UI 环境忽略 */ }
}
/**
 * 跨窗口协调发现本窗口内存最近列表(含未落盘的活动表)与磁盘不一致(fix2609f G4d)：只置位闸门标志，
 * 不弹提示、不写盘(写盘由闸门在用户下一次切换时重试，避免监听器内回写造成乒乓)。
 */
function markRecentsDivergedSilently(): void {
  if (recentsUnpersistedFlag) return;
  recentsUnpersistedFlag = true;
  try { useData.setState({ recentsUnpersisted: true }); } catch { /* store 尚未就绪时忽略 */ }
  syncActiveUnpersisted();
  sessionLog('另一窗口更新了最近数据集列表，本窗口未落盘的活动表只在内存；切换数据集前将重试保存');
}

/**
 * 最近列表刚落盘成功时，Web 端活动槽若仍未落盘则顺带重试一次(fix2609f G4d)：使共享 LS_DATASET 与
 * 最近列表一致，另一窗口按 LS_DATASET 协调时得到相同内容，不会把本窗口的编辑回退。
 * 桌面端活动槽有 SQLite 归档管线兜底，不在此重复入队。返回活动槽是否已与内存一致(无需重试也算)。
 *
 * fix2609i G15:重试仍写不下时(全局配额下腾出空间 Δ≤S<2Δ 即可触发)，LS_DATASET 里残留的是同名旧版，
 * 而启动协调与另一窗口的「标志为假」协调分支都把 LS_DATASET 当权威——切换到同样写不下的表后，
 * 本窗口的编辑会被对端回退、或刷新时被旧版覆盖。此时若刚落盘的 LS_RECENTS 已含活动表的精确版本，
 * 就删除这份过时副本：最新版只在最近列表里，两处协调都会取它，还顺带腾出空间。
 */
function retryUnpersistedActive(): boolean {
  if (!currentActiveUnpersistedFlag || platform.datasetDb) return true;
  const activeData = inMemoryActiveDataset(useData.getState());
  if (!activeData) return true;
  if (persistActive(activeData).persisted) return true;
  dropStaleActiveSlot(activeData);
  return false;
}

/** 解析 localStorage 中的 JSON；缺失/损坏返回 undefined(损坏值由各自的启动校验负责隔离)。 */
function peekStoredJson(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text == null ? undefined : JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Web 端活动槽写不下时，删除 LS_DATASET 中的同名旧版(fix2609i G15)。条件缺一不删：
 * - LS_DATASET 的原文与本窗口最后一次成功写入/启动读入的原文逐字相等(fix2609m A1)：两窗口开同一张表时，
 *   另一窗口刚成功写入的同名更新版本是它唯一的落盘副本(对端 activeUnpersisted 为假、离开不拦截)，
 *   不得当作本窗口的过时副本删除；此时交给既有的跨窗口协调/闸门路径处理；
 * - LS_DATASET 当前确实是同名、且与内存活动表版本不同的合法数据集(别名/同版/损坏都不动)；
 * - 磁盘上的 LS_RECENTS 已含活动表的精确版本(× 移除活动表本身等情形下旧版是唯一落盘副本，必须保留)。
 * 删槽后内存活动表重新登记为项目导出覆盖项：removeJson 会作废 LS_DATASET 的 dirty 载荷，
 * 否则立即导出的 .qproj 缺 qp-dataset-v1(G15 复审 P3，写读对称)。
 */
function dropStaleActiveSlot(activeData: StoredDataset): boolean {
  let liveRaw: string | null;
  try { liveRaw = localStorage.getItem(LS_DATASET); } catch { return false; }
  if (liveRaw === null || liveRaw !== ownActiveSlotRaw) return false;
  const slot = peekStoredJson(LS_DATASET);
  if (slot === undefined || projectStoreValidationError(LS_DATASET, slot)) return false;
  const slotData = slot as StoredDataset;
  if (slotData.name !== activeData.name || sameStoredDatasetVersion(slotData, activeData)) return false;
  const recents = peekStoredJson(LS_RECENTS);
  if (!Array.isArray(recents) || projectStoreValidationError(LS_RECENTS, recents)) return false;
  const onDisk = (recents as RecentEntry[]).find((entry) => entry.name === activeData.name)?.data;
  if (!onDisk || !sameStoredDatasetVersion(onDisk, activeData)) return false;
  if (!removeJson(LS_DATASET)) return false;
  try { dirtyProjectStores.set(LS_DATASET, JSON.stringify(activeData)); } catch { /* 序列化失败时导出回落为最近列表中的同一版本 */ }
  const detail = `数据集「${activeData.name}」的最新版本已保存在最近列表，但活动槽写不下（浏览器存储空间不足）；`
    + `已移除活动槽里的旧版本，避免刷新或另一窗口把编辑回退。刷新后请从左侧「最近数据集」重新打开「${activeData.name}」`;
  sessionLog(detail);
  try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
  return true;
}

/** 项目导入成功后旧内存数据注定被替换——上遮罩重载前清除未持久化标记,避免 beforeunload 拦截自动重载。 */
export function markActiveDataReplaced(): void {
  setRecentsUnpersisted(false);
  setActiveUnpersisted(false);
  // fix2609j STORE-10:项目已整体写入并即将重载，旧会话写不下的计数/帕累托/规格载荷同样作废，
  // 否则离开拦截会挡住自动重载。
  dirtyProjectStores.clear();
}

/**
 * 仅落在 localStorage、没有本机库兜底的业务键(fix2609j STORE-10)。写入失败后最新值只在内存
 * (dirtyProjectStores)，离开页面即丢失。活动表/最近列表由 activeUnpersistedFlag 统一建模
 * (桌面端 SQLite 兜底成功时 dirty 载荷仍保留供导出，但数据并未丢失)，不在此重复计入。
 */
const LOCAL_ONLY_STORE_LABELS: ReadonlyMap<string, string> = new Map([
  [LS_ATTR, 'P/C 计数数据'],
  [LS_PARETO, '帕累托数据'],
  ['qp-specs-v1', '规格限记忆'],
]);
/** 其它 store(如鱼骨图)登记的「未持久化」探针：label → 是否仍只在内存。 */
const unpersistedStateProbes = new Map<string, () => boolean>();

/** 其它 store 把自己的「写入失败、仅在内存」状态纳入离开拦截(与 hasUnpersistedState 同一判定)。 */
export function registerUnpersistedStateProbe(label: string, probe: () => boolean): void {
  unpersistedStateProbes.set(label, probe);
}

/** 当前尚未写入本地存储(离开页面会丢失)的数据类别，供离开拦截与界面提示共用。 */
export function unpersistedStateLabels(): string[] {
  const labels: string[] = [];
  if (activeUnpersistedFlag) labels.push('当前工作表/最近数据集');
  for (const key of dirtyProjectStores.keys()) {
    const label = LOCAL_ONLY_STORE_LABELS.get(key);
    if (label && !labels.includes(label)) labels.push(label);
  }
  for (const label of appUnpersistedStateLabels()) if (!labels.includes(label)) labels.push(label);
  for (const [label, probe] of unpersistedStateProbes) {
    try { if (probe() && !labels.includes(label)) labels.push(label); } catch { /* 探针异常按已持久化处理 */ }
  }
  return labels;
}

/**
 * 离开页面前是否仍有只在内存中的数据(fix2609j STORE-10)。Web beforeunload 与桌面关窗拦截共用：
 * 活动表/最近列表/必保快照 + AQL 账本/界面参数/计数/帕累托/规格/已登记探针。
 */
export function hasUnpersistedState(): boolean {
  return unpersistedStateLabels().length > 0;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    // 单格编辑为避免连续输入时重复序列化 20 万行，会极短合并。
    // 离开前先做一次同步落盘尝试；失败则下方未保存警告仍会阻止。
    flushPendingCellPersistence();
    const labels = unpersistedStateLabels();
    if (labels.length === 0) return;
    e.preventDefault();
    e.returnValue = `当前数据尚未持久化（${labels.join('、')}），离开将丢失；请先${PROJECT_BACKUP_HINT}备份。`;
  });
}

function saveJson(key: string, v: unknown, silent = false): boolean {
  let encoded: string;
  try { encoded = JSON.stringify(v); } catch { return false; }
  const protectedEntry = protectedCorruptStores.get(key);
  if (protectedEntry) {
    let live: string | null = protectedEntry.raw;
    try { live = localStorage.getItem(key); } catch { /* 使用已捕获原文重试 */ }
    if (live == null) {
      // 用户已明确清除 live key，允许写入新值。
      protectedCorruptStores.delete(key);
    } else if (!quarantineCorruptStore(key, live, protectedEntry.detail)) {
      return false;
    }
  }
  try {
    localStorage.setItem(key, encoded);
    markLocalWrite(key, encoded);
    if (key === LS_DATASET) ownActiveSlotRaw = encoded;
    dirtyProjectStores.delete(key);
    storageWarned = false;
    return true;
  } catch {
    dirtyProjectStores.set(key, encoded);
    // 存储超限(浏览器 localStorage 通常约 5MB)：应用继续在内存工作。
    // silent=true 时由调用方接管提示(桌面端会转投 SQLite 数据集库)。
    if (!silent && !storageWarned) {
      storageWarned = true;
      sessionLog(`本地存储写入失败(可能超限)· 数据仍在内存,建议${PROJECT_BACKUP_HINT}备份`);
      try {
        useApp.getState().showToast(`本地存储已满,本次未自动保存;请用${PROJECT_BACKUP_HINT}备份为项目文件`);
      } catch { /* 非浏览器环境忽略 */ }
    }
    return false;
  }
}

/**
 * 与 saveJson 对称的删除入口(fix2609b M3)。业务键的删除同样要维护三份簿记：
 * - protectedCorruptStores:live 仍是未能隔离的损坏原文时拒绝删除(那是唯一恢复证据)；
 * - dirtyProjectStores:此前配额失败留下的旧载荷必须随删除作废，否则 .qproj 导出会让已清空的内容复活；
 * - markLocalWrite:登记本窗口的删除，避免 storage 事件把自己的删除当成外部写入回灌。
 */
function removeJson(key: string): boolean {
  const protectedEntry = protectedCorruptStores.get(key);
  if (protectedEntry) {
    let live: string | null = protectedEntry.raw;
    try { live = localStorage.getItem(key); } catch { /* 使用已捕获原文重试 */ }
    if (live == null) {
      protectedCorruptStores.delete(key);
    } else if (!quarantineCorruptStore(key, live, protectedEntry.detail)) {
      const detail = `本地数据「${key}」是尚未成功隔离的损坏原文，已拒绝删除以保留恢复证据；请先释放存储空间或在「工具 → 选项」确认清除`;
      sessionLog(detail);
      try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
      return false;
    }
  }
  dirtyProjectStores.delete(key);
  try {
    markLocalWrite(key, null);
    localStorage.removeItem(key);
    if (key === LS_DATASET) ownActiveSlotRaw = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * 数据集名称的同一性口径(fix2609j STORE-15)：最近列表校验(recentsValidationError)按 trim 后判重，
 * 写入侧的去重/占用判定必须同口径，否则只差首尾空格的两个名称会被写成两条、再被校验判为重名损坏。
 */
function sameDatasetName(a: string, b: string): boolean {
  return a === b || a.trim() === b.trim();
}

type CopySequenceMap = Record<string, number>;

function copyBaseOf(name: string): string {
  // 统一剥离扩展名(闭环审核 P3):编辑路径与「另存为副本」路径此前基名口径不同
  return name.replace(/ \(副本\d*\)$/, '').replace(/\.[^.]+$/, '');
}

function copySequenceOf(name: string, base: string): number | null {
  const prefix = `${base} (副本`;
  if (!name.startsWith(prefix) || !name.endsWith(')')) return null;
  const suffix = name.slice(prefix.length, -1);
  if (suffix === '') return 1;
  return /^\d+$/.test(suffix) && Number(suffix) >= 2 ? Number(suffix) : null;
}

function allocateCopyName(sourceName: string, currentNames: Iterable<string>): string {
  const suffixReserve = ` (副本${Number.MAX_SAFE_INTEGER})`.length;
  const base = copyBaseOf(sourceName).slice(0, MAX_DATASET_NAME_CHARS - suffixReserve).trim() || '数据集';
  const names = new Set([...knownDatasetNames, ...currentNames]);
  const sequences = loadValidatedStoreJson<CopySequenceMap>(LS_COPY_SEQUENCES) ?? {};
  let sequence = Number.isInteger(sequences[base]) && sequences[base] > 0 ? sequences[base] : 0;
  for (const name of names) {
    const seen = copySequenceOf(name, base);
    if (seen != null) sequence = Math.max(sequence, seen);
  }
  let candidate: string;
  do {
    sequence++;
    candidate = sequence === 1 ? `${base} (副本)` : `${base} (副本${sequence})`;
  } while (names.has(candidate));
  sequences[base] = sequence;
  saveJson(LS_COPY_SEQUENCES, sequences, true);
  knownDatasetNames.add(candidate);
  return candidate;
}

function allocateWorksheetName(currentNames: Iterable<string>): string {
  const names = new Set([...knownDatasetNames, ...currentNames]);
  let stamp = Math.max(Date.now(), lastWorksheetStamp + 1);
  let candidate = `新建工作表_${stamp}`;
  while (names.has(candidate)) candidate = `新建工作表_${++stamp}`;
  lastWorksheetStamp = stamp;
  knownDatasetNames.add(candidate);
  return candidate;
}

/** 数据集内容(用于同名写入策略的逐值比对)。 */
interface DatasetContent {
  colNames: string[];
  rows: number[][];
  textCols: TextColumn[];
  pendingCells: PendingCell[];
}

function sameDatasetContent(a: DatasetContent, b: DatasetContent): boolean {
  if (a.colNames.length !== b.colNames.length || a.rows.length !== b.rows.length
    || a.textCols.length !== b.textCols.length || a.pendingCells.length !== b.pendingCells.length) return false;
  if (a.colNames.some((name, index) => name !== b.colNames[index])) return false;
  for (let i = 0; i < a.rows.length; i++) {
    const ra = a.rows[i];
    const rb = b.rows[i];
    if (!Array.isArray(ra) || !Array.isArray(rb) || ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) if (ra[j] !== rb[j]) return false;
  }
  for (let t = 0; t < a.textCols.length; t++) {
    const ca = a.textCols[t];
    const cb = b.textCols[t];
    if (ca.name !== cb.name || ca.values.length !== cb.values.length) return false;
    if (ca.values.some((value, index) => value !== cb.values[index])) return false;
  }
  const pending = new Set(a.pendingCells.map(({ row, col }) => `${row}:${col}`));
  return b.pendingCells.every(({ row, col }) => pending.has(`${row}:${col}`));
}

/**
 * 某名称当前占用情况：undefined=无人占用；null=已占用但内容无法同步核对
 * (桌面端轻量最近条目、已滑出最近列表但仍在本机库的数据集)；否则为可比对内容。
 * 活动表以内存 model 为权威(含尚未落盘的编辑)，优先于同名最近条目。
 */
function occupiedDatasetContent(name: string, st: DataState): DatasetContent | null | undefined {
  if (sameDatasetName(st.model.name, name)) {
    return {
      colNames: st.model.colNames,
      rows: st.model.subs.map((subgroup) => subgroup.vals),
      textCols: st.textCols,
      pendingCells: st.pendingCells,
    };
  }
  const recent = st.recents.find((entry) => sameDatasetName(entry.name, name));
  if (recent) {
    return recent.data
      ? { colNames: recent.data.colNames, rows: recent.data.rows, textCols: recent.data.textCols ?? [], pendingCells: recent.data.pendingCells ?? [] }
      : null;
  }
  // Web 端滑出最近列表的数据集已无任何落盘位置；桌面端仍在本机 SQLite 库中(按名 upsert)。
  if (platform.datasetDb && knownDatasetNames.has(name)) return null;
  return undefined;
}

/** 「report.csv」→ stem「report」+ ext「.csv」；扩展名须以字母开头，避免把「N(10,1.5)」的小数误当扩展名。 */
function splitDatasetName(name: string): { base: string; ext: string } {
  const matched = /^(.+?)(\.[A-Za-z][A-Za-z0-9]{0,7})$/.exec(name);
  const stem = matched ? matched[1] : name;
  const ext = matched ? matched[2] : '';
  // 已带「 (n)」序号的名称按同一基名续号，不叠成「名 (2) (2)」。
  const numbered = / \((\d+)\)$/.exec(stem);
  const base = numbered && Number(numbered[1]) >= 2 ? stem.slice(0, -numbered[0].length) : stem;
  return { base, ext };
}

/** 「report.csv」+2 →「report (2).csv」；名称长度受上限约束。 */
function numberedDatasetName(requested: string, sequence: number): string {
  const { base, ext } = splitDatasetName(requested);
  const suffix = ` (${sequence})${ext}`;
  return `${base.slice(0, Math.max(1, MAX_DATASET_NAME_CHARS - suffix.length)).trimEnd() || '数据集'}${suffix}`;
}

/**
 * 确定性派生的源表签名：活动表名 + 内容指纹(列名、数值逐位、文本列、待录入格；双 32 位哈希)。
 * 按内容而非 savedAt(毫秒分辨率，同毫秒内的编辑会撞)判定「源表未变」：源表被编辑过即签名不同；
 * 改回完全相同的内容则派生结果确实可由同一操作重新得到。
 */
function derivationSourceStamp(st: DataState): string | undefined {
  // 桌面端不登记原样结果(被挤出条目有只插入归档，一律改名)，不为大表白算指纹。
  if (platform.datasetDb) return undefined;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  const mix = (value: number) => {
    h1 = Math.imul(h1 ^ value, 0x01000193);
    h2 = Math.imul(h2 ^ value, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  };
  const text = (value: string) => {
    mix(value.length);
    for (let i = 0; i < value.length; i++) mix(value.charCodeAt(i));
  };
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const m = st.model;
  text(m.name);
  mix(m.colNames.length);
  m.colNames.forEach(text);
  mix(m.subs.length);
  for (const subgroup of m.subs) {
    mix(subgroup.vals.length);
    for (const value of subgroup.vals) {
      f64[0] = value;
      mix(u32[0]);
      mix(u32[1]);
    }
  }
  mix(st.textCols.length);
  for (const column of st.textCols) {
    text(column.name);
    mix(column.values.length);
    column.values.forEach(text);
  }
  mix(st.pendingCells.length);
  for (const cell of st.pendingCells) { mix(cell.row); mix(cell.col); }
  return `${m.name}\u0000${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

/**
 * 旧同名数据集是否为本会话同一源表(签名未变)的确定性派生、此后未经编辑的原样结果(可由同一操作重新得到)。
 * 文件导入/粘贴/DOE/随机数据没有 derivedFrom，桌面端有只插入归档，两者都一律改名。
 */
function isPristineDataset(name: string, st: DataState, derivedFrom: string | undefined): boolean {
  if (derivedFrom === undefined || platform.datasetDb) return false;
  const marker = pristineDatasets.get(name);
  if (marker === undefined || marker.source !== derivedFrom) return false;
  const recent = st.recents.find((entry) => entry.name === name);
  return recent?.data !== undefined && recent.savedAt === marker.savedAt && recent.data.savedAt === marker.savedAt;
}

/**
 * 同名数据集写入策略的唯一实现(STORE-04/UI-04)。
 * - 名称空闲 → 原名；
 * - 名称被内容完全相同的数据集占用 → 原名(重复同一操作不制造「(2)(3)…」挤占最近列表上限)；
 * - 名称被本会话同一源表(未编辑)的同一确定性派生写入、此后未经编辑的原样结果占用 → 原名按名替换
 *   (fix2609b M1 / fix2609d G4c：只限 Web 端带 derivedFrom 的派生；不为可重新得到的结果多占最近列表位)；
 * - 名称被已编辑、或内容无法核对的数据集占用 → 依次尝试「名 (2)」「名 (3)」…，同样复用内容相同者，
 *   取第一个空闲名。旧数据集及其编辑、本机库记录、规格记忆均不受影响。
 */
function resolveDatasetWriteName(
  requested: string, incoming: DatasetContent, st: DataState, derivedFrom?: string,
): { name: string; identical: boolean; replacedPristine?: boolean } {
  const occupiedBy = (name: string) => occupiedDatasetContent(name, st);
  const first = occupiedBy(requested);
  if (first === undefined) return { name: requested, identical: false };
  if (first !== null && sameDatasetContent(first, incoming)) return { name: requested, identical: true };
  if (isPristineDataset(requested, st, derivedFrom)) return { name: requested, identical: false, replacedPristine: true };
  for (let sequence = 2; ; sequence++) {
    const candidate = numberedDatasetName(requested, sequence);
    if (candidate === requested || reservedPrototypeNameError(candidate)) continue;
    const occupied = occupiedBy(candidate);
    if (occupied === undefined) return { name: candidate, identical: false };
    if (occupied !== null && sameDatasetContent(occupied, incoming)) return { name: candidate, identical: true };
    // fix2609f G4d：编号候选同样可能是同一源表(未变)的原样派生结果——先派生、再清洗源表、再换条件派生
    // 的常见流程里，应替换「名 (2)」而不是续号 (3)(4)… 挤满最近列表。
    if (isPristineDataset(candidate, st, derivedFrom)) return { name: candidate, identical: false, replacedPristine: true };
  }
}

interface DataState {
  /** P0-5:活动数据仅存在内存、未成功持久化(刷新会丢)。 */
  activeUnpersisted: boolean;
  /** 活动表虽已写入，但同名最近入口未同步；启动协调完成前不得视为完整持久化。 */
  recentsUnpersisted: boolean;
  model: VarModel;
  textCols: TextColumn[];
  pModel: PChartModel;
  cModel: CChartModel;
  /** 帕累托数据(类别+频数);null = 未导入(页面显示空态/示例) */
  paretoModel: ParetoModel | null;
  /** 显式待录入单元格，不依赖列名或占位数值。 */
  pendingCells: PendingCell[];
  recents: RecentEntry[];
  mesRunning: boolean;
  /** 编辑历史（撤销/重做,仅覆盖手工编辑） */
  undoStack: EditSnapshot[];
  redoStack: EditSnapshot[];
  /** 最近一次入撤销栈时是否被字节预算(而非 20 层上限)裁剪；菜单据此标明可撤销层数受大表内存预算限制。 */
  undoBudgetLimited: boolean;
  importMatrix(
    name: string,
    colNames: string[],
    rows: number[][],
    textCols?: TextColumn[],
    pendingCells?: PendingCell[],
    modelOptions?: DatasetModelOptions,
  ): PersistOutcome;
  /** 追加或覆盖分析输出列；数值列与文本列均按当前工作表行对齐并纳入撤销/持久化。 */
  writeAnalysisColumns(
    numericColumns: { name: string; values: number[] }[],
    textColumns?: TextColumn[],
  ): boolean;
  importCounts(kind: 'p' | 'c', name: string, counts: number[], sampleSize?: number | number[]): PersistOutcome;
  /** 导入帕累托「类别+频数」数据并持久化 */
  importPareto(name: string, rows: ParetoRow[]): PersistOutcome;
  /** 清除活动帕累托数据（旧分析记录无法重建时用于避免误显当前数据）。 */
  clearPareto(): void;
  /** 加载成功返回 true；异步库读取会丢弃过期响应，避免后完成的旧请求覆盖新工作。 */
  loadRecent(name: string, preserveSpcRoles?: boolean): Promise<boolean>;
  resetDemo(): void;
  /** 手工录入：编辑单元格 / 添加子组（复制末行） / 删除行。编辑演示集自动转「副本」。 */
  /** 项目导出快照期间单格编辑排队(不改变下标)，快照完成后按原坐标应用。 */
  updateCell(row: number, col: number, value: number): void;
  /** 以下结构性编辑返回是否真正应用：项目导出快照期间一律拒绝(提示「请稍后重试」)，不排队，调用方不得报成功。 */
  addSubgroupRow(): boolean;
  deleteRow(row: number): boolean;
  /** 撤销/重做：false = 无可撤销/重做，或项目导出快照期间被拒绝(isProjectExportInFlight 区分)。 */
  undoEdit(): boolean;
  redoEdit(): boolean;
  /** 新建空白工作表（5 列 × 3 行；有限占位值与 pendingCells 分离）。返回持久化结果(含被挤出最近列表的数据集)。 */
  newWorksheet(): PersistOutcome;
  /** 当前数据集另存为「xxx (副本)」并激活。
   * 桌面端先只插入，durability 成功后才激活；name 在碰撞重试时更新，调用方须等待后读取。
   * 返回 name + 持久化结果(蜂群 P1-01:此前只返回名字、丢弃 PersistOutcome,
   * 配额满时调用方仍提示「已另存」并覆盖当前编辑,后续编辑静默丢失)。 */
  saveAsCopy(): { name: string; outcome: PersistOutcome };
  /** 列 z-score 标准化 → 新数据集；有待录入格或无变异列时返回 null。 */
  standardize(): DerivedDatasetResult | null;
  /** 生成正态随机数据集(返回实际名称、请求名与持久化结果，调用方据此拼接改名/挤出提示) */
  generateRandom(mu: number, sigma: number, k: number, n: number): DerivedDatasetResult;
  /** 按测量列排序（文本列同步重排）；返回是否已排序(快照期间被拒/列无效/编辑被拒为 false)。 */
  sortBy(col: number, asc: boolean): boolean;
  /** 从最近列表移除（不影响当前数据集） */
  removeRecent(name: string): void;
  /** 重命名测量列（col 为测量列索引 0-based） */
  renameColumn(col: number, name: string): void;
  /** 删除测量列（至少保留 1 列）；返回是否已删除。 */
  deleteColumn(col: number): boolean;
  /** 追加一个「待录入」数值列(整列 pendingCells 占位,不复制末列数值) */
  insertColumn(): boolean;
  /** 用公式（引用工作表顶部 C# 数值列/列名）算出一列并追加;成功返回 null,失败返回错误信息 */
  addFormulaColumn(name: string, expr: string): string | null;
  /** 按条件表达式（C# 与工作表顶部编号同源）筛出子集为新数据集 */
  subsetByCondition(cond: string): { ok: true; name: string; requested: string; kept: number; total: number; outcome: PersistOutcome } | { ok: false; error: string };
  /** 统计与替换测量值(3dp 显示容差);col=-1 全部列。replace 为 null 只计数。可撤销。 */
  findReplace(find: number, replace: number | null, col: number): number;
  /** 转置：k×n → n×k；可只转置 SPC 角色层确认的子组列。 */
  transposeDataset(sourceColumns?: string[]): DerivedDatasetResult;
  /** 堆叠：多测量列堆成单列 + 「来源列」分组标签,生成新数据集「xxx (堆叠)」 */
  stackColumns(): DerivedDatasetResult;
  /** MES 模拟：追加一个子组（首次调用前需 startMesDataset） */
  startMesDataset(n: number): void;
  appendSubgroup(vals: number[]): void;
  setMesRunning(v: boolean): void;
}

/** 依数据量级取合理的小数位 */
function roundTo(v: number, sd: number): number {
  const digits = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.max(sd, 1e-9)))));
  return Number(v.toFixed(digits));
}

/** 当前数据集的默认规格限：演示用原型规格,导入按 μ±4σ 建议 */
export function suggestedSpec(model: VarModel): { lsl: number; tgt: number; usl: number } {
  if (model.isDemo) return { lsl: 24.9, tgt: 25.0, usl: 25.1 };
  const { oMean, oSd } = model;
  return {
    tgt: roundTo(oMean, oSd),
    lsl: roundTo(oMean - 4 * oSd, oSd),
    usl: roundTo(oMean + 4 * oSd, oSd),
  };
}

/**
 * 工作表当前的“测量数据口径”。SPC、能力分析和自动规格建议必须共用这一解析，
 * 否则数值型子组 ID 会在不同页面一会儿是标签、一会儿又被算成测量值。
 */
export function resolveActiveMeasurementData(model: VarModel, textCols: TextColumn[]): SpcPreparedData {
  const app = useApp.getState();
  return prepareSpcData(model, textCols, {
    layout: app.spcDataLayout,
    valueColumn: app.spcValueCol,
    subgroupColumn: app.spcSubgroupCol,
    pendingCells: useData.getState().pendingCells,
  });
}

/**
 * 能力分析的数据口径(批次716-N):默认沿用 SPC 角色;可在能力页改为
 * 「单列+子组大小常量」(按行序顺序分组,末尾不足一组的观测不参与并明示)或「单列+子组 ID 列」。
 * 能力页、保存记录与专项报告共用本解析,保证同一数据只有一个能力口径。
 */
export function resolveCapabilityMeasurementData(model: VarModel, textCols: TextColumn[]): SpcPreparedData {
  const app = useApp.getState();
  const pendingCells = useData.getState().pendingCells;
  if (app.capSubgroupMode === 'stacked') {
    // 子组 ID 存角色引用(numeric:/text:,与 SPC 页同约定);兼容旧的裸列名写法
    const rawId = app.capSubgroupIdCol;
    const idRef = rawId && !/^(numeric|text):/.test(rawId)
      ? (textCols.some((t) => t.name === rawId) ? `text:${rawId}` : model.colNames.includes(rawId) ? `numeric:${rawId}` : rawId)
      : rawId;
    return prepareSpcData(model, textCols, {
      layout: 'stacked',
      valueColumn: app.capValueCol ?? app.spcValueCol,
      subgroupColumn: idRef,
      pendingCells,
    });
  }
  if (app.capSubgroupMode === 'const') {
    const valueCol = app.capValueCol ?? app.spcValueCol;
    if (!valueCol) {
      return { ...prepareSpcData(model, textCols, { layout: 'individuals', valueColumn: null, subgroupColumn: null, pendingCells }), model: null, error: '「单列 + 子组大小」模式请先选择测量列;系统不会静默取第一个数值列' };
    }
    const idx = model.colNames.indexOf(valueCol);
    if (idx < 0) {
      return { ...prepareSpcData(model, textCols, { layout: 'individuals', valueColumn: null, subgroupColumn: null, pendingCells }), model: null, error: `能力子组配置的测量列「${valueCol}」不存在,请重新选择` };
    }
    if (!isDoeAnalysisColumn(valueCol)) {
      return { ...prepareSpcData(model, textCols, { layout: 'individuals', valueColumn: null, subgroupColumn: null, pendingCells }), model: null, error: `「${valueCol}」是设计元数据或分析输出列,不能作为能力分析测量值` };
    }
    if (pendingCells.some((c) => c.col === idx)) {
        return { ...prepareSpcData(model, textCols, { layout: 'individuals', valueColumn: null, subgroupColumn: null, pendingCells }), model: null, error: `测量列「${valueCol}」仍有待录入单元格,不能用于能力分析` };
    }
    const z = Math.max(2, Math.min(10, Math.round(app.capSubgroupSize)));
    const values = model.subs.map((row) => row.vals[idx]);
    const full = Math.floor(values.length / z);
    const dropped = values.length - full * z;
    if (full < 2) {
      return { ...prepareSpcData(model, textCols, { layout: 'individuals', valueColumn: null, subgroupColumn: null, pendingCells }), model: null, error: `按子组大小 ${z} 顺序分组后完整子组不足 2 个(共 ${values.length} 个观测),无法估计组内变差` };
    }
    const rows = Array.from({ length: full }, (_, i) => values.slice(i * z, (i + 1) * z));
    const temp = computeVarModel(model.name, Array.from({ length: z }, (_, j) => `${valueCol}_${j + 1}`), rows);
    const prepared = prepareSpcData(temp, [], { layout: 'rows', valueColumn: null, subgroupColumn: null, pendingCells: [] });
    return {
      ...prepared,
      variableName: valueCol ?? prepared.variableName,
      note: `能力子组:单列「${valueCol}」按行序每 ${z} 个一组,共 ${full} 个子组${dropped > 0 ? `;末尾 ${dropped} 个观测不足一个子组,未参与本次估计` : ''}`,
    };
  }
  return resolveActiveMeasurementData(model, textCols);
}

const LS_SPECS = 'qp-specs-v1';
interface StoredSpec { lsl: number; tgt: number; usl: number; lslOn?: boolean; uslOn?: boolean }
type SpecMap = Record<string, StoredSpec>;

/** SpecMap 的唯一载入口:恒为 null 原型,绝不返回带 Object.prototype 的对象(盲审 P2)。 */
function loadSpecMap(): Record<string, StoredSpec> {
  return toLookupMap<StoredSpec>(loadValidatedStoreJson<SpecMap>(LS_SPECS));
}

function specRoleKey(model: VarModel, textCols: TextColumn[]): string | null {
  const prepared = resolveActiveMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return null;
  return `v2:${encodeURIComponent(model.name)}:${encodeURIComponent(prepared.variableName)}`;
}

function forgetSpecsForDataset(name: string): void {
  const map = loadSpecMap();
  const prefixes = [`v2:${encodeURIComponent(name)}:`, `v3:${encodeURIComponent(name)}:`];
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key === name || prefixes.some((prefix) => key.startsWith(prefix))) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) saveJson(LS_SPECS, map);
}

/** 记住某数据集的规格限（Capability 页编辑时写入） */
export function rememberSpecFor(name: string, spec: { lsl: number; tgt: number; usl: number }) {
  const map = loadSpecMap();
  map[name] = spec;
  saveJson(LS_SPECS, map);
}

/** 按“数据集 + 当前解析测量特性”记忆规格，单双侧开关也属于规格语义。 */
export function rememberSpecForActiveMeasurement(
  model: VarModel,
  textCols: TextColumn[],
  spec: { lsl: number; tgt: number; usl: number; lslOn: boolean; uslOn: boolean },
): void {
  const key = specRoleKey(model, textCols);
  if (!key) return;
  const map = loadSpecMap();
  map[key] = spec;
  saveJson(LS_SPECS, map);
}

/** 能力页规格键:跟随能力口径(capSubgroup*)解析出的测量特性。
 * 批次716-R2 P0:规格必须绑定能力口径,否则切换能力测量列后沿用旧量纲规格会产出虚假 Cpk。
 * 导出供能力页比较口径键是否真的变化——零变化的点击不得触发规格同步(否则会冲掉历史回放的快照规格)。 */
export function capabilitySubgroupSemantics(model: VarModel, textCols: TextColumn[]): string | null {
  const prepared = resolveCapabilityMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return null;
  const app = useApp.getState();
  const effectiveValue = app.capValueCol ?? app.spcValueCol;
  const rawId = app.capSubgroupIdCol;
  const effectiveId = rawId && !/^(numeric|text):/.test(rawId)
    ? (textCols.some((column) => column.name === rawId)
        ? `text:${rawId}`
        : model.colNames.includes(rawId) ? `numeric:${rawId}` : rawId)
    : rawId;
  // Only statistical-role settings belong here.  Theme, bins and other pure
  // presentation preferences intentionally do not invalidate specs/approval.
  return JSON.stringify(app.capSubgroupMode === 'spc'
    ? {
        mode: 'spc',
        layout: app.spcDataLayout,
        value: app.spcValueCol,
        subgroup: app.spcSubgroupCol,
      }
    : app.capSubgroupMode === 'const'
      ? { mode: 'const', value: effectiveValue, size: Math.max(2, Math.min(10, Math.round(app.capSubgroupSize))) }
      : { mode: 'stacked', value: effectiveValue, subgroup: effectiveId });
}

export function capabilitySpecKey(model: VarModel, textCols: TextColumn[]): string | null {
  const prepared = resolveCapabilityMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return null;
  // 规格限属于物理测量特性，不属于子组划分：同一列从“每 2 个一组”
  // 改为“每 3 个一组”不应把图纸 LSL/USL 重置成 μ±4σ。子组语义另行
  // 进入 1000σ 确认指纹，既不放宽安全边界，也不污染规格记忆。
  return `v2:${encodeURIComponent(model.name)}:${encodeURIComponent(prepared.variableName)}`;
}

/** 页面、状态栏、保存摘要和通用导出共用的 1000σ 确认判定。 */
export function isCapabilityWarningAcknowledged(
  sourceModel: VarModel,
  textCols: TextColumn[],
  capabilityModel: VarModel,
  spec: SpecLimits,
  acknowledgement: string | null,
): boolean {
  if (acknowledgement == null) return false;
  const measurementKey = capabilitySpecKey(sourceModel, textCols);
  if (!measurementKey) return false;
  const subgroupSemantics = capabilitySubgroupSemantics(sourceModel, textCols);
  if (!subgroupSemantics) return false;
  const fingerprint = capabilityWarningFingerprint(
    measurementKey,
    capabilityModel.all,
    capabilityModel.sigmaWithin,
    spec,
    subgroupSemantics,
  );
  return fingerprint != null && acknowledgement === fingerprint;
}

/** 能力页编辑规格时按「数据集 + 能力口径测量特性」记忆,不再写入 SPC 口径的键(防反向污染)。 */
export function rememberSpecForCapabilityMeasurement(
  model: VarModel,
  textCols: TextColumn[],
  spec: { lsl: number; tgt: number; usl: number; lslOn: boolean; uslOn: boolean },
): void {
  const key = capabilitySpecKey(model, textCols);
  if (!key) return;
  const map = loadSpecMap();
  map[key] = spec;
  saveJson(LS_SPECS, map);
}

/** 能力口径变化(切换子组模式/测量列/ID 列)后同步规格:该特性有记忆用记忆,否则按新口径
 * μ±4σ 重建议;口径解析失败时不动当前规格(页面会显示错误卡)。返回规格是否发生变化。 */
export function syncSpecForCapabilityMeasurement(): boolean {
  const { model, textCols } = useData.getState();
  const prepared = resolveCapabilityMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return false;
  const key = capabilitySpecKey(model, textCols);
  if (!key) return false;
  const map = loadSpecMap();
  const app0 = useApp.getState();
  // 旧版仅按数据集名保存的记忆规格:与 specForActiveMeasurement 同口径兼容读取
  // (仅默认「沿用 SPC 角色」且完全自动、无显式角色时),避免建议值顶掉用户的图纸规格。
  const defaultRole = app0.capSubgroupMode === 'spc' && app0.spcDataLayout === 'auto'
    && app0.spcValueCol == null && app0.spcSubgroupCol == null
    && app0.spcStageCol == null && app0.spcSigmaMethod === 'classic';
  const legacyRole = defaultRole
    ? map[`v2:${encodeURIComponent(model.name)}:${encodeURIComponent(prepared.variableName)}`]
    : undefined;
  const legacy = defaultRole ? map[model.name]
    : undefined;
  const saved = map[key] ?? legacyRole ?? legacy;
  const next = saved
    ? { lsl: saved.lsl, tgt: saved.tgt, usl: saved.usl, lslOn: saved.lslOn ?? true, uslOn: saved.uslOn ?? true }
    : { ...suggestedSpec(prepared.model), lslOn: true, uslOn: true };
  const app = useApp.getState();
  const changed = next.lsl !== app.lsl || next.usl !== app.usl || next.tgt !== app.tgt
    || next.lslOn !== app.lslOn || next.uslOn !== app.uslOn;
  if (changed) useApp.setState(next);
  return changed;
}

/** 切换数据集时恢复其规格限;没有记忆则按当前测量角色的 μ±4σ 建议。 */
export function specForActiveMeasurement(model: VarModel, textCols: TextColumn[]) {
  const map = loadSpecMap();
  const key = specRoleKey(model, textCols);
  const app = useApp.getState();
  const exact = key ? map[key] : undefined;
  // 旧版仅按数据集名保存：只在完全自动、无显式角色时兼容读取，避免套到另一物理量。
  const legacy = app.spcDataLayout === 'auto' && app.spcValueCol == null && app.spcSubgroupCol == null
    ? map[model.name]
    : undefined;
  const saved = exact ?? legacy;
  const prepared = saved ? null : resolveActiveMeasurementData(model, textCols);
  // 角色有歧义时不用原始宽表偷算规格；待用户在 SPC 页明确角色后可在能力页复位。
  if (saved) return { ...saved, lslOn: saved.lslOn ?? true, uslOn: saved.uslOn ?? true };
  return prepared?.model ? { ...suggestedSpec(prepared.model), lslOn: true, uslOn: true } : null;
}

function suggestSpec(model: VarModel, textCols: TextColumn[]) {
  const suggestion = specForActiveMeasurement(model, textCols);
  useApp.setState({ ...(suggestion ?? {}), selSub: null });
}

/**
 * SPC 的列角色属于某一张工作表，不能跨数据集沿用。否则旧的 rows/阶段配置可能把
 * 新工作表的不同物理量静默当成组内重复值，或造成页面与保存/导出口径分裂。
 */
function resetDatasetNonSpcRoles(): void {
  useApp.setState({
    // Gage 下拉框不能视觉回退到新列、计算却继续提交旧列名。
    gageValueName: null, gagePartName: null, gageOperatorName: null,
    // 量具信息属于具体研究；导入/切换工作表时不得把上一研究的追溯字段带到新研究。
    gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
    // 批量响应选择与逐列公差属于当前工作表；即使新表恰有同名列，也不能沿用上一数据集的物理规格。
    gageBatchCols: null, gageTolByCol: {}, gageTolMode: 'auto', gageTolValue: null,
    // 能力子组配置同属列角色:跨数据集沿用会把上一张表的口径静默套在新表同名列上。
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    // 单样本 t 的目标值 μ0 是量纲相关参数,同样不得跨数据集沿用(双审 P2)
    t1Mu0: null,
  });
}

function resetDatasetSpcRoles(): void {
  const currentType = useApp.getState().spcType;
  useApp.setState({
    // P/C 数据独立于变量工作表；导入普通变量表后不能仍停留在上一份属性图。
    spcType: currentType === 'p' || currentType === 'c' ? 'xbar-r' : currentType,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    selSub: null,
  });
  resetDatasetNonSpcRoles();
}

// ---------- 启动恢复 ----------
const demo = demoInit();

function sameStoredDatasetVersion(left: StoredDataset, right: StoredDataset): boolean {
  const normalized = (value: StoredDataset) => ({
    name: value.name,
    colNames: value.colNames,
    rows: value.rows,
    textCols: value.textCols ?? [],
    pendingCells: value.pendingCells ?? [],
    isDemo: value.isDemo === true,
    indivSeries: value.indivSeries ?? null,
    savedAt: value.savedAt,
  });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

/**
 * 最近列表截断的唯一实现(fix2609b M1)。所有「新条目置顶 + 截到上限」都必须经此，
 * 被截掉的条目交还调用方：桌面端经 settleEvictedRecents 补入本机库(只插入、不覆盖)，
 * Web 端没有其他落盘位置，必须如实提示——绝不静默丢弃。
 */
function trimRecents(nextList: RecentEntry[]): { recents: RecentEntry[]; evicted: RecentEntry[] } {
  if (nextList.length <= MAX_RECENT_DATASETS) return { recents: nextList, evicted: [] };
  const recents = nextList.slice(0, MAX_RECENT_DATASETS);
  const kept = new Set(recents.map((entry) => entry.name));
  return { recents, evicted: nextList.slice(MAX_RECENT_DATASETS).filter((entry) => !kept.has(entry.name)) };
}

/**
 * Web 端挤出确认(与「再次点击确认删除」同一交互)：首次被拒后，同一操作标识(modelOptions.confirmKey，
 * 省略时为请求名) + 同一批将被移出的数据集 + 布防时的最近列表名称序列在时限内再次执行即视为用户确认。
 * 确认只消费一次。fix2609f G4d：列表一变(× 移除、另一次写入置顶、编辑置顶、另一窗口同步)布防即作废；
 * 任何无需挤出即通过的新建类写入、× 移除、库删除收口也显式作废——用户按提示走了另一条路后，
 * 60 秒内的下一次同键写入必须重新拒绝，不能消费旧布防把用户想保住的数据集永久挤出。
 */
const EVICTION_CONFIRM_SECONDS = 60;
let evictionConfirmation: { key: string; expires: number } | null = null;

function evictionConfirmationKey(operationKey: string, evicted: string[], recents: RecentEntry[]): string {
  return JSON.stringify([operationKey, evicted, recents.map((entry) => entry.name)]);
}

function armEvictionConfirmation(operationKey: string, evicted: string[], recents: RecentEntry[]): void {
  evictionConfirmation = {
    key: evictionConfirmationKey(operationKey, evicted, recents),
    expires: Date.now() + EVICTION_CONFIRM_SECONDS * 1000,
  };
}

function consumeEvictionConfirmation(operationKey: string, evicted: string[], recents: RecentEntry[]): boolean {
  const armed = evictionConfirmation;
  if (!armed || armed.expires < Date.now()
    || armed.key !== evictionConfirmationKey(operationKey, evicted, recents)) return false;
  evictionConfirmation = null;
  return true;
}

function disarmEvictionConfirmation(): void {
  evictionConfirmation = null;
}

/** 同名时活动表是用户刚刚看到并写入的版本，最近入口只能跟随，不能反向覆盖。 */
function coordinateRecentsWithActive(
  recents: RecentEntry[],
  active: StoredDataset | null | undefined,
): { recents: RecentEntry[]; changed: boolean; evicted: RecentEntry[] } {
  if (!active) return { recents, changed: false, evicted: [] };
  const index = recents.findIndex((entry) => sameDatasetName(entry.name, active.name));
  const authoritative: RecentEntry = { name: active.name, savedAt: active.savedAt, data: active };
  if (index < 0) {
    return { ...trimRecents([authoritative, ...recents]), changed: true };
  }
  const existing = recents[index];
  if (existing.savedAt === active.savedAt && existing.data
    && sameStoredDatasetVersion(existing.data, active)) {
    return { recents, changed: false, evicted: [] };
  }
  const next = [...recents];
  next[index] = authoritative;
  return { recents: next, changed: true, evicted: [] };
}

const storedAttr = loadValidatedStoreJson<{
  p?: { name: string; counts: number[]; sampleSize?: number; sampleSizes?: number[] };
  c?: { name: string; counts: number[] };
}>(LS_ATTR);
const stored = loadValidatedStoreJson<StoredDataset>(LS_DATASET);
try { ownActiveSlotRaw = localStorage.getItem(LS_DATASET); } catch { /* 读不到则按「非本窗口写入」处理，不删槽 */ }
/**
 * 旧版本按原始名称去重写下的最近列表(fix2609j STORE-15 迁移)：若唯一的问题是「只差首尾空格的重名」，
 * 启动时先把原文完整复制到隔离区，再按列表顺序(新→旧)保留每个名称的第一条合并落盘，
 * 而不是让整张列表(含无关条目)被判损坏隔离清空。隔离区写不下或还有其它损坏时不动，走原有隔离路径。
 */
function migrateTrimDuplicateRecents(): void {
  let raw: string | null;
  try { raw = localStorage.getItem(LS_RECENTS); } catch { return; }
  if (!raw) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(parsed)) return;
  const detail = projectStoreValidationError(LS_RECENTS, parsed);
  if (!detail || !detail.startsWith('最近数据集名称重复')) return;
  const seen = new Set<string>();
  const kept: unknown[] = [];
  const merged: string[] = [];
  for (const entry of parsed as unknown[]) {
    const name = entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== 'string') return;
    const key = name.trim();
    if (seen.has(key)) merged.push(name);
    else { seen.add(key); kept.push(entry); }
  }
  if (merged.length === 0 || projectStoreValidationError(LS_RECENTS, kept)) return;
  if (!preserveCorruptStore(LS_RECENTS, raw, `${detail}（旧版本按原始名称去重，只差首尾空格；已合并较旧条目）`)) return;
  if (!saveJson(LS_RECENTS, kept, true)) return;
  const note = `最近数据集列表中有只差首尾空格的重名条目（${merged.map((name) => `「${name.trim()}」`).join('')}），`
    + '已保留较新的一条；原列表已完整复制到隔离区，可在「工具 → 选项」找回';
  sessionLog(note);
  try { useApp.getState().showToast(note); } catch { /* 非 UI 环境忽略 */ }
}
migrateTrimDuplicateRecents();
const loadedStoredRecents = loadValidatedStoreJson<RecentEntry[]>(LS_RECENTS) ?? [];
const startupRecentCoordination = coordinateRecentsWithActive(loadedStoredRecents, stored);
const storedRecents = startupRecentCoordination.recents;
if (startupRecentCoordination.changed) {
  // persistRecents 会在 store 构造完成后修复磁盘；在此之前保持离开警告。
  recentsUnpersistedFlag = true;
  activeUnpersistedFlag = true;
}
if (stored?.name) knownDatasetNames.add(stored.name);
storedRecents.forEach((entry) => knownDatasetNames.add(entry.name));
if (stored?.vaultInsertOnly) unclaimedCopyNames.add(stored.name);
storedRecents.forEach((entry) => { if (entry.data?.vaultInsertOnly) unclaimedCopyNames.add(entry.name); });
// 列库是异步能力：启动后预热名称缓存，供后续同步的「另存为副本」尽可能规避库中旧名。
platform.datasetDb?.list().then((entries) => {
  entries.forEach((entry) => knownDatasetNames.add(entry.name));
}).catch(() => { /* 库不可用不影响本地高水位 */ });

function modelFromStored(data: StoredDataset): VarModel {
  const detail = projectStoreValidationError(LS_DATASET, data);
  if (detail) throw new Error(`数据集结构损坏：${detail}`);
  if (data.vaultInsertOnly && !sessionClaimedCopyNames.has(data.name)) unclaimedCopyNames.add(data.name);
  return computeVarModel(data.name, data.colNames, data.rows, {
    isDemo: data.isDemo === true,
    indivSeries: data.indivSeries?.map((value) => value),
  });
}

function storedModelMetadata(model: VarModel, rows: number[][]): Pick<StoredDataset, 'isDemo' | 'indivSeries' | 'vaultInsertOnly'> {
  // computeVarModel 的普通 indiv 与 all 是同一引用，不必为每次单格编辑
  // 先 rows.flat() 出一份完整矩阵。只对真正独立的 I-MR 序列做无分配比较。
  let hasDistinctIndiv = model.indiv !== model.all;
  if (hasDistinctIndiv && model.indiv.length === model.all.length) {
    hasDistinctIndiv = false;
    let index = 0;
    outer: for (const row of rows) {
      for (const value of row) {
        if (model.indiv[index++] !== value) {
          hasDistinctIndiv = true;
          break outer;
        }
      }
    }
  }
  return {
    isDemo: model.isDemo || undefined,
    indivSeries: hasDistinctIndiv ? [...model.indiv] : undefined,
    vaultInsertOnly: unclaimedCopyNames.has(model.name) ? true : undefined,
  };
}

function pendingFromStored(data: StoredDataset): PendingCell[] {
  const source = data.pendingCells ?? data.colNames.flatMap((name, col) =>
    /待录入/.test(name)
      ? data.rows.flatMap((row, rowIndex) => row[col] === 0 ? [{ row: rowIndex, col }] : [])
      : [],
  );
  const pendingError = worksheetPendingCellsError(source, {
    rows: data.rows.length,
    cols: data.colNames.length,
  });
  if (pendingError) throw new Error(`数据集 ${pendingError}`);
  return source.map(({ row, col }) => ({ row, col }));
}

let initModel = demo.model;
let initText: TextColumn[] = [];
let initPending: PendingCell[] = [];
if (stored) {
  try {
    initModel = modelFromStored(stored);
    initText = stored.textCols ?? [];
    initPending = pendingFromStored(stored);
  } catch {
    initModel = demo.model;
  }
}
let initP = demo.p;
let initC = demo.c;
if (storedAttr?.p) {
  try {
    const sampleSize = storedAttr.p.sampleSizes ?? storedAttr.p.sampleSize;
    if (sampleSize == null) throw new Error('P 图样本量缺失');
    initP = computePChart(storedAttr.p.counts, sampleSize, storedAttr.p.name);
  } catch { /* 保留演示 */ }
}
if (storedAttr?.c) {
  try {
    initC = computeCChart(storedAttr.c.counts, storedAttr.c.name);
  } catch { /* 保留演示 */ }
}

function persistAttr(p: PChartModel, c: CChartModel): boolean {
  return saveJson(LS_ATTR, {
    p: p.isDemo
      ? undefined
      : p.pVariableN
        ? { name: p.name, counts: p.pdef, sampleSizes: p.pNs }
        : { name: p.name, counts: p.pdef, sampleSize: p.pN },
    c: c.isDemo ? undefined : { name: c.name, counts: c.cdata },
  });
}

type SetFn = (partial: Partial<DataState>) => void;
type GetFn = () => DataState;

interface EditSnapshot {
  name: string;
  colNames: string[];
  rows: number[][];
  textCols: TextColumn[];
  pendingCells: PendingCell[];
  isDemo?: boolean;
  indivSeries?: number[];
}

const MAX_UNDO = 20;
/** 撤销栈的**字节预算**(蜂群 P2-02:20 层整表快照在 20 万×10 的合法工作表上
 * 实测占用约 647 MiB)。层数与字节预算取先到者。 */
const MAX_UNDO_BYTES = 48 * 1024 * 1024;

/** 快照的近似字节数:数值 8B/个,文本按字符 2B 估。 */
function snapshotBytes(snap: EditSnapshot): number {
  // 盲审 P2:旧口径只算「数值 8B / 字符 2B」的裸载荷,实测 200k×1 窄表 20 层占
  // 244MB 而预算认为只有 30.5MB —— 裁剪根本不触发。V8 的实际开销来自:
  //   · 每个 number[] 行是独立 JSArray:对象头 + 元素指针,窄表(每行 1 个数)最吃亏
  //   · 每个 string 有 ~16B 头;每个 {row,col} 对象 ~32B
  // 按行/元素/字符串**各自计入固定开销**后与实测量级吻合。
  const ROW_OVERHEAD = 96;   // JSArray 头 + 指针槽
  const CELL_BYTES = 8;      // 双精度元素
  const STR_OVERHEAD = 16;   // 字符串对象头
  const numeric = snap.rows.reduce(
    (sum, row) => sum + ROW_OVERHEAD + row.length * CELL_BYTES, 0,
  );
  const text = snap.textCols.reduce(
    (sum, column) => sum + ROW_OVERHEAD
      + column.values.reduce((n, v) => n + STR_OVERHEAD + v.length * 2, 0), 0,
  );
  return numeric + text + snap.pendingCells.length * 32 + snap.colNames.length * 48;
}

/** 按「层数 + 字节预算」双重裁剪撤销/重做栈,最旧的先丢;至少保留 1 层。budgetLimited=字节预算实际裁掉了快照。 */
function trimSnapshotStackWithInfo(stack: EditSnapshot[]): { stack: EditSnapshot[]; budgetLimited: boolean } {
  const capped = stack.slice(-MAX_UNDO);
  let total = capped.reduce((sum, snap) => sum + snapshotBytes(snap), 0);
  let start = 0;
  while (start < capped.length - 1 && total > MAX_UNDO_BYTES) {
    total -= snapshotBytes(capped[start]);
    start += 1;
  }
  return { stack: start > 0 ? capped.slice(start) : capped, budgetLimited: start > 0 };
}

function trimSnapshotStack(stack: EditSnapshot[]): EditSnapshot[] {
  return trimSnapshotStackWithInfo(stack).stack;
}

/** 每个数据集只提示一次(fix2609j GAP-10-25)：大表上撤销历史被字节预算压缩时，此前完全静默。 */
const undoBudgetWarnedDatasets = new Set<string>();
function warnUndoBudget(datasetName: string, depth: number): void {
  if (undoBudgetWarnedDatasets.has(datasetName)) return;
  undoBudgetWarnedDatasets.add(datasetName);
  const detail = `「${datasetName}」数据量较大，撤销历史受内存预算限制：当前仅可撤销 ${depth} 步（小表最多 ${MAX_UNDO} 步）；`
    + `大批修改前请先${PROJECT_BACKUP_HINT}备份或另存为副本`;
  sessionLog(detail);
  try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
}

/** 每次用户主动切换/编辑活动数据集都推进版本，异步恢复只能提交同一版本的结果。 */
let datasetIntentRevision = 0;
let projectExportOwner: symbol | null = null;
function beginDatasetIntent(): number {
  if (projectExportOwner !== null) {
    throw new Error('项目正在生成一致性快照，请稍后再修改或切换数据集');
  }
  datasetIntentRevision += 1;
  return datasetIntentRevision;
}

/**
 * 项目导出一致性快照期间的手工编辑暂存队列(fix2609j GAP-7-15)。快照窗口(冲刷 vault + 读本机库)
 * 不设遮罩，用户常在 Ctrl+S 后继续录数；此前编辑入口在 beginDatasetIntent 抛未捕获异常，
 * 值被静默丢弃且单元格卡在编辑态。改为按调用顺序暂存动作本身，租约释放后依次重放——
 * 快照仍只含导出开始时的数据，用户输入不丢。重放时按当时的工作表重新校验。
 *
 * fix2609m A2:只允许**不改变行/列下标**的编辑(单格编辑、列重命名)进入队列。暂存闭包按调用时的下标捕获，
 * 暂存期间界面仍显示旧布局；若结构性编辑(删行/删列/插列/加子组/排序/查找替换/撤销/重做)也排队，重放时
 * 后续编辑会作用在已被前序结构编辑改过的表上——× 连点两次多删一行、编辑写到别的行。结构性编辑因此在
 * 快照期间直接拒绝(structuralEditRefused)，由调用方如实提示「请稍后重试」。
 */
const deferredExportEdits: Array<() => void> = [];
const EXPORT_DEFERRED_EDIT_NOTICE = '项目备份正在生成一致性快照，本次编辑已暂存，将在快照完成后自动应用（通常数秒内）';

/** 导出快照进行中则暂存 replay 并提示，返回 true；调用方随即返回，不触碰数据集。只用于不改变下标的编辑。 */
function deferEditDuringExport(replay: () => void): boolean {
  if (projectExportOwner === null) return false;
  deferredExportEdits.push(replay);
  try { useApp.getState().showToast(EXPORT_DEFERRED_EDIT_NOTICE); } catch { /* 非 UI 环境忽略 */ }
  return true;
}

function drainDeferredExportEdits(): void {
  // 又开始了新的导出：留待它释放租约时再重放，保持顺序。
  if (projectExportOwner !== null) return;
  const edits = deferredExportEdits.splice(0);
  if (edits.length === 0) return;
  let failed = 0;
  for (let i = 0; i < edits.length; i++) {
    if (projectExportOwner !== null) {
      deferredExportEdits.unshift(...edits.slice(i));
      return;
    }
    try { edits[i](); } catch (error) {
      failed += 1;
      sessionLog(`导出期间暂存的工作表编辑未能应用：${errText(error)}`);
    }
  }
  sessionLog(`已应用项目导出期间暂存的 ${edits.length - failed} 次工作表编辑`);
  if (failed > 0) {
    try { useApp.getState().showToast(`导出期间暂存的 ${failed} 次工作表编辑未能应用，请检查工作表后重新录入`); } catch { /* 非 UI 环境忽略 */ }
  }
}

/** 释放导出租约；有暂存编辑时在当前调用栈结束后重放(不在 project.ts 的 finally 中重入写入)。 */
function releaseProjectExportOwner(owner: symbol): void {
  if (projectExportOwner !== owner) return;
  projectExportOwner = null;
  if (deferredExportEdits.length > 0) queueMicrotask(drainDeferredExportEdits);
}

/** 导出快照期间拒绝有返回值的编辑入口(公式列/排序/查找替换/写回分析列)的统一口径：提示并返回原因，不抛异常。 */
function exportEditRefusal(): string | null {
  if (projectExportOwner === null) return null;
  const detail = '项目备份正在生成一致性快照，本次修改未应用；请稍后重试（通常数秒内，保存对话框出现后即可）';
  try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
  return detail;
}

/** 结构性编辑(改变行/列下标或表结构)在导出快照期间一律拒绝、不排队(fix2609m A2)；已提示时返回 true。 */
function structuralEditRefused(): boolean {
  return exportEditRefusal() !== null;
}

/** 数据集替换统一闸门(第三轮 arch):任何替换活动数据集的入口必须经此——
 * 停掉模拟采集 + 开新数据集意图。「替换必停 MES」的不变量此前分散在 5 个执行点
 * 逐个记得处理,漏一处就是一次数据污染(快照回看正是漏网的第 6 处)。 */
function replacementBlockReason(options: { equivalentRecoveryCopy?: boolean }): string | null {
  const activeName = useData.getState().model.name;
  if (recentsUnpersistedFlag
    && !options.equivalentRecoveryCopy
    && independentlyDurableRecoveryCopy !== activeName) {
    // STORE-08:旧文案「请先重试保存或导出项目」指向不存在的入口与无效动作(导出不解除闸门)。
    // 改为可操作口径：保存项目文件备份 → 移除不需要的最近数据集腾出空间 → 重试(闸门会自动重试保存)。
    // fix2609b M4:入口名必须与文件菜单一致；当前表本身过大时，移除其他数据集无效，须明说。
    return `最近数据集列表尚未保存（浏览器存储空间不足），为防「${activeName}」的最新数据在刷新后丢失，已暂停切换/导入其他数据集；`
      + `请先${PROJECT_BACKUP_HINT}备份，再在左侧「最近数据集」点 × 移除不再需要的数据集（已备份到项目文件的也可移除）腾出空间后重试；`
      + `若当前表本身过大，需先保存项目文件，再把「${activeName}」从最近列表移除`;
  }
  if (lightweightRecentDurability.has(activeName) && !options.equivalentRecoveryCopy) {
    return `最近列表仅保存了数据集「${activeName}」的轻量引用，精确矩阵尚未落入本机库；请稍后重试`;
  }
  if (overflowRequiredVaultSnapshot) {
    const name = overflowRequiredVaultSnapshot.data.name;
    return `数据集「${name}」的未持久化快照已占用安全保全槽；请先${PROJECT_BACKUP_HINT}备份或重试归档，再替换当前数据集`;
  }
  return null;
}

/** 当前替换活动数据集会被闸门拒绝的原因(纯查询)；UI 在加载失败时据此给出与闸门一致的提示。 */
export function datasetReplacementBlockReason(): string | null {
  return replacementBlockReason({});
}

/** 数据集替换统一闸门(第三轮 arch):任何替换活动数据集的入口必须经此——
 * 停掉模拟采集 + 开新数据集意图。「替换必停 MES」的不变量此前分散在 5 个执行点
 * 逐个记得处理,漏一处就是一次数据污染(快照回看正是漏网的第 6 处)。 */
function beginDatasetReplacement(options: { equivalentRecoveryCopy?: boolean } = {}): number {
  // updateCell 会在同一事件循环内合并持久化。数据集切换必须先把这个
  // pending 载荷同步提交，再根据 persistRecents 设置的未保存标记决定
  // 是否放行。先 cancel 会让用户最后一格编辑在同 tick loadRecent 时永久丢失。
  flushPendingCellPersistence();
  let detail = replacementBlockReason(options);
  if (detail && recentsUnpersistedFlag) {
    // STORE-08:真正的「重试保存」——用户移除其他最近数据集/清理空间后，
    // 无需再编辑一格即可在下一次切换时重新落盘并解锁；仍写不下则继续拦截。
    // fix2609b M2:内存 recents 可能已被另一窗口的列表替换而不含活动表；重试写入的必须是
    // 含活动表精确矩阵的列表，只有它落盘成功才算解锁，否则切换后活动表随替换丢失。
    const st = useData.getState();
    const activeData = inMemoryActiveDataset(st);
    const coordinated = coordinateRecentsWithActive(st.recents, activeData);
    if (coordinated.changed) useData.setState({ recents: coordinated.recents });
    // 提示由闸门统一给出，重试失败不再先闪一条通用的「存储已满」。
    if (persistRecents(coordinated.recents, activeData ?? undefined, { silent: true }) && !retryUnpersistedActive()) {
      sessionLog('切换前重试保存：最近列表已落盘，活动槽仍写不下(浏览器存储空间不足)，当前工作表的最新版本尚未写入活动槽');
    }
    settleEvictedRecents(coordinated.evicted);
    detail = replacementBlockReason(options);
  }
  if (detail) {
    sessionLog(`数据集替换已阻止 · ${detail}`);
    try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
    throw new Error(detail);
  }
  const st = useData.getState();
  if (st.mesRunning) useData.setState({ mesRunning: false });
  return beginDatasetIntent();
}

/**
 * 内存中的活动表(权威版本，含尚未落盘的编辑)，口径与 restoreSnapshot 相同。
 * 最近列表里已有同内容条目时复用它(保持 savedAt，避免无谓重写)；演示表可随时重建，不入最近列表。
 */
function inMemoryActiveDataset(st: DataState): StoredDataset | null {
  if (st.model.isDemo) return null;
  const rows = st.model.subs.map((subgroup) => subgroup.vals);
  const existing = st.recents.find((entry) => entry.name === st.model.name)?.data;
  if (existing && sameDatasetContent(
    { colNames: existing.colNames, rows: existing.rows, textCols: existing.textCols ?? [], pendingCells: existing.pendingCells ?? [] },
    { colNames: st.model.colNames, rows, textCols: st.textCols, pendingCells: st.pendingCells },
  )) return existing;
  return {
    name: st.model.name, colNames: st.model.colNames, rows, textCols: st.textCols,
    pendingCells: st.pendingCells, ...storedModelMetadata(st.model, rows),
    savedAt: new Date().toISOString(),
  };
}

function isCurrentDatasetIntent(revision: number): boolean {
  return revision === datasetIntentRevision;
}

function snapshotOf(st: DataState): EditSnapshot {
  const rows = st.model.subs.map((subgroup) => subgroup.vals);
  return {
    name: st.model.name,
    // Store 更新遵循不可变约定；快照可安全复用旧版本的行/列引用，
    // 不再为 20 万行的每一次编辑制造第二份深拷贝。
    colNames: st.model.colNames,
    rows,
    textCols: st.textCols,
    pendingCells: st.pendingCells,
    ...storedModelMetadata(st.model, rows),
  };
}

function restoreSnapshot(set: SetFn, get: GetFn, snap: EditSnapshot) {
  cancelPendingCellPersistence();
  beginDatasetIntent();
  const model = computeVarModel(snap.name, snap.colNames, snap.rows, {
    isDemo: snap.isDemo === true,
    indivSeries: snap.indivSeries?.map((value) => value),
  });
  const data: StoredDataset = {
    name: snap.name, colNames: snap.colNames, rows: snap.rows, textCols: snap.textCols,
    pendingCells: snap.pendingCells, isDemo: snap.isDemo, indivSeries: snap.indivSeries,
    vaultInsertOnly: unclaimedCopyNames.has(snap.name) ? true : undefined,
    savedAt: new Date().toISOString(),
  };
  pristineDatasets.delete(snap.name);
  const { recents, evicted } = trimRecents([
    { name: data.name, savedAt: data.savedAt, data },
    ...get().recents.filter((r) => !sameDatasetName(r.name, data.name)),
  ]);
  set({ model, textCols: snap.textCols, pendingCells: snap.pendingCells, recents });
  persistActive(data);
  persistRecents(recents, data);
  archiveToVault(data);
  settleEvictedRecents(evicted);
}

/** 桌面端把数据集镜像归档到本机 SQLite 数据集库(不受 localStorage 配额限制)。
 * 400ms 尾随防抖,连续编辑只落一次;Web 端 datasetDb 为 null,静默跳过。 */
interface PendingVaultArchive { timer: ReturnType<typeof setTimeout> | null; data: StoredDataset; bytes: number }
const vaultTimers = new Map<string, PendingVaultArchive>();
let vaultTimerBytes = 0;
const vaultWrites = new Set<Promise<void>>();
/**
 * 每个同名数据集最多 1 个在途 + 1 个 latest 待写。普通编辑可合并为最新值，
 * 避免 20 万行数据连续编辑时把完整 JSON 排成无界 Promise 队列。
 * 安全副本使用 coalesce=false，绝不与普通镜像合并。
 */
interface VaultWriteRequest {
  data: StoredDataset;
  json: string;
  bytes: number;
  generation: number;
  handlers: { succeeded?: () => void; failed?: () => void };
  coalesce: boolean;
  insertOnly: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  completion: Promise<void>;
  reservationReleased: boolean;
}
interface VaultWriteQueue { running: VaultWriteRequest; pending?: VaultWriteRequest }
const vaultWriteQueues = new Map<string, VaultWriteQueue>();
interface FailedVaultArchive { data: StoredDataset; bytes: number }
const failedVaultArchives = new Map<string, FailedVaultArchive>();
const globalVaultRunQueue: Array<{
  db: NonNullable<typeof platform.datasetDb>;
  name: string;
  request: VaultWriteRequest;
}> = [];
const MAX_CONCURRENT_VAULT_WRITES = 2;
const MAX_VAULT_WRITE_REQUESTS = 16;
const MAX_VAULT_WRITE_BYTES = 96 * 1024 * 1024;
const MAX_FAILED_VAULT_ARCHIVES = 12;
const MAX_FAILED_VAULT_ARCHIVE_BYTES = 96 * 1024 * 1024;
let activeGlobalVaultWrites = 0;
let reservedVaultWriteRequests = 0;
let reservedVaultWriteBytes = 0;
let failedVaultArchiveBytes = 0;
let vaultBackpressureWarned = false;
/** 用户明确清空后，迟到的旧 put 不得重建失败保全状态或回调。 */
let vaultWorkGeneration = 0;
/** 清库两阶段提交期间只冻结新归档，不销毁任何待写载荷或未保存保护。 */
let datasetClearQuiesced = false;

class DatasetNameCollisionError extends Error {}

function confirmAutoCopyClaim(name: string): void {
  sessionClaimedCopyNames.add(name);
  unclaimedCopyNames.delete(name);
  const clearMarker = (data: StoredDataset): StoredDataset => {
    const copy = { ...data };
    delete copy.vaultInsertOnly;
    return copy;
  };
  const local = loadValidatedStoreJson<StoredDataset>(LS_DATASET);
  if (local?.name === name && local.vaultInsertOnly) saveJson(LS_DATASET, clearMarker(local), true);
  const recents = useData.getState().recents.map((entry) => entry.name === name && entry.data?.vaultInsertOnly
    ? { ...entry, data: clearMarker(entry.data) } : entry);
  useData.setState({ recents });
  // 只清理已存在的磁盘条目，不能在别的活动表之后把旧 recent 列表重新写回。
  const saved = loadValidatedStoreJson<RecentEntry[]>(LS_RECENTS);
  if (saved?.some((entry) => entry.name === name && entry.data?.vaultInsertOnly)) {
    saveJson(LS_RECENTS, saved.map((entry) => entry.name === name && entry.data?.vaultInsertOnly
      ? { ...entry, data: clearMarker(entry.data) } : entry), true);
  }
}

function requiredVaultSnapshotFor(name: string): RequiredVaultSnapshot | undefined {
  return requiredVaultSnapshots.get(name)
    ?? (overflowRequiredVaultSnapshot?.data.name === name ? overflowRequiredVaultSnapshot : undefined);
}

function ownsRequiredVaultSnapshot(data: StoredDataset): boolean {
  return requiredVaultSnapshotFor(data.name)?.data === data;
}

/** 只清除指定版本，防止迟到的 A1 成功回调误清更新的 A2。 */
function clearRequiredVaultSnapshot(name: string, expected?: StoredDataset): boolean {
  let changed = false;
  const retained = requiredVaultSnapshots.get(name);
  if (retained && (expected === undefined || retained.data === expected)) {
    requiredVaultSnapshots.delete(name);
    requiredVaultSnapshotBytes = Math.max(0, requiredVaultSnapshotBytes - retained.bytes);
    changed = true;
  }
  if (overflowRequiredVaultSnapshot?.data.name === name
    && (expected === undefined || overflowRequiredVaultSnapshot.data === expected)) {
    overflowRequiredVaultSnapshot = null;
    changed = true;
  }
  if (changed) syncActiveUnpersisted();
  return changed;
}

/**
 * 在发起 SQLite put 前先保留精确载荷。map 与失败队列共用对象引用，
 * 计数/字节双上限；超限时使用一个溢出槽并由替换闸门 fail-closed。
 */
function retainRequiredVaultSnapshot(data: StoredDataset): 'retained' | 'overflow' | 'blocked' {
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength; } catch { return 'blocked'; }
  const previous = requiredVaultSnapshots.get(data.name);
  const nextCount = requiredVaultSnapshots.size + (previous ? 0 : 1);
  const nextBytes = requiredVaultSnapshotBytes - (previous?.bytes ?? 0) + bytes;
  if (nextCount <= MAX_FAILED_VAULT_ARCHIVES && nextBytes <= MAX_FAILED_VAULT_ARCHIVE_BYTES) {
    if (previous) requiredVaultSnapshotBytes -= previous.bytes;
    requiredVaultSnapshots.set(data.name, { data, bytes });
    requiredVaultSnapshotBytes += bytes;
    if (overflowRequiredVaultSnapshot?.data.name === data.name) overflowRequiredVaultSnapshot = null;
    syncActiveUnpersisted();
    return 'retained';
  }
  if (overflowRequiredVaultSnapshot && overflowRequiredVaultSnapshot.data.name !== data.name) {
    syncActiveUnpersisted();
    return 'blocked';
  }
  if (previous) {
    requiredVaultSnapshots.delete(data.name);
    requiredVaultSnapshotBytes = Math.max(0, requiredVaultSnapshotBytes - previous.bytes);
  }
  overflowRequiredVaultSnapshot = { data, bytes };
  syncActiveUnpersisted();
  return 'overflow';
}

/** SQLite 已耐久后才可释放对应快照；活动表还须确认 active-ref。 */
function confirmRequiredVaultSnapshotDurable(data: StoredDataset): boolean {
  if (!ownsRequiredVaultSnapshot(data)) return false;
  const isCurrent = useData.getState().model.name === data.name;
  if (isCurrent) establishActiveRef(data.name);
  clearRequiredVaultSnapshot(data.name, data);
  if (isCurrent) setActiveUnpersisted(false);
  return true;
}

function removeVaultTimer(name: string): PendingVaultArchive | undefined {
  const pending = vaultTimers.get(name);
  if (!pending) return undefined;
  if (pending.timer !== null) clearTimeout(pending.timer);
  vaultTimers.delete(name);
  vaultTimerBytes = Math.max(0, vaultTimerBytes - pending.bytes);
  return pending;
}

function establishActiveRef(name: string): void {
  if (protectedCorruptStores.has(LS_DATASET)) {
    throw new Error('损坏的活动数据原文尚未成功隔离，已禁止建立会覆盖它的恢复引用');
  }
  try {
    localStorage.setItem(LS_ACTIVE_REF, name);
    if (localStorage.getItem(LS_ACTIVE_REF) !== name) throw new Error('活动数据集恢复引用写入后读回不一致');
  } catch {
    localStorage.removeItem(LS_DATASET);
    localStorage.setItem(LS_ACTIVE_REF, name);
    if (localStorage.getItem(LS_ACTIVE_REF) !== name) throw new Error('活动数据集恢复引用写入后读回不一致');
  }
  // active-ref 已确认后，SQLite 才是权威副本。旧 localStorage 矩阵必须删除并读回确认；
  // 否则下次启动需要 savedAt+内容冲突裁决，本次不能报“已持久”。
  localStorage.removeItem(LS_DATASET);
  if (localStorage.getItem(LS_DATASET) !== null) throw new Error('旧活动数据集未能删除');
  dirtyProjectStores.delete(LS_DATASET);
}

function removeActiveRefVerified(expectedName?: string): void {
  const current = localStorage.getItem(LS_ACTIVE_REF);
  if (expectedName !== undefined && current !== expectedName) return;
  localStorage.removeItem(LS_ACTIVE_REF);
  if (localStorage.getItem(LS_ACTIVE_REF) !== null) {
    throw new Error('活动数据集恢复引用未能删除');
  }
}

function trackVaultWrite(promise: Promise<void>): Promise<void> {
  const tracked = promise.finally(() => vaultWrites.delete(tracked));
  vaultWrites.add(tracked);
  return tracked;
}

function reportVaultBackpressure(data: StoredDataset, detail: string): void {
  if (useData.getState().model.name === data.name) setActiveUnpersisted(true);
  sessionLog(`本机数据集归档已阻断 · ${detail}`);
  if (vaultBackpressureWarned) return;
  vaultBackpressureWarned = true;
  try {
    useApp.getState().showToast(`本机数据集归档队列已满：${detail}。请等待落盘或先${PROJECT_BACKUP_HINT}备份后重试`);
  } catch { /* 非 UI 环境忽略 */ }
}

function forgetFailedVaultArchive(name: string): void {
  const previous = failedVaultArchives.get(name);
  if (!previous) return;
  failedVaultArchives.delete(name);
  failedVaultArchiveBytes = Math.max(0, failedVaultArchiveBytes - previous.bytes);
}

function rememberFailedVaultArchive(data: StoredDataset, bytes: number): void {
  const previous = failedVaultArchives.get(data.name);
  const nextCount = failedVaultArchives.size + (previous ? 0 : 1);
  const nextBytes = failedVaultArchiveBytes - (previous?.bytes ?? 0) + bytes;
  // enqueue 在发起 put 前已预留了失败保全预算，此分支只是防御不变量被未来代码打破。
  if (nextCount > MAX_FAILED_VAULT_ARCHIVES || nextBytes > MAX_FAILED_VAULT_ARCHIVE_BYTES) {
    reportVaultBackpressure(data, '失败副本保全预算已满，新归档已停止');
    return;
  }
  if (previous) failedVaultArchiveBytes -= previous.bytes;
  failedVaultArchives.set(data.name, { data, bytes });
  failedVaultArchiveBytes += bytes;
}

function reserveVaultRequest(data: StoredDataset, bytes: number): string | null {
  const priorFailed = failedVaultArchives.get(data.name);
  const retainedFailureCount = failedVaultArchives.size - (priorFailed ? 1 : 0)
    + reservedVaultWriteRequests + 1;
  const retainedFailureBytes = failedVaultArchiveBytes - (priorFailed?.bytes ?? 0)
    + reservedVaultWriteBytes + bytes;
  if (reservedVaultWriteRequests + 1 > MAX_VAULT_WRITE_REQUESTS
    || reservedVaultWriteBytes + bytes > MAX_VAULT_WRITE_BYTES) {
    return `队列超过 ${MAX_VAULT_WRITE_REQUESTS} 个请求或 ${Math.round(MAX_VAULT_WRITE_BYTES / 1024 / 1024)} MiB 总字节预算`;
  }
  if (retainedFailureCount > MAX_FAILED_VAULT_ARCHIVES
    || retainedFailureBytes > MAX_FAILED_VAULT_ARCHIVE_BYTES) {
    return `失败副本将超过 ${MAX_FAILED_VAULT_ARCHIVES} 份或 ${Math.round(MAX_FAILED_VAULT_ARCHIVE_BYTES / 1024 / 1024)} MiB 保全预算`;
  }
  // 同名新载荷是旧失败载荷的 latest-wins 超集；由本请求的预留接管唯一副本。
  forgetFailedVaultArchive(data.name);
  reservedVaultWriteRequests += 1;
  reservedVaultWriteBytes += bytes;
  return null;
}

function resizeVaultReservation(request: VaultWriteRequest, nextBytes: number): string | null {
  const delta = nextBytes - request.bytes;
  if (reservedVaultWriteBytes + delta > MAX_VAULT_WRITE_BYTES
    || failedVaultArchiveBytes + reservedVaultWriteBytes + delta > MAX_FAILED_VAULT_ARCHIVE_BYTES) {
    return `latest 载荷将使归档队列超过 ${Math.round(MAX_VAULT_WRITE_BYTES / 1024 / 1024)} MiB 总字节预算`;
  }
  reservedVaultWriteBytes += delta;
  return null;
}

function releaseVaultReservation(request: VaultWriteRequest): void {
  if (request.reservationReleased) return;
  request.reservationReleased = true;
  reservedVaultWriteRequests = Math.max(0, reservedVaultWriteRequests - 1);
  reservedVaultWriteBytes = Math.max(0, reservedVaultWriteBytes - request.bytes);
}

function pumpGlobalVaultWrites(): void {
  while (activeGlobalVaultWrites < MAX_CONCURRENT_VAULT_WRITES && globalVaultRunQueue.length > 0) {
    const scheduled = globalVaultRunQueue.shift()!;
    activeGlobalVaultWrites += 1;
    const { db, name, request } = scheduled;
    const autoCopyClaim = request.data.vaultInsertOnly === true && !sessionClaimedCopyNames.has(name);
    const write = request.insertOnly || autoCopyClaim
      ? Promise.resolve().then(async () => {
        if (!db.insert) throw new Error('本机数据集库不支持安全创建副本，请更新桌面程序');
        if (!await db.insert(name, request.json)) throw new DatasetNameCollisionError(name);
      })
      : db.put(name, request.json);
    void write.then(() => {
      releaseVaultReservation(request);
      if (request.generation === vaultWorkGeneration) {
        if (autoCopyClaim) confirmAutoCopyClaim(name);
        forgetFailedVaultArchive(name);
        vaultBackpressureWarned = false;
        try { request.handlers.succeeded?.(); } catch { /* SQLite 已 durable，记账失败不改写入事实 */ }
      }
      request.resolve();
    }, (error) => {
      releaseVaultReservation(request);
      if (request.generation === vaultWorkGeneration) {
        // 创建失败时原工作表尚未切换；不能把候选名记入普通 put 重试，
        // 否则碰撞或未知提交结果会在下一次项目导出时变成覆盖旧记录。
        if (!request.insertOnly) rememberFailedVaultArchive(request.data, request.bytes);
        if (autoCopyClaim) {
          const detail = `自动副本「${name}」尚未安全归档：${error instanceof DatasetNameCollisionError ? '名称已被旧记录占用，旧记录未改动' : errText(error)}。当前编辑仍保留，请用“另存为副本”换名保存，或导出 CSV 备份`;
          sessionLog(detail);
          try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
        }
        try { request.handlers.failed?.(); } catch { /* 保留原始写库错误 */ }
      }
      request.reject(error);
    }).finally(() => {
      const current = vaultWriteQueues.get(name);
      if (current) {
        const next = current.pending;
        if (next) {
          current.pending = undefined;
          current.running = next;
          globalVaultRunQueue.push({ db, name, request: next });
        } else {
          vaultWriteQueues.delete(name);
        }
      }
      activeGlobalVaultWrites = Math.max(0, activeGlobalVaultWrites - 1);
      pumpGlobalVaultWrites();
    });
  }
}

/** 按名称串行。普通 latest 合并；不可合并请求会等现有 pending 完成后再入槽。 */
function enqueueVaultPut(
  db: NonNullable<typeof platform.datasetDb>,
  data: StoredDataset,
  handlers: { succeeded?: () => void; failed?: () => void } = {},
  options: { coalesce?: boolean; insertOnly?: boolean } = {},
): Promise<void> {
  const insertOnly = options.insertOnly === true;
  const coalesce = !insertOnly && options.coalesce !== false;
  const queue = vaultWriteQueues.get(data.name);
  let json: string;
  // 库记录只有写入成功才存在；恢复标记只属于未确认的本地快照，不写入 SQLite。
  try { json = JSON.stringify({ ...data, vaultInsertOnly: undefined }); } catch (error) { return Promise.reject(error); }
  const bytes = new TextEncoder().encode(json).byteLength;
  if (queue?.pending?.coalesce && coalesce) {
    // 所有普通调用共享唯一 pending completion；替换载荷不累积 waiter/promise。
    const budgetError = resizeVaultReservation(queue.pending, bytes);
    if (budgetError) {
      reportVaultBackpressure(data, budgetError);
      return Promise.reject(new Error(budgetError));
    }
    queue.pending.data = data;
    queue.pending.json = json;
    queue.pending.bytes = bytes;
    queue.pending.generation = vaultWorkGeneration;
    queue.pending.handlers = handlers;
    return queue.pending.completion;
  }
  if (queue?.pending) {
    const detail = `同名数据集「${data.name}」已有在途和待写的不可合并副本`;
    reportVaultBackpressure(data, detail);
    return Promise.reject(new Error(detail));
  }
  const budgetError = reserveVaultRequest(data, bytes);
  if (budgetError) {
    reportVaultBackpressure(data, budgetError);
    return Promise.reject(new Error(budgetError));
  }
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const raw = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  const completion = trackVaultWrite(raw);
  const request: VaultWriteRequest = {
    data, json, bytes, generation: vaultWorkGeneration,
    handlers, coalesce, insertOnly, resolve, reject, completion, reservationReleased: false,
  };
  if (!queue) {
    vaultWriteQueues.set(data.name, { running: request });
    globalVaultRunQueue.push({ db, name: data.name, request });
    pumpGlobalVaultWrites();
  } else {
    queue.pending = request;
  }
  return completion;
}

/** 只等源名称，不等整个 vaultWrites（其中包含正在执行的 saveAsCopy 本身）。 */
async function settleVaultName(name: string): Promise<void> {
  for (let queue = vaultWriteQueues.get(name); queue; queue = vaultWriteQueues.get(name)) {
    await Promise.allSettled([queue.running.completion, ...(queue.pending ? [queue.pending.completion] : [])]);
  }
}

/**
 * 当前源表的精确矩阵已用新名称独立落库，且等待期间没有新意图：其旧的未认领
 * 自动副本镜像（包括较早 latest-wins 版本）才可退休。绝不删除/修改旧名称的 DB 行。
 */
function retireUnclaimedCopySource(name: string): void {
  if (!unclaimedCopyNames.has(name)) return;
  const pending = vaultTimers.get(name);
  if (pending?.data.vaultInsertOnly) removeVaultTimer(name);
  const failed = failedVaultArchives.get(name);
  if (failed?.data.vaultInsertOnly) forgetFailedVaultArchive(name);
  const required = requiredVaultSnapshotFor(name);
  if (required?.data.vaultInsertOnly) clearRequiredVaultSnapshot(name, required.data);
  if (lightweightRecentDurability.get(name)?.vaultInsertOnly) lightweightRecentDurability.delete(name);
  // 旧名称可能确实属于隐藏历史行；移除本地候选入口后，从库加载将看到真实旧数据。
  useData.setState({ recents: useData.getState().recents.filter((entry) => entry.name !== name) });
  unclaimedCopyNames.delete(name);
  syncActiveUnpersisted();
}

async function waitForVaultWrites(): Promise<void> {
  // 导入只需确认旧写入已经结束；旧镜像失败不应阻止用户用项目文件恢复。
  // 导出若涉及超配额活动表，会在 flushPendingVaultWrites 中重试最新载荷并 fail-closed。
  while (vaultWrites.size > 0) await Promise.allSettled([...vaultWrites]);
}

/** 清空数据时在取消新任务后等待已进入 SQLite 的旧写入完成，避免“清完后复活”。 */
export async function settlePendingDatasetWrites(): Promise<void> {
  await waitForVaultWrites();
}

/**
 * 清库 prepare 阶段：冻结尚未提交的 timer，并等待已进入 SQLite 的写入结束。
 * 载荷、失败副本、dirty store 与 beforeunload 标记全部保留，只有清库全部成功后
 * 才由 cancelPendingDatasetWork 提交销毁。
 */
export async function quiescePendingDatasetWorkForClear(): Promise<void> {
  datasetClearQuiesced = true;
  flushPendingCellPersistence();
  for (const pending of vaultTimers.values()) {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
  }
  await waitForVaultWrites();
}

/** 清库任一步失败时恢复普通归档，并显式维持离开警告。 */
export function resumePendingDatasetWorkAfterClearFailure(): void {
  if (datasetClearQuiesced) {
    datasetClearQuiesced = false;
    const pending = [...vaultTimers.values()].map(({ data }) => data);
    vaultTimers.clear();
    vaultTimerBytes = 0;
    for (const data of pending) archiveToVault(data);
  }
  setActiveUnpersisted(true);
}

/** 删除单个库数据集前，取消同名防抖并等待更早的同名/其他在途写入落定。 */
export async function prepareVaultDatasetRemoval(name: string): Promise<void> {
  if (useData.getState().model.name === name) {
    throw new Error(`不能删除当前活动数据集「${name}」；请先切换数据集或${PROJECT_BACKUP_HINT}备份`);
  }
  removeVaultTimer(name);
  await waitForVaultWrites();
  let activeRef: string | null = null;
  try { activeRef = localStorage.getItem(LS_ACTIVE_REF); } catch { /* 由下面其他守卫继续保护 */ }
  if (useData.getState().model.name === name || requiredVaultSnapshotFor(name) || activeRef === name) {
    throw new Error(`不能删除当前活动数据集「${name}」；请先切换数据集或${PROJECT_BACKUP_HINT}备份`);
  }
  forgetFailedVaultArchive(name);
}

/** 库删除收口对同名最近条目的处置结果。 */
export type VaultRemovalRecentOutcome = 'none' | 'removed' | 'kept-different';

/**
 * 本机库删除成功后的收口(fix2609d G4c)：同名最近条目带着全量副本，若留在列表里，之后点 × 或被自然挤出时
 * settleEvictedRecents 会按只插入把它重新写回库，用户刚确认删除的内容随之复活。库删除是用户对该名称的
 * 明确删除意图，同步从最近列表移除，且不经过 settleEvictedRecents。
 *
 * fix2609f G4d:按内容核对，不按名称一刀切。removedJson 是删除前从库中取出的原文。
 * - 最近条目(或其 light 模式保全载荷)与库内原文内容相同，或为既无矩阵也无保全载荷的轻量条目 → 一并移除；
 * - 内容不同(如桌面端导入不带 vault 的项目，最近列表里的 X 从未入库) → 保留，它之后按只插入入库是合法保全；
 *   无法取得库内原文(removedJson 为 null)时同样保守保留带矩阵的条目，绝不让唯一副本随删除消失。
 * light 模式下同名的保全载荷(lightweightRecentDurability)与被删内容相同时一并收口，否则导出前的
 * flushPendingVaultWrites 会用 put 把刚删的内容写回库。
 */
export function completeVaultDatasetRemoval(name: string, removedJson: string | null): VaultRemovalRecentOutcome {
  disarmEvictionConfirmation();
  const st = useData.getState();
  const entry = st.recents.find((candidate) => candidate.name === name);
  const retained = lightweightRecentDurability.get(name);
  const sameAsRemoved = (data: StoredDataset) => removedJson !== null && sameStoredContentJson(removedJson, data);
  if (retained && sameAsRemoved(retained)) {
    lightweightRecentDurability.delete(name);
    syncActiveUnpersisted();
  }
  if (!entry) return 'none';
  const exact = entry.data ?? lightweightRecentDurability.get(name);
  if (exact && !sameAsRemoved(exact)) {
    sessionLog(`数据集库删除「${name}」：最近列表中另有内容不同的同名数据集，未删除(之后按只插入入库)`);
    return 'kept-different';
  }
  const recents = st.recents.filter((candidate) => candidate.name !== name);
  useData.setState({ recents });
  pristineDatasets.delete(name);
  persistRecents(recents);
  sessionLog(`数据集库删除「${name}」后同步移出最近列表`);
  return 'removed';
}

/** 导出项目前把 400ms 防抖内容即时写入，并等待所有已经提交的 SQLite 写入。 */
/**
 * 等待某数据集的异步归档落定并回报成败(盲审 P3:此前 archiving 只是「已提交」,
 * 失败时界面永远停在「正在归档到本机库」,用户以为副本已安全)。
 * 复用既有的 flush 通道,不另开一套排队逻辑。
 */
export async function awaitDatasetArchived(name: string): Promise<boolean> {
  try {
    await flushPendingVaultWrites();
  } catch {
    return false;
  }
  if (failedVaultArchives.has(name)) return false;
  const db = platform.datasetDb;
  if (!db) return false;
  try {
    const stored = await db.get(name);
    return stored != null;
  } catch {
    return false;
  }
}

async function flushPendingVaultWrites(): Promise<void> {
  const db = platform.datasetDb;
  const pending = [...vaultTimers.values()];
  pending.forEach(({ timer }) => { if (timer !== null) clearTimeout(timer); });
  vaultTimers.clear();
  vaultTimerBytes = 0;
  // 先等已经提交的旧写入结束，再写本轮捕获的最新防抖值；顺序反过来会让迟到旧写覆盖新快照。
  await waitForVaultWrites();
  const latest = new Map<string, StoredDataset>(
    [...failedVaultArchives.entries()].map(([name, failed]) => [name, failed.data]),
  );
  for (const { data } of pending) latest.set(data.name, data);
  // 轻量 recent 没有矩阵，这些 exact 载荷与必保快照同级，导出/清理前必须等待落盘。
  for (const [name, data] of lightweightRecentDurability) latest.set(name, data);
  // 必保快照是 localStorage 也没有的精确版本，同名时必须覆盖普通失败/防抖载荷。
  for (const [name, retained] of requiredVaultSnapshots) latest.set(name, retained.data);
  if (overflowRequiredVaultSnapshot) {
    latest.set(overflowRequiredVaultSnapshot.data.name, overflowRequiredVaultSnapshot.data);
  }
  // 普通 archive timer/失败副本的活动数据仍可由 stores 导出；
  // 只有 localStorage 也没有、且可能已非当前表的必保快照必须 fail-closed。
  if ((requiredVaultSnapshots.size > 0 || overflowRequiredVaultSnapshot) && !db) {
    throw new Error('仍有数据集尚未持久化，且 SQLite 数据集库不可用');
  }
  if (db) {
    for (const data of latest.values()) {
      await enqueueVaultPut(db, data);
      if (lightweightRecentDurability.get(data.name) === data) {
        lightweightRecentDurability.delete(data.name);
        syncActiveUnpersisted();
      }
      // 初次 put 的回调可能已清理；导出重试无回调，在这里精确收口。
      confirmRequiredVaultSnapshotDurable(data);
    }
  }
}

/** 清空数据前取消尚未落库的防抖任务，并使所有在途加载/恢复请求失效。 */
export function cancelPendingDatasetWork(): void {
  datasetClearQuiesced = false;
  cancelPendingCellPersistence();
  // 清库/全量复位：导出期间暂存、尚未重放的编辑属于被清除的数据集(fix2609j GAP-7-15)。
  deferredExportEdits.length = 0;
  beginDatasetIntent();
  vaultWorkGeneration += 1;
  vaultTimers.forEach(({ timer }) => { if (timer !== null) clearTimeout(timer); });
  vaultTimers.clear();
  vaultTimerBytes = 0;
  failedVaultArchives.clear();
  failedVaultArchiveBytes = 0;
  vaultBackpressureWarned = false;
  requiredVaultSnapshots.clear();
  requiredVaultSnapshotBytes = 0;
  overflowRequiredVaultSnapshot = null;
  currentActiveUnpersistedFlag = false;
  recentsUnpersistedFlag = false;
  recentsPersistenceWarned = false;
  independentlyDurableRecoveryCopy = null;
  lightweightRecentDurability.clear();
  syncActiveUnpersisted();
  try { useData.setState({ recentsUnpersisted: false }); } catch { /* store 尚未就绪时忽略 */ }
  dirtyProjectStores.clear();
  protectedCorruptStores.clear();
  knownDatasetNames.clear();
  unclaimedCopyNames.clear();
  sessionClaimedCopyNames.clear();
  pristineDatasets.clear();
  evictionConfirmation = null;
  knownDatasetNames.add('质检数据.mtw');
}

export function archiveToVault(data: StoredDataset) {
  knownDatasetNames.add(data.name);
  const db = platform.datasetDb;
  if (!db) return;
  // 轻量 recent 的精确矩阵已绕过防抖即时入队，不再添加 400ms 重复任务。
  if (lightweightRecentDurability.get(data.name) === data) return;
  removeVaultTimer(data.name);
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength; } catch { return; }
  if (vaultTimers.size + reservedVaultWriteRequests + 1 > MAX_VAULT_WRITE_REQUESTS
    || vaultTimerBytes + reservedVaultWriteBytes + bytes > MAX_VAULT_WRITE_BYTES) {
    // 旧同名 timer 已被取消；若新载荷进不了有界队列，用可见失败阻止继续积压。
    reportVaultBackpressure(data, `防抖待归档载荷将超过 ${MAX_VAULT_WRITE_REQUESTS} 个请求或 ${Math.round(MAX_VAULT_WRITE_BYTES / 1024 / 1024)} MiB 预算`);
    return;
  }
  if (datasetClearQuiesced) {
    vaultTimers.set(data.name, { timer: null, data, bytes });
    vaultTimerBytes += bytes;
    return;
  }
  const timer = setTimeout(() => {
    removeVaultTimer(data.name);
    const write = enqueueVaultPut(db, data, {
      succeeded: () => {
        try { confirmRequiredVaultSnapshotDurable(data); } catch {
          // SQLite 已写入但 active-ref 未确认：保留快照和离开警告。
          if (useData.getState().model.name === data.name) setActiveUnpersisted(true);
        }
      },
    });
    // 普通镜像失败不打断编辑；项目导出会重试并显式失败。
    void write.catch(() => undefined);
  }, 400);
  vaultTimers.set(data.name, { timer, data, bytes });
  vaultTimerBytes += bytes;
}

function evictionWarning(detail: string): void {
  sessionLog(detail);
  try { useApp.getState().showToast(detail); } catch { /* 非 UI 环境忽略 */ }
}

function sameStoredContentJson(json: string, data: StoredDataset): boolean {
  try {
    const stored = JSON.parse(json) as StoredDataset;
    return sameDatasetContent(
      { colNames: stored.colNames, rows: stored.rows, textCols: stored.textCols ?? [], pendingCells: stored.pendingCells ?? [] },
      { colNames: data.colNames, rows: data.rows, textCols: data.textCols ?? [], pendingCells: data.pendingCells ?? [] },
    );
  } catch {
    return false;
  }
}

/**
 * 被挤出最近列表的数据集按只插入语义补入本机库(fix2609b M1 / PLATFORM-01)。
 * 名称已被库中同内容记录占用 → 已可找回；被不同内容占用 → 绝不覆盖，另存为「名 (n)」并提示。
 */
async function insertEvictedDataset(
  db: NonNullable<typeof platform.datasetDb>, data: StoredDataset, generation: number,
): Promise<void> {
  if (!db.insert) throw new Error('本机数据集库不支持安全只插入，请更新桌面程序');
  const payload = (name: string) => JSON.stringify({ ...data, name, vaultInsertOnly: undefined });
  if (generation !== vaultWorkGeneration) return;
  if (await db.insert(data.name, payload(data.name))) return;
  const existing = await db.get(data.name);
  if (existing != null && sameStoredContentJson(existing, data)) return;
  for (let sequence = 2; sequence <= 1000; sequence++) {
    if (generation !== vaultWorkGeneration) return;
    const candidate = numberedDatasetName(data.name, sequence);
    if (reservedPrototypeNameError(candidate)) continue;
    knownDatasetNames.add(candidate);
    if (await db.insert(candidate, payload(candidate))) {
      evictionWarning(`数据集「${data.name}」已移出最近列表；本机数据集库已有内容不同的同名记录（未覆盖），移出的版本已另存为「${candidate}」`);
      return;
    }
    const occupied = await db.get(candidate);
    if (occupied != null && sameStoredContentJson(occupied, data)) return;
  }
  throw new Error('本机数据集库中同名记录过多');
}

/**
 * 最近列表截断后的唯一收口(fix2609b M1)。
 * - 桌面端：被挤出且仍带矩阵的条目若不在现有归档管线中，按只插入语义补入本机库，
 *   兑现「移出最近列表的数据集仍可在库中找回」(覆盖无 vault 的 .qproj 导入等条目从未入库的路径)。
 * - Web 端：没有其他落盘位置，如实警告(新建类入口已在写入前拦截并要求确认)。
 */
function settleEvictedRecents(evicted: RecentEntry[]): void {
  if (evicted.length === 0) return;
  const db = platform.datasetDb;
  if (!db) {
    const names = evicted.map((entry) => `「${entry.name}」`).join('');
    evictionWarning(`最近列表已满（${MAX_RECENT_DATASETS} 个），${names}已移出最近列表；浏览器端没有本机数据集库，无法恢复`);
    return;
  }
  for (const entry of evicted) {
    const data = entry.data;
    // 轻量条目的精确矩阵已在库中或由 lightweightRecentDurability 保全。
    if (!data || data.name !== entry.name) continue;
    const name = entry.name;
    // 该名称的最新载荷仍由现有归档管线(防抖/在途/失败重试/必保快照)负责落库。
    if (vaultTimers.has(name) || vaultWriteQueues.has(name) || failedVaultArchives.has(name)
      || requiredVaultSnapshotFor(name) || lightweightRecentDurability.has(name)) continue;
    knownDatasetNames.add(name);
    const write = trackVaultWrite(insertEvictedDataset(db, data, vaultWorkGeneration));
    void write.catch((error) => {
      evictionWarning(`数据集「${name}」移出最近列表后未能补存到本机数据集库（${errText(error)}）；请尽快${PROJECT_BACKUP_HINT}备份`);
    });
  }
}

/** 某名称在本次写入后的实际位置。 */
function datasetLocation(name: string, recents: RecentEntry[]): ConflictDatasetLocation {
  if (recents.some((entry) => entry.name === name)) return 'recents';
  return platform.datasetDb ? 'vault' : 'lost';
}

/**
 * 按实际结果生成同名改名 / 挤出最近列表的提示(UI-04)：不写死「原数据集保留在最近列表」。
 * requestedName 为调用方请求的名称；无事可报时返回空数组。
 */
export function datasetWriteNotes(rawRequestedName: string, outcome: PersistOutcome): string[] {
  const notes: string[] = [];
  // importMatrix 会去掉名称首尾空格(STORE-15)；仅此差异不是「同名冲突改名」。
  const requestedName = rawRequestedName.trim();
  const renamed = outcome.name !== undefined && outcome.name !== requestedName;
  if (renamed) {
    const where = outcome.conflictLocation === 'vault'
      ? '原数据集不在最近列表，可在「数据 → 数据集库(本机)」中找回'
      : outcome.conflictLocation === 'lost'
        ? '原数据集已按确认移出最近列表，浏览器端无法恢复'
        : '原数据集保留在最近列表';
    notes.push(`已有内容不同的同名数据集「${requestedName}」，本次另存为「${outcome.name}」（${where}）`);
  }
  if (outcome.replacedPristine) {
    notes.push(`已替换未编辑的同名数据集「${outcome.name ?? requestedName}」（源表未变，可由同一操作重新得到；规格限沿用）`);
  }
  const others = (outcome.evicted ?? []).filter((name) => !(renamed && name === requestedName));
  if (others.length > 0) {
    notes.push(`${others.map((name) => `「${name}」`).join('')}已移出最近列表${platform.datasetDb
      ? '，可在「数据 → 数据集库(本机)」中找回'
      : '，浏览器端无法恢复'}`);
  }
  return notes;
}

/** 活动数据集落盘。localStorage 写不下时(超 ~5MB):桌面端即时归档到 SQLite
 * 并留恢复标记(重启自动恢复),Web 端沿用原有超限提示。 */
function persistActive(data: StoredDataset, options: { allowVaultFallback?: boolean } = {}): PersistOutcome {
  if (sessionClaimedCopyNames.has(data.name)) delete data.vaultInsertOnly;
  const db = platform.datasetDb;
  if (saveJson(LS_DATASET, data, db != null)) {
    // 同名新版已完整落到 localStorage，可接管该数据集的旧必保快照。
    clearRequiredVaultSnapshot(data.name);
    try {
      removeActiveRefVerified();
    } catch (error) {
      // localStorage 新值虽已落盘，但旧 ref 会让下次启动面临权威冲突。
      // 删除经读回确认前不能对 UI 报持久成功。
      setActiveUnpersisted(true);
      return { persisted: false, archiving: false, rejected: errText(error) };
    }
    setActiveUnpersisted(false);
    return { persisted: true, archiving: false };
  }
  if (!db || options.allowVaultFallback === false) {
    setActiveUnpersisted(true);
    return { persisted: false, archiving: false };
  } // Web 端或安全副本活动槽失败：仅内存，独立副本由调用方另行确认
  const retained = retainRequiredVaultSnapshot(data);
  if (retained === 'blocked') {
    const rejected = `未持久化快照保全预算已满；请立即${PROJECT_BACKUP_HINT}备份，在此前不要关闭页面`;
    reportVaultBackpressure(data, rejected);
    setActiveUnpersisted(true);
    return { persisted: false, archiving: false, rejected };
  }
  if (retained === 'overflow') {
    reportVaultBackpressure(data, '必保快照已进入溢出保全槽，完成落盘前已禁止替换数据集');
  }
  removeVaultTimer(data.name); // 绕过防抖,立即归档,避免窗口期丢数据
  const write = enqueueVaultPut(db, data, {
    succeeded: () => {
      const isCurrent = useData.getState().model.name === data.name;
      try {
        // 配额已满时先移除旧的活动矩阵副本，再写极小的 SQLite 恢复引用。
        if (!confirmRequiredVaultSnapshotDurable(data)) return;
        if (isCurrent) sessionLog(`数据集 ${data.name} 超浏览器配额,已存入本机数据集库(重启自动恢复)`);
      } catch {
        // SQLite 已成功，但未能建立重启恢复引用；数据仍保留在库中。
        if (isCurrent) setActiveUnpersisted(true);
        return;
      }
      if (isCurrent) {
        try { useApp.getState().showToast('数据集超出浏览器存储配额,已安全存入本机数据集库,重启自动恢复'); } catch { /* 非 UI 环境忽略 */ }
      }
    },
    failed: () => {
      // 只有成功写库后才建立 active-ref；失败时绝不能让旧同名库数据冒充本次活动表。
      try { removeActiveRefVerified(data.name); } catch { /* 引用保留以便启动时做内容冲突裁决 */ }
      // 非当前数据集的失败也由 requiredVaultSnapshots 维持全局离开警告；仅限制 toast。
      // 同名迟到 A1 失败也不得把已落盘的 A2 重新标成未持久化。
      if (!ownsRequiredVaultSnapshot(data) || useData.getState().model.name !== data.name) return;
      setActiveUnpersisted(true);
      try { useApp.getState().showToast('数据集过大且归档失败,当前数据尚未持久化；请释放空间后重试'); } catch { /* 非 UI 环境忽略 */ }
    },
  });
  // 消化普通编辑路径的 rejection；自动回看会通过 durability 再显式 await 同一承诺。
  void write.catch(() => undefined);
  setActiveUnpersisted(true); // 归档完成前视为未持久化;成功回调会清除
  return { persisted: false, archiving: true, durability: write };
}

/** 最近列表落盘。写不下时桌面端把条目瘦身(仅名称/时间,数据在 SQLite 库)再写一次。 */
function persistRecents(recents: RecentEntry[], exactData?: StoredDataset, options: { silent?: boolean } = {}): boolean {
  for (const entry of recents) {
    if (entry.data && sessionClaimedCopyNames.has(entry.name)) delete entry.data.vaultInsertOnly;
  }
  const db = platform.datasetDb;
  if (saveJson(LS_RECENTS, recents, db != null || options.silent === true)) {
    for (const entry of recents) lightweightRecentDurability.delete(entry.name);
    setRecentsUnpersisted(false);
    return true;
  }
  if (db) {
    // light 会一次剔掉所有 recent 条目的矩阵；不能只保全当前表。
    // 例如 A 还在 400ms 归档窗口时 B 触发 light，A/B 都必须立即入库。
    const exactByName = new Map<string, StoredDataset>();
    for (const entry of recents) {
      if (entry.data) exactByName.set(entry.name, entry.data);
    }
    if (exactData) exactByName.set(exactData.name, exactData);
    if (exactByName.size > MAX_RECENT_DATASETS) {
      setRecentsUnpersisted(true);
      return false;
    }
    const light = recents.map((r) => ({ name: r.name, savedAt: r.savedAt }));
    if (saveJson(LS_RECENTS, light, true)) {
      // 先同步保留全部 exact 对象并撤掉旧 timer，再发起任何 put；
      // 成功回调仅能释放它自己对应的对象版本。
      for (const [name, data] of exactByName) {
        lightweightRecentDurability.set(name, data);
        removeVaultTimer(name);
      }
      syncActiveUnpersisted();
      for (const [name, data] of exactByName) {
        const write = enqueueVaultPut(db, data, {
          succeeded: () => {
            if (lightweightRecentDurability.get(name) === data) {
              lightweightRecentDurability.delete(name);
              syncActiveUnpersisted();
            }
          },
          failed: () => {
            if (lightweightRecentDurability.get(name) === data) {
              syncActiveUnpersisted();
            }
          },
        });
        void write.catch(() => undefined);
      }
      setRecentsUnpersisted(false);
      return true;
    }
  }
  setRecentsUnpersisted(true);
  return false;
}

/**
 * 高频单格编辑只合并持久化 I/O，内存 model/撤销栈在每次输入后立即更新。
 * 导出、项目替换、撤销以及 beforeunload 都会显式 flush/cancel，避免旧 timer
 * 在新状态之后迟到覆盖。
 */
function flushPendingCellPersistence(): void {
  if (pendingCellPersistenceTimer) clearTimeout(pendingCellPersistenceTimer);
  pendingCellPersistenceTimer = null;
  const pending = pendingCellPersistence;
  pendingCellPersistence = null;
  if (!pending) return;
  persistActive(pending.data);
  persistRecents(pending.recents, pending.data);
  archiveToVault(pending.data);
}

function cancelPendingCellPersistence(): void {
  if (pendingCellPersistenceTimer) clearTimeout(pendingCellPersistenceTimer);
  pendingCellPersistenceTimer = null;
  pendingCellPersistence = null;
}

function scheduleCellPersistence(data: StoredDataset, recents: RecentEntry[]): void {
  pendingCellPersistence = { data, recents };
  if (pendingCellPersistenceTimer) clearTimeout(pendingCellPersistenceTimer);
  setActiveUnpersisted(true);
  // 合并同一事件循环内的连续输入，同时在 SQLite 的 400 ms 归档窗口开始前
  // 尽快写回 localStorage。额外等待 120 ms 会把总归档延迟拉到 520 ms，
  // 破坏既有的 500 ms durability 合同。
  pendingCellPersistenceTimer = setTimeout(flushPendingCellPersistence, 0);
}

// 盲审 P2:另一标签页更新最近列表时重新水合,避免本标签用内存旧值整表覆盖
watchExternalWrite(LS_RECENTS, () => {
  const fresh = loadValidatedStoreJson<RecentEntry[]>(LS_RECENTS);
  if (!Array.isArray(fresh)) return;
  let localActive: StoredDataset | null = null;
  const unpersistedLocal = activeUnpersistedFlag || recentsUnpersistedFlag;
  if (unpersistedLocal) {
    // fix2609b M2:本窗口活动表尚未完整落盘时，localStorage 里要么没有它、要么是旧版本；
    // 权威版本只在内存中，外部列表不得把它挤掉或回退。
    localActive = inMemoryActiveDataset(useData.getState());
  } else {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_DATASET) ?? 'null') as unknown;
      if (!projectStoreValidationError(LS_DATASET, parsed)
        && (parsed as StoredDataset).name === useData.getState().model.name) {
        localActive = parsed as StoredDataset;
      }
    } catch { /* 损坏活动槽由其自身启动校验负责，不能拿来覆盖 recent */ }
  }
  const coordinated = coordinateRecentsWithActive(fresh, localActive);
  const before = useData.getState().recents.length;
  useData.setState({ recents: coordinated.recents });
  // fix2609d G4c:未落盘分支只在内存里保住活动表，不在监听器里回写——否则另一窗口按其 LS_DATASET
  // 协调同名条目后再写回，两窗口交替写 LS_RECENTS 无限乒乓。落盘交给闸门重试或下一次编辑。
  // fix2609f G4d:但内存与磁盘此时已分叉，必须静默标记(不弹提示)，让闸门继续拦截切换并在下一次切换时
  // 用内存列表重试写盘——每次用户操作最多写一次；否则切换数据集后本窗口的编辑从任何持久化位置消失。
  if (coordinated.changed && !unpersistedLocal) persistRecents(coordinated.recents, localActive ?? undefined);
  else if (coordinated.changed) markRecentsDivergedSilently();
  if (coordinated.recents.length !== before) {
    try {
      useApp.getState().showToast(`另一窗口更新了最近数据集列表（${coordinated.recents.length} 项），已同步到本窗口`);
    } catch { /* 非浏览器环境忽略 */ }
  }
  // 挤出警告放在同步提示之后，不被覆盖。
  settleEvictedRecents(coordinated.evicted);
});

/**
 * 本 store 负责的项目键(fix2609m A3)。规格限/副本序号是懒加载的(只在能力页/SPC/另存为副本时读取)，
 * 启动后直接保存项目时读取侧从未触达它们：导出侧的降级视图只认「已在隔离区」的原文，于是整份拒绝。
 */
const OWNED_PROJECT_STORE_KEYS = [LS_DATASET, LS_RECENTS, LS_ATTR, LS_SPECS, LS_PARETO, LS_COPY_SEQUENCES] as const;

/**
 * 已登记写保护的键在导出前重试隔离(fix2609n C1)。在 saveJson 口径(live 为 null 即解除、否则隔离)之上，
 * 另按 C1 决定：live 已被改写为合法值时直接解除：
 * - live 已不存在(被清除)，或已被另一窗口改写为合法值 → 损坏原文已不在 live，保护解除；
 * - live 仍损坏(同一原文或新的损坏原文)→ quarantineCorruptStore 复制进隔离区，成功即解除，失败保护保留(fail-closed)。
 */
function retryProtectedProjectStore(key: string, entry: { raw: string; detail: string }): void {
  let live: string | null = entry.raw;
  try { live = localStorage.getItem(key); } catch { /* 读不到 live 时按已捕获原文重试 */ }
  if (live == null) {
    protectedCorruptStores.delete(key);
    return;
  }
  let detail: string | null = entry.detail;
  if (live !== entry.raw) {
    try {
      detail = projectStoreValidationError(key, JSON.parse(live) as unknown);
    } catch {
      detail = 'JSON 解析失败或写入被截断';
    }
    if (detail === null) {
      protectedCorruptStores.delete(key);
      return;
    }
  }
  quarantineCorruptStore(key, live, detail);
}

/**
 * 导出取快照前按读取侧同一函数(loadValidatedStoreJson)逐键校验 live 值：损坏的先复制进隔离区，
 * 导出再按降级视图省略该键；隔离失败则登记 protectedCorruptStores，由调用方 fail-closed。
 * 已有 dirty 覆盖载荷的键导出取内存最新值，live 旧值与导出无关，不在此强行隔离(存储已满时只会徒增拒绝)。
 * fix2609n C1:但**已登记写保护**的键(不论有无 dirty)一律先重试隔离——否则用户按提示释放空间后重试仍被拒，
 * live 被另一窗口修正/清除后也永远解不开。
 */
function revalidateOwnedProjectStores(): void {
  const retried = new Set<string>();
  for (const [key, entry] of [...protectedCorruptStores]) {
    retryProtectedProjectStore(key, entry);
    retried.add(key);
  }
  for (const key of OWNED_PROJECT_STORE_KEYS) {
    if (retried.has(key) || dirtyProjectStores.has(key)) continue;
    loadValidatedStoreJson<unknown>(key);
  }
}

registerProjectLifecycleHooks({
  beforeMutation: () => {
    // 先阻止新加载/新防抖触发，但保留待写载荷；只有 flush 成功后项目导入才可继续。
    beginDatasetIntent();
    vaultTimers.forEach(({ timer }) => { if (timer !== null) clearTimeout(timer); });
  },
  settleBeforeMutation: async () => {
    flushPendingCellPersistence();
    await flushPendingVaultWrites();
  },
  beforeExport: async (owner) => {
    if (projectExportOwner !== null) throw new Error('已有项目导出正在进行');
    projectExportOwner = owner;
    revalidateOwnedProjectStores();
    if (protectedCorruptStores.size > 0) {
      releaseProjectExportOwner(owner);
      throw new Error(`损坏的本地数据尚未成功复制到隔离区（${[...protectedCorruptStores.keys()].join('、')}），项目未导出；`
        + `请先${STORAGE_SPACE_RELEASE_HINT}，再重试保存项目（损坏原文仍保留在本机，不会被覆盖）`);
    }
    try {
      flushPendingCellPersistence();
      await flushPendingVaultWrites();
    } catch (error) {
      releaseProjectExportOwner(owner);
      throw error;
    }
    return () => releaseProjectExportOwner(owner);
  },
  projectStoreOverrides: () => Object.fromEntries(dirtyProjectStores),
});

/** 编辑落库：演示集首次编辑转「质检数据 (副本)」,导入集原名持久化并同步最近列表。
 * colNames 省略时沿用当前列名（值编辑）;传入时用于列结构变化（重命名/增删列）。 */
function worksheetMutationError(
  rows: number[][],
  colNames: string[],
  textCols: TextColumn[],
  pendingCells: PendingCell[],
): string | null {
  // 第一段只读取顶层长度。结构编辑即使意外构造出超限载荷，也必须在 pending
  // 位图、文本扫描、模型计算、意图推进、撤销栈和任何持久化之前原子拒绝。
  const dimensionError = worksheetResourceError({
    rows: rows.length,
    cols: colNames.length,
    textCols: textCols.length,
  });
  if (dimensionError) return dimensionError;

  const pendingError = worksheetPendingCellsError(pendingCells, {
    rows: rows.length,
    cols: colNames.length,
  });
  if (pendingError) return pendingError;

  // 维度已限定在 200 万格内，再做字符预算；不用 spread 构造巨型临时数组。
  let maxColumnNameChars = 0;
  for (const name of colNames) maxColumnNameChars = Math.max(maxColumnNameChars, name.length);
  let maxCellChars = 0;
  for (const column of textCols) {
    maxColumnNameChars = Math.max(maxColumnNameChars, column.name.length);
    for (const value of column.values) maxCellChars = Math.max(maxCellChars, value.length);
  }
  return worksheetResourceError({
    rows: rows.length,
    cols: colNames.length,
    textCols: textCols.length,
    maxCellChars,
    maxColumnNameChars,
  });
}

function rejectWorksheetResize(rows: number, cols: number, textCols: number): string | null {
  const detail = worksheetResourceError({ rows, cols, textCols });
  if (!detail) return null;
  try { useApp.getState().showToast(`工作表编辑已拒绝：${detail}`); } catch { /* 非 UI 环境忽略 */ }
  return detail;
}

function applyEdit(
  set: SetFn, get: GetFn, rows: number[][], textCols: TextColumn[], colNames?: string[],
  pendingCells: PendingCell[] = get().pendingCells, deferPersistence = false,
  buildEditedModel?: (name: string) => VarModel,
): string | null {
  const st = get();
  const m = st.model;
  const cols = colNames ?? m.colNames;
  const validationError = worksheetMutationError(rows, cols, textCols, pendingCells);
  if (validationError) {
    try { useApp.getState().showToast(`工作表编辑已拒绝：${validationError}`); } catch { /* 非 UI 环境忽略 */ }
    return validationError;
  }
  const exportRefusal = exportEditRefusal();
  if (exportRefusal) return exportRefusal;

  beginDatasetIntent();
  // 编辑前快照入撤销栈,清空重做栈
  const undo = trimSnapshotStackWithInfo([...st.undoStack, snapshotOf(st)]);
  set({
    undoStack: undo.stack,
    redoStack: [],
    undoBudgetLimited: undo.budgetLimited,
  });
  // 双审 P1:副本名唯一化——固定「质检数据 (副本)」会在「恢复演示→再编辑」时
  // 静默覆盖旧副本中用户已录入的数据
  const name = m.isDemo
    ? allocateCopyName(m.name, [m.name, ...get().recents.map((r) => r.name)])
    : m.name;
  if (m.isDemo && platform.datasetDb) unclaimedCopyNames.add(name);
  const model = buildEditedModel ? buildEditedModel(name) : computeVarModel(name, cols, rows);
  const data: StoredDataset = { name, colNames: cols, rows, textCols, pendingCells, savedAt: new Date().toISOString(), ...storedModelMetadata(model, rows) };
  pristineDatasets.delete(m.name);
  pristineDatasets.delete(name);
  const { recents, evicted } = trimRecents([
    { name, savedAt: data.savedAt, data },
    ...get().recents.filter((r) => !sameDatasetName(r.name, name)),
  ]);
  set({ model, textCols, pendingCells, recents });
  if (undo.budgetLimited) warnUndoBudget(name, undo.stack.length);
  // 双审 P2:带占位的工作表(新建/DOE 设计)录满后必须重新建议规格限,
  // 否则能力页永远沿用上一份数据集的 LSL/USL(specForActiveMeasurement 有已存规格时优先返回已存,无副作用)
  if (st.pendingCells.length > 0 && pendingCells.length === 0) {
    try { suggestSpec(model, textCols); } catch { /* 建议失败不阻断编辑 */ }
  }

  if (deferPersistence) scheduleCellPersistence(data, recents);
  else {
    // 结构编辑/撤销等新状态会包含之前的单格改动，取消旧 timer 后直接持久化新状态。
    cancelPendingCellPersistence();
    persistActive(data);
    persistRecents(recents, data);
    archiveToVault(data);
  }
  settleEvictedRecents(evicted);
  return null;
}

export const useData = create<DataState>((set, get) => ({
  model: initModel,
  textCols: initText,
  pModel: initP,
  cModel: initC,
  paretoModel: loadValidatedStoreJson<ParetoModel>(LS_PARETO),
  pendingCells: initPending,
  recents: storedRecents,
  activeUnpersisted: recentsUnpersistedFlag,
  recentsUnpersisted: recentsUnpersistedFlag,
  mesRunning: false,
  undoStack: [],
  redoStack: [],
  undoBudgetLimited: false,

  importMatrix: (rawRequestedName, colNames, rows, textCols = [], pendingCells = [], modelOptions = {}) => {
    // fix2609j STORE-15:数据集名在唯一写入口规范化(与另存为/校验同口径)。文件名常带首尾空格，
    // 原样写入会与去掉空格的同名数据集并存为两条，最近列表随即被校验判为重名损坏、导出被阻断。
    const requestedName = typeof rawRequestedName === 'string' ? rawRequestedName.trim() : rawRequestedName;
    if (!Array.isArray(colNames) || !Array.isArray(rows) || !Array.isArray(textCols)) {
      throw new Error('数据集矩阵结构无效，已拒绝导入');
    }
    // 先只读取顶层 length。超行/超列/超单元格的运行时调用不能先触发
    // rows.some、列名扫描、文本字符扫描或 pendingCells 位图分配。
    const dimensionError = worksheetResourceError({
      rows: rows.length,
      cols: colNames.length,
      textCols: textCols.length,
    });
    if (dimensionError) throw new Error(dimensionError);
    const pendingError = worksheetPendingCellsError(pendingCells, {
      rows: rows.length,
      cols: colNames.length,
    });
    if (pendingError) throw new Error(`数据集 ${pendingError}，已拒绝导入`);

    // 数据矩阵写入口有限性屏障(审查 P2):Infinity/NaN 单元格经 JSON 落盘变 null,
    // 重启时会把数据集连同整个最近列表判「损坏」隔离——统一在唯一入口拒绝,
    // 而不是逐输入框打补丁(随机数据弹窗 μ=1e999 是实测可达路径)
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== colNames.length
        || row.some((value) => !Number.isFinite(value))) {
        throw new Error('数据包含非有限数值(Infinity/NaN)或行列不一致，已拒绝导入；请检查数据源或输入参数');
      }
    }
    // 盲审 P2:保留原型键必须在**创建时**拒绝——只在导出侧拦会让用户先成功建集、
    // 之后每次导出项目都失败,且报错指向「读取本机数据集库失败」无自救路径。
    const reservedName = reservedPrototypeNameError(requestedName);
    if (reservedName) throw new Error(reservedName);
    if (!requestedName.trim()) throw new Error('数据集名称不能为空');
    if (requestedName.length > MAX_DATASET_NAME_CHARS) {
      throw new Error(`数据集名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`);
    }
    if (colNames.some((column) => typeof column !== 'string')) {
      throw new Error('数据集列名必须是字符串，已拒绝导入');
    }
    let maxCellChars = 0;
    let maxColumnNameChars = 0;
    for (const columnName of colNames) {
      maxColumnNameChars = Math.max(maxColumnNameChars, columnName.length);
    }
    for (const column of textCols) {
      if (!column || typeof column !== 'object' || typeof column.name !== 'string'
        || !Array.isArray(column.values) || column.values.length !== rows.length
        || column.values.some((value) => typeof value !== 'string')) {
        throw new Error('数据集文本列结构或行数无效，已拒绝导入');
      }
      maxColumnNameChars = Math.max(maxColumnNameChars, column.name.length);
      for (const value of column.values) maxCellChars = Math.max(maxCellChars, value.length);
    }
    // 蜂群 P1-02:维度预算在**唯一写入口**强制——.qproj/vault/SQLite 恢复此前绕过它。
    // 顶层维度已经通过，第二次只补充有界的字符预算。
    const resourceError = worksheetResourceError({
      rows: rows.length,
      cols: colNames.length,
      textCols: textCols.length,
      maxCellChars,
      maxColumnNameChars,
    });
    if (resourceError) throw new Error(resourceError);
    // 自审 P3:闸门必须在全部可能抛出的计算之后——normalizeImportColumns/computeVarModel
    // 也会抛(重名列、子组不齐等),先过闸门会让 MES 已停、datasetIntentRevision 已推进
    // 才抛错(在途的 loadRecent/vault 恢复被静默作废)。与 importCounts 同一顺序。
    const normalized = normalizeImportColumns(colNames, textCols);
    // 同名写入策略(STORE-04/UI-04):新建类入口在此统一改名，绝不整键覆盖内容不同的同名数据集。
    const resolved = modelOptions.onNameConflict === 'rename'
      ? resolveDatasetWriteName(requestedName, {
        colNames: normalized.colNames, rows, textCols: normalized.textCols, pendingCells,
      }, get(), modelOptions.derivedFrom)
      : { name: requestedName, identical: false, replacedPristine: false };
    const name = resolved.name;
    const model = computeVarModel(name, normalized.colNames, rows, {
      isDemo: modelOptions.isDemo === true,
      indivSeries: modelOptions.indivSeries?.map((value) => value),
    });
    // fix2609b M1:Web 端(无本机库)新建类写入会把数据集挤出最近列表时，被挤出的数据再无任何
    // 落盘位置。必须在闸门(停 MES、推进意图)之前拒绝并说明，用户确认后才允许继续。
    let replacedLostActive: string | null = null;
    if (modelOptions.onNameConflict === 'rename' && !platform.datasetDb) {
      const current = get();
      const listEvicted = trimRecents([
        { name, savedAt: '' },
        ...current.recents.filter((r) => !sameDatasetName(r.name, name)),
      ]).evicted.filter((entry) => entry.data).map((entry) => entry.name);
      // 活动表不在最近列表里(如用户已用 × 移出当前表)时，任何新建类写入都会替换活动槽，
      // 该表在浏览器端再无落盘位置——同样须经确认(fix2609d G4c；fix2609f G4d 不再限于同名改名)。
      // 例外：本次写入沿用它的名称(内容相同的同名重写)会把它重新写回最近列表，不丢。
      const activeName = current.model.name;
      const activeLost = !current.model.isDemo && name !== activeName
        && !current.recents.some((entry) => sameDatasetName(entry.name, activeName));
      const prospective = activeLost ? [...listEvicted, activeName] : listEvicted;
      const operationKey = modelOptions.confirmKey ?? requestedName;
      if (prospective.length === 0) {
        disarmEvictionConfirmation();
      } else if (!modelOptions.allowEviction
        && !consumeEvictionConfirmation(operationKey, prospective, current.recents)) {
        armEvictionConfirmation(operationKey, prospective, current.recents);
        const reasons: string[] = [];
        if (listEvicted.length > 0) {
          reasons.push(`最近列表已满（${MAX_RECENT_DATASETS} 个），继续会移除${listEvicted.map((n) => `「${n}」`).join('')}，浏览器端无法恢复；`);
        }
        if (activeLost) {
          reasons.push(`当前表「${activeName}」已不在最近列表，本次写入会替换它且浏览器端无法恢复；`);
        }
        const advice = listEvicted.length > 0
          ? `请先${PROJECT_BACKUP_HINT}备份，或移除不需要的最近数据集；`
          : `请先${PROJECT_BACKUP_HINT}备份或另存为副本；`;
        const detail = `${reasons.join('')}${advice}确认${listEvicted.length > 0 ? '移除' : '替换'}请在 ${EVICTION_CONFIRM_SECONDS} 秒内再次执行同一操作`;
        sessionLog(`数据集写入已暂停 · ${detail}`);
        throw new DatasetEvictionError(detail, prospective);
      }
      if (activeLost) replacedLostActive = activeName;
    }
    if (modelOptions.independentRecoveryCopy === true) {
      beginDatasetReplacement({ equivalentRecoveryCopy: true });
    } else {
      beginDatasetReplacement();
    }
    // 校验通过后只做防别名复制；禁止再以 filter 静默“修复”坏坐标，否则三条入口
    // （项目、SQLite、运行时）会出现同一载荷不同结果。
    const validPending = pendingCells.map(({ row, col }) => ({ row, col }));
    const data: StoredDataset = {
      name, colNames: normalized.colNames, rows, textCols: normalized.textCols, pendingCells: validPending,
      ...storedModelMetadata(model, rows),
      savedAt: new Date().toISOString(),
    };
    const { recents, evicted } = trimRecents([
      { name, savedAt: data.savedAt, data },
      ...get().recents.filter((r) => !sameDatasetName(r.name, name)),
    ]);
    // 确定性派生的原样结果：源表与本结果都未经编辑前，同一派生可按名替换它(不必改名多占最近列表位)。
    // 导入/粘贴/DOE/随机数据(无 derivedFrom)与桌面端一律不登记。
    if (modelOptions.onNameConflict === 'rename' && modelOptions.derivedFrom !== undefined && !platform.datasetDb) {
      pristineDatasets.set(name, { savedAt: data.savedAt, source: modelOptions.derivedFrom });
    } else pristineDatasets.delete(name);
    // 导入/创建/另存为会切换数据集，编辑历史不得跨数据集生效。
    set({ model, textCols: normalized.textCols, pendingCells: validPending, recents, undoStack: [], redoStack: [] });
    if (!modelOptions.preserveSpcRoles) resetDatasetSpcRoles();
    // 内容完全相同的同名重写不是「新内容」，保留该数据集已记住的规格限；
    // 按名替换未编辑的派生结果时同样沿用(用户为该名录入的 LSL/USL 不随换条件再筛选丢失)。
    if (!modelOptions.preserveSpecs && !resolved.identical && !resolved.replacedPristine) forgetSpecsForDataset(name);
    useApp.setState({ anovaShowDemo: false });
    knownDatasetNames.add(name);
    const outcome = persistActive(data, { allowVaultFallback: !modelOptions.independentRecoveryCopy });
    persistRecents(recents, modelOptions.independentRecoveryCopy ? undefined : data);
    if (!modelOptions.independentRecoveryCopy) archiveToVault(data);
    if (!modelOptions.preserveSpecs) suggestSpec(model, normalized.textCols);
    if (normalized.changed) {
      sessionLog(`导入列名已规范化 ${name} · 空名使用 C#/T#，重名追加序号`);
      try { useApp.getState().showToast('导入列名存在空值或重复，已稳定规范化（重名列追加序号）'); } catch { /* 非 UI 环境忽略 */ }
    }
    settleEvictedRecents(evicted);
    const result: PersistOutcome = { ...outcome };
    if (evicted.length > 0) result.evicted = evicted.map((entry) => entry.name);
    // 已按确认替换的、不在最近列表里的原活动表同样如实报告(浏览器端无法恢复)。
    if (replacedLostActive !== null && replacedLostActive !== requestedName) {
      result.evicted = [...(result.evicted ?? []), replacedLostActive];
    }
    if (resolved.replacedPristine) {
      result.replacedPristine = true;
      sessionLog(`已按名替换本会话未编辑的同名派生数据集「${name}」(源表未变)`);
    }
    if (name !== requestedName) {
      result.conflictLocation = datasetLocation(requestedName, recents);
      sessionLog(`同名数据集「${requestedName}」已存在(已编辑、内容不同或仅在本机库无法核对)，新数据另存为「${name}」，`
        + `原数据集${result.conflictLocation === 'recents' ? '保留在最近列表' : result.conflictLocation === 'vault' ? '在本机数据集库' : '已移出最近列表'}`);
    }
    sessionLog(`导入变量数据 ${name} · ${rows.length} 行 × ${normalized.colNames.length} 个数值列`);
    return modelOptions.onNameConflict === 'rename' ? { ...result, name } : result;
  },

  writeAnalysisColumns: (numericColumns, textColumns = []) => {
    const st = get();
    const rowCount = st.model.k;
    // 先用调用参数自身的数量做 O(1) 预算，避免攻击性插件/API 调用先为百万列
    // 构造 allNames/Set。替换同名列仍在下方按最终结构精确计算，不误拒合法边界。
    const requestedColumnsError = worksheetResourceError({
      rows: 0,
      cols: numericColumns.length,
      textCols: textColumns.length,
    });
    if (requestedColumnsError) {
      try { useApp.getState().showToast(`分析结果写回已拒绝：${requestedColumnsError}`); } catch { /* 非 UI 环境忽略 */ }
      return false;
    }
    const allNames = [...numericColumns.map((column) => column.name), ...textColumns.map((column) => column.name)];
    if (new Set(allNames).size !== allNames.length) throw new Error('分析输出列名不能重复');
    for (const column of numericColumns) {
      if (!column.name.trim()) throw new Error('分析输出列名不能为空');
    }
    for (const column of textColumns) {
      if (!column.name.trim()) throw new Error('分析输出列名不能为空');
    }

    const textNameSet = new Set(textColumns.map((column) => column.name));
    const numericNameSet = new Set(numericColumns.map((column) => column.name));
    const finalNumericNames = new Set(
      st.model.colNames.filter((name) => !textNameSet.has(name)),
    );
    numericNameSet.forEach((name) => finalNumericNames.add(name));
    const finalTextCount = st.textCols.filter(
      (column) => !numericNameSet.has(column.name) && !textNameSet.has(column.name),
    ).length + textColumns.length;
    if (rejectWorksheetResize(rowCount, finalNumericNames.size, finalTextCount)) return false;

    let maxOutputNameChars = 0;
    for (const name of allNames) maxOutputNameChars = Math.max(maxOutputNameChars, name.length);
    const outputNameError = worksheetResourceError({
      rows: 0, cols: 0, maxColumnNameChars: maxOutputNameChars,
    });
    if (outputNameError) throw new Error(outputNameError);
    for (const column of numericColumns) {
      if (column.values.length !== rowCount) throw new Error(`「${column.name}」行数与工作表不一致`);
      if (column.values.some((value) => !Number.isFinite(value))) throw new Error(`「${column.name}」包含非有限数值`);
    }
    let maxOutputCellChars = 0;
    for (const column of textColumns) {
      if (column.values.length !== rowCount) throw new Error(`「${column.name}」行数与工作表不一致`);
      for (const value of column.values) {
        if (typeof value !== 'string') throw new Error(`「${column.name}」包含非文本值`);
        maxOutputCellChars = Math.max(maxOutputCellChars, value.length);
      }
    }
    const outputCellError = worksheetResourceError({
      rows: 0, cols: 0, maxCellChars: maxOutputCellChars,
    });
    if (outputCellError) throw new Error(outputCellError);

    const keptOldIndices = st.model.colNames
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => !textNameSet.has(name));
    const indexMap = new Map(keptOldIndices.map(({ index }, nextIndex) => [index, nextIndex]));
    const colNames = keptOldIndices.map(({ name }) => name);
    const rows = st.model.subs.map((subgroup) => keptOldIndices.map(({ index }) => subgroup.vals[index]));
    let pendingCells = st.pendingCells
      .filter((cell) => indexMap.has(cell.col))
      .map((cell) => ({ ...cell, col: indexMap.get(cell.col)! }));

    for (const column of numericColumns) {
      let index = colNames.indexOf(column.name);
      if (index < 0) {
        index = colNames.length;
        colNames.push(column.name);
        rows.forEach((row, rowIndex) => row.push(column.values[rowIndex]));
      } else {
        rows.forEach((row, rowIndex) => { row[index] = column.values[rowIndex]; });
        pendingCells = pendingCells.filter((cell) => cell.col !== index);
      }
    }
    const nextText = st.textCols
      .filter((column) => !numericNameSet.has(column.name) && !textNameSet.has(column.name))
      .map((column) => ({ ...column, values: [...column.values] }));
    nextText.push(...textColumns.map((column) => ({ name: column.name, values: [...column.values] })));
    if (applyEdit(set, get, rows, nextText, colNames, pendingCells)) return false;
    sessionLog(`写回分析结果 · ${numericColumns.length} 个数值列 + ${textColumns.length} 个文本列`);
    return true;
  },

  importCounts: (kind, name, counts, sampleSize: number | number[] = 50) => {
    // P/C 属性数据同样是「替换活动分析数据」:必须经同一闸门停掉模拟采集
    // (闭环审核:此前唯独这条入口绕过,MES 采集中导入 P 图会继续污染)。
    // 复审 P3:闸门必须在校验之后——计数非法时 compute*Chart 抛错、导入失败,
    // 若先过闸门则 MES 已停、datasetIntentRevision 已推进(在途恢复被静默作废),
    // 与 importMatrix「先算模型、校验通过再过闸门」的顺序对齐。
    const resourceError = attributeChartResourceError(counts.length);
    if (resourceError) throw new Error(`${kind.toUpperCase()} 图超出资源上限：${resourceError}`);
    if (!name.trim()) throw new Error(`${kind.toUpperCase()} 图数据名称不能为空`);
    if (name.length > MAX_DATASET_NAME_CHARS) {
      throw new Error(`${kind.toUpperCase()} 图数据名称超过 ${MAX_DATASET_NAME_CHARS} 字符上限`);
    }
    let persisted: boolean;
    if (kind === 'p') {
      const pModel = computePChart(counts, sampleSize, name);
      beginDatasetReplacement();
      set({ pModel });
      persisted = persistAttr(pModel, get().cModel);
    } else {
      const cModel = computeCChart(counts, name);
      beginDatasetReplacement();
      set({ cModel });
      persisted = persistAttr(get().pModel, cModel);
    }
    useApp.setState({ selSub: null, spcType: kind });
    sessionLog(`导入计数数据 ${name} · ${counts.length} 个${kind === 'p' ? '样本(P图)' : '单位(C图)'}`);
    return { persisted, archiving: false };
  },

  importPareto: (name, rows) => {
    // 自审 P2:帕累托模型独立于工作表,不替换活动数据集——只需停掉模拟采集,
    // 不能推进 datasetIntentRevision(那会把在途的 loadRecent/vault 工作表恢复静默作废)。
    // 写入口校验(双审 P2 根因整改):与项目校验器同口径,非法载荷拒于落盘之前——
    // 否则今天写进去的数据明天重启被整店隔离
    const safeName = String(name ?? '').trim();
    if (!safeName) {
      sessionLog('帕累托导入被拒:数据集名称为空');
      return { persisted: false, archiving: false, rejected: '数据集名称不能为空' };
    }
    if (safeName.length > MAX_IMPORT_CELL_CHARS) {
      const rejected = `帕累托数据集名称超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
      sessionLog(`帕累托导入被拒:${safeName.slice(0, 80)} 名称过长`);
      return { persisted: false, archiving: false, rejected };
    }
    if (rows.length > MAX_PARETO_CATEGORIES) {
      const rejected = `帕累托类别数超过 ${MAX_PARETO_CATEGORIES.toLocaleString()} 上限`;
      sessionLog(`帕累托导入被拒:${safeName} 类别数 ${rows.length.toLocaleString()} 超限`);
      return { persisted: false, archiving: false, rejected };
    }
    if (rows.some((row) => String(row.name ?? '').trim().length > MAX_IMPORT_CELL_CHARS)) {
      const rejected = `帕累托单个类别名称超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
      sessionLog(`帕累托导入被拒:${safeName} 类别名称过长`);
      return { persisted: false, archiving: false, rejected };
    }
    const sanitized = rows
      .map((row) => ({ ...row, name: String(row.name ?? '').trim() }))
      .filter((row) => row.name && Number.isFinite(row.count) && row.count >= 0);
    // 与 project.paretoValidationError 的四条规则逐条对齐(闭环审核 P2:此前只实现 2 条)
    if (!sanitized.length) {
      sessionLog(`帕累托导入被拒:${safeName} 无合法类别行`);
      // rejected 字段让调用方能区分「校验拒绝」与「存储空间不足」,不再错报(第三轮 P3)
      return { persisted: false, archiving: false, rejected: '没有合法的类别行(类别名不能为空,频数须为非负数)' };
    }
    if (sanitized.every((row) => row.count === 0)) {
      sessionLog(`帕累托导入被拒:${safeName} 所有类别频数为 0`);
      return { persisted: false, archiving: false, rejected: '所有类别的频数都是 0,无法绘制帕累托图' };
    }
    if (get().mesRunning) get().setMesRunning(false);
    const droppedRows = rows.length - sanitized.length;
    const paretoModel: ParetoModel = { name: safeName, rows: sanitized };
    set({ paretoModel });
    useApp.setState({ paretoShowDemo: false });
    const persisted = saveJson(LS_PARETO, paretoModel);
    sessionLog(`导入帕累托数据 ${name} · ${sanitized.length} 个类别${droppedRows ? `(过滤 ${droppedRows} 个非法行)` : ''}`);
    return { persisted, archiving: false, droppedRows: droppedRows || undefined };
  },

  clearPareto: () => {
    set({ paretoModel: null });
    // fix2609b M3:与 saveJson 对称——配额失败留下的旧载荷不得随 .qproj 导出复活。
    removeJson(LS_PARETO);
  },

  loadRecent: async (name, preserveSpcRoles = false) => {
    // 活动表是同名入口的权威版本；重复点击当前项不允许用异常残留的旧 recent 回退矩阵。
    if (get().model.name === name) return true;
    let revision: number;
    try { revision = beginDatasetReplacement(); } catch { return false; }
    const r = get().recents.find((x) => x.name === name);
    if (r?.data) {
      try {
        const model = modelFromStored(r.data);
        if (!isCurrentDatasetIntent(revision)) return false;
        set({ model, textCols: r.data.textCols ?? [], pendingCells: pendingFromStored(r.data), undoStack: [], redoStack: [] });
        if (preserveSpcRoles) resetDatasetNonSpcRoles();
        else resetDatasetSpcRoles();
        useApp.setState({ anovaShowDemo: false });
        persistActive(r.data);
        suggestSpec(model, r.data.textCols ?? []);
        sessionLog(`加载最近数据集 ${name}`);
        return true;
      } catch {
        sessionLog(`最近数据集 ${name} 已损坏，未加载`);
        return false;
      }
    }
    // 条目缺失或为轻量条目(数据超配额只存在库中)时,桌面端回落本机 SQLite 数据集库
    const db = platform.datasetDb;
    if (!db) return false;
    try {
      const json = await db.get(name);
      if (!json || !isCurrentDatasetIntent(revision)) return false;
      const data = JSON.parse(json) as StoredDataset;
      if (data.name !== name) throw new Error('数据集库键与内容名称不一致');
      const model = modelFromStored(data);
      if (!isCurrentDatasetIntent(revision)) return false;
      set({ model, textCols: data.textCols ?? [], pendingCells: pendingFromStored(data), undoStack: [], redoStack: [] });
      if (preserveSpcRoles) resetDatasetNonSpcRoles();
      else resetDatasetSpcRoles();
      useApp.setState({ anovaShowDemo: false });
      persistActive(data);
      suggestSpec(model, data.textCols ?? []);
      sessionLog(`从数据集库加载 ${name}`);
      return true;
    } catch {
      sessionLog(`数据集库读取 ${name} 失败，当前工作表未改变`);
      return false;
    }
  },

  resetDemo: () => {
    beginDatasetReplacement();
    const d = demoInit();
    set({
      model: d.model, textCols: [], pModel: d.p, cModel: d.c, paretoModel: null,
      pendingCells: [], mesRunning: false, undoStack: [], redoStack: [],
    });
    resetDatasetSpcRoles();
    useApp.setState({ paretoShowDemo: false, anovaShowDemo: false });
    // fix2609b M3:删除业务键同样维护 dirty/损坏保护/跨窗口簿记，旧载荷不得混入之后的导出。
    for (const key of [LS_DATASET, LS_ATTR, LS_PARETO, LS_ACTIVE_REF]) removeJson(key);
    // fix2609j STORE-07:演示集无需持久化，旧活动表已被替换出内存(替换闸门先保证最近列表已落盘)；
    // 残留此标志只会在演示集状态下误弹「尚未持久化」离开警告。其它数据集的必保快照仍独立维持警告。
    setActiveUnpersisted(false);
    suggestSpec(d.model, []);
    sessionLog('恢复演示数据集 质检数据.mtw');
  },

  updateCell: (row, col, value) => {
    if (!Number.isFinite(value)) return;
    if (deferEditDuringExport(() => get().updateCell(row, col, value))) return;
    const m = get().model;
    if (row < 0 || row >= m.subs.length || col < 0 || col >= m.n) return;
    // Copy-on-write：外层索引 + 被编辑的一行。其余行与撤销快照共享，
    // computeVarModel 只读行数组，后续结构编辑也都会先拷贝。
    const rows = m.subs.map((s) => s.vals);
    rows[row] = [...rows[row]];
    rows[row][col] = value;
    const wasPending = get().pendingCells.some((p) => p.row === row && p.col === col);
    const pendingCells = get().pendingCells.filter((p) => p.row !== row || p.col !== col);
    applyEdit(
      // DOE/新建表的“待录入”标记是持久化语义：确认该格时必须
      // 立即落盘，不能让页面已显示完成而备份仍把它当占位格。普通数值
      // 编辑仍按同一事件循环合并，避免大表连续输入重复序列化。
      set, get, rows, get().textCols, undefined, pendingCells, !wasPending,
      (name) => updateVarModelCell(
        m, row, col, value,
        m.isDemo ? { name, isDemo: false, indivSeries: null } : { name },
      ),
    );
  },

  addSubgroupRow: () => {
    if (structuralEditRefused()) return false;
    const m = get().model;
    const currentTextCols = get().textCols;
    // 先按 k+1 做 O(1) 预算；20 万行边界不得先复制 20 万个子组与文本值。
    if (rejectWorksheetResize(m.k + 1, m.n, currentTextCols.length)) return false;
    const rows = m.subs.map((s) => [...s.vals]);
    rows.push([...rows[rows.length - 1]]); // 复制末行,便于就地修改
    const textCols = currentTextCols.map((c) => ({ ...c, values: [...c.values, c.values[c.values.length - 1] ?? ''] }));
    // 若末行仍含占位值，新复制行必须继承同列的待录入语义。
    const pendingCells = [
      ...get().pendingCells,
      ...get().pendingCells.filter((p) => p.row === m.k - 1).map((p) => ({ row: m.k, col: p.col })),
    ];
    if (applyEdit(set, get, rows, textCols, undefined, pendingCells)) return false;
    return true;
  },

  deleteRow: (row) => {
    if (structuralEditRefused()) return false;
    const m = get().model;
    if (m.k <= 2) return false; // 模型至少 2 行
    if (row < 0 || row >= m.subs.length) return false;
    const rows = m.subs.map((s) => [...s.vals]);
    rows.splice(row, 1);
    const textCols = get().textCols.map((c) => {
      const values = [...c.values];
      values.splice(row, 1);
      return { ...c, values };
    });
    const pendingCells = get().pendingCells
      .filter((p) => p.row !== row)
      .map((p) => ({ ...p, row: p.row > row ? p.row - 1 : p.row }));
    if (applyEdit(set, get, rows, textCols, undefined, pendingCells)) return false;
    useApp.setState({ selSub: null });
    return true;
  },

  undoEdit: () => {
    // fix2609m A2:快照期间撤销直接拒绝、不排队(暂存会与其后按显示布局排队的单格编辑错位)；
    // 必须在弹栈之前拒绝，否则撤销/重做栈与工作表错位。调用方用 isProjectExportInFlight 区分拒绝与「无可撤销」。
    if (structuralEditRefused()) return false;
    const st = get();
    const snap = st.undoStack[st.undoStack.length - 1];
    if (!snap) return false;
    set({
      undoStack: st.undoStack.slice(0, -1),
      redoStack: trimSnapshotStack([...st.redoStack, snapshotOf(st)]),
    });
    restoreSnapshot(set, get, snap);
    sessionLog('撤销编辑');
    return true;
  },

  redoEdit: () => {
    if (structuralEditRefused()) return false;
    const st = get();
    const snap = st.redoStack[st.redoStack.length - 1];
    if (!snap) return false;
    const undo = trimSnapshotStackWithInfo([...st.undoStack, snapshotOf(st)]);
    set({
      redoStack: st.redoStack.slice(0, -1),
      undoStack: undo.stack,
      undoBudgetLimited: undo.budgetLimited,
    });
    restoreSnapshot(set, get, snap);
    sessionLog('重做编辑');
    return true;
  },

  newWorksheet: () => {
    const names = [get().model.name, ...get().recents.map((entry) => entry.name)];
    const name = allocateWorksheetName(names);
    const colNames = ['测量1', '测量2', '测量3', '测量4', '测量5'];
    // VarModel 只接受有限数；0 仅是内部占位，全部格子用 pendingCells 明确标记为「尚未录入」。
    const rows = Array.from({ length: 3 }, () => Array<number>(5).fill(0));
    const pendingCells = rows.flatMap((row, rowIndex) => row.map((_, col) => ({ row: rowIndex, col })));
    const outcome = get().importMatrix(name, colNames, rows, [], pendingCells);
    set({ undoStack: [], redoStack: [] });
    return outcome;
  },

  saveAsCopy: () => {
    // fix2609n G24e(第 8 批复审 P3):副本名分配会写 LS_COPY_SEQUENCES 并登记 knownDatasetNames,必须在替换闸门之前就拒绝,
    // 否则导出快照期间「另存为副本」虽被闸门挡下,副本序号已被白白消耗(快照后首次另存得到「(副本2)」)。
    if (projectExportOwner !== null) throw new Error('项目正在生成一致性快照，请稍后再修改或切换数据集');
    const m = get().model;
    const names = [m.name, ...get().recents.map((entry) => entry.name)];
    const name = allocateCopyName(m.name, names);
    const db = platform.datasetDb;
    if (db) {
      if (!db.insert) {
        return { name, outcome: { persisted: false, archiving: false, rejected: '本机数据集库不支持安全创建副本，请更新桌面程序' } };
      }
      // 先确认源表的最后一格编辑，但候选副本名在 DB 确认前绝不写进
      // 活动槽/recent/普通归档队列。失败因此无须回滚，也不会污染历史同名记录。
      // 此时尚不替换工作表；即使源表位于未持久化溢出槽，也应允许尝试建立独立副本。
      // 真正激活时仍经过 importMatrix 的替换闸门。
      flushPendingCellPersistence();
      if (get().mesRunning) set({ mesRunning: false });
      const revision = beginDatasetIntent();
      const generation = vaultWorkGeneration;
      const source = get();
      const rows = m.subs.map((subgroup) => [...subgroup.vals]);
      const data: StoredDataset = {
        name, colNames: [...m.colNames], rows,
        textCols: source.textCols.map((column) => ({ ...column, values: [...column.values] })),
        pendingCells: source.pendingCells.map((cell) => ({ ...cell })),
        indivSeries: storedModelMetadata(m, rows).indivSeries,
        savedAt: new Date().toISOString(),
      };
      const result: { name: string; outcome: PersistOutcome } = {
        name, outcome: { persisted: false, archiving: true },
      };
      const isCurrent = () => generation === vaultWorkGeneration
        && isCurrentDatasetIntent(revision) && !datasetClearQuiesced && projectExportOwner === null;
      const durability = trackVaultWrite((async () => {
        // 超量历史库会在首次空闲名处被数据库容量闸门明确拒绝；重试次数另设硬上限。
        for (let attempt = 0; attempt < 1001; attempt++) {
          if (!isCurrent()) throw new Error('等待保存期间工作表或项目已发生变化，已取消副本切换');
          try {
            await enqueueVaultPut(db, data, {}, { insertOnly: true });
          } catch (error) {
            if (!(error instanceof DatasetNameCollisionError)) throw error;
            data.name = allocateCopyName(m.name, [get().model.name, ...get().recents.map((entry) => entry.name)]);
            result.name = data.name;
            continue;
          }
          if (!isCurrent()) {
            throw new Error(`副本「${data.name}」已存入本机库，但工作表或项目已变化，未切换当前数据`);
          }
          if (unclaimedCopyNames.has(m.name)) {
            // 防止旧 insert 的迟到失败在退休后重建保全义务或旧名 recent。
            await settleVaultName(m.name);
            if (!isCurrent()) {
              throw new Error(`副本「${data.name}」已存入本机库，但源工作表已变化，未切换当前数据`);
            }
            retireUnclaimedCopySource(m.name);
          }
          const activated = get().importMatrix(data.name, data.colNames, data.rows, data.textCols, data.pendingCells, {
            preserveSpcRoles: true, preserveSpecs: true,
            indivSeries: data.indivSeries, independentRecoveryCopy: true,
          });
          if (activated.evicted) result.outcome.evicted = activated.evicted;
          independentlyDurableRecoveryCopy = data.name;
          return;
        }
        throw new Error('连续副本名称冲突过多，已停止创建；原工作表未更改');
      })());
      result.outcome.durability = durability;
      void durability.catch((error) => { result.outcome.rejected = errText(error); });
      return result;
    }
    const activeOutcome = get().importMatrix(
      name,
      [...m.colNames],
      m.subs.map((s) => [...s.vals]),
      get().textCols.map((column) => ({ ...column, values: [...column.values] })),
      get().pendingCells.map((cell) => ({ ...cell })),
      {
        preserveSpcRoles: true, preserveSpecs: true,
        // 双审 P3:堆叠 I-MR 的独立观测序列必须随副本保留,否则副本的 I-MR 图与原数据集不一致
        indivSeries: storedModelMetadata(m, m.subs.map((s) => [...s.vals])).indivSeries,
        independentRecoveryCopy: true,
      },
    );
    // Web 端没有 SQLite：只有最近列表中内嵌的完整 copy 才算独立耐久副本。
    // qp-dataset-v1 是共享活动槽，随后回看必然覆盖，不能用于放行。
    let independent = false;
    try {
      const recents = JSON.parse(localStorage.getItem(LS_RECENTS) ?? '[]') as RecentEntry[];
      independent = recents.some((entry) => entry.name === name && entry.data?.name === name);
    } catch { /* 按未持久化处理 */ }
    const outcome: PersistOutcome = independent
      ? { persisted: true, archiving: false }
      : { persisted: false, archiving: false, rejected: activeOutcome.rejected ?? '副本未能写入独立恢复位置' };
    // fix2609d G4c:副本置顶可能把最旧的数据集挤出最近列表(Web 端无法恢复)，调用方必须能如实提示。
    if (activeOutcome.evicted) outcome.evicted = activeOutcome.evicted;
    return { name, outcome };
  },

  standardize: () => {
    // 占位值不是观测值，参与均值/标准差会污染所有标准化结果。
    if (get().pendingCells.length > 0) return null;
    const m = get().model;
    // 各列 z = (x − x̄ⱼ)/sⱼ;列内无变异则拒绝
    const cols = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    const stats = cols.map((values) => {
      // z 分数只依赖差值；保留偏移坐标，避免稳定均值加回大基准后再次舍入低位。
      const origin = values[0];
      return { origin, meanOffset: mean(values.map((value) => value - origin)), sd: stdev(values) };
    });
    if (stats.some((x) => x.sd === 0)) return null;
    const rows = m.subs.map((s) => s.vals.map((v, j) => Number((
      ((v - stats[j].origin) - stats[j].meanOffset) / stats[j].sd
    ).toFixed(4))));
    const requested = m.name.replace(/\.[^.]+$/, '') + ' (标准化)';
    // STORE-04:派生结果走同名写入策略，不覆盖上一份已编辑过的同名标准化数据集
    const outcome = get().importMatrix(requested, m.colNames.map((c) => c + '_z'), rows, get().textCols, [], {
      onNameConflict: 'rename', derivedFrom: derivationSourceStamp(get()),
    });
    return { name: outcome.name ?? requested, requested, outcome };
  },

  generateRandom: (mu, sigma, k, n) => {
    const resourceError = worksheetResourceError({ rows: k, cols: n });
    if (resourceError) throw new Error(`随机数据未生成：${resourceError}`);
    const randn = () => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const digits = Math.max(0, Math.min(6, 3 - Math.floor(Math.log10(Math.max(sigma, 1e-9)))));
    const rows = Array.from({ length: k }, () =>
      Array.from({ length: n }, () => Number((mu + randn() * sigma).toFixed(digits))),
    );
    const requested = `随机数据 N(${mu},${sigma})`;
    // STORE-04:随机值不可复现(不带 derivedFrom)，同参数再生成即使上一份未编辑也绝不能覆盖
    const outcome = get().importMatrix(requested, Array.from({ length: n }, (_, i) => `X${i + 1}`), rows, [], [], { onNameConflict: 'rename' });
    return { name: outcome.name ?? requested, requested, outcome };
  },

  sortBy: (col, asc) => {
    if (structuralEditRefused()) return false;
    const m = get().model;
    if (col < 0 || col >= m.n) return false;
    const idx = m.subs.map((_, i) => i).sort((a, b) =>
      asc ? m.subs[a].vals[col] - m.subs[b].vals[col] : m.subs[b].vals[col] - m.subs[a].vals[col],
    );
    const rows = idx.map((i) => [...m.subs[i].vals]);
    const textCols = get().textCols.map((c) => ({ ...c, values: idx.map((i) => c.values[i]) }));
    const oldPending = new Set(get().pendingCells.map((p) => `${p.row}:${p.col}`));
    const pendingCells: PendingCell[] = [];
    idx.forEach((oldRow, newRow) => {
      for (let col2 = 0; col2 < m.n; col2++) if (oldPending.has(`${oldRow}:${col2}`)) pendingCells.push({ row: newRow, col: col2 });
    });
    if (applyEdit(set, get, rows, textCols, undefined, pendingCells)) return false;
    sessionLog(`按「${m.colNames[col]}」${asc ? '升序' : '降序'}排序`);
    return true;
  },

  removeRecent: (name) => {
    const removed = get().recents.filter((r) => r.name === name);
    const recents = get().recents.filter((r) => r.name !== name);
    set({ recents });
    // 列表已变：旧的挤出确认布防作废(fix2609f G4d)。
    disarmEvictionConfirmation();
    // × 常用于按闸门文案腾空间解锁：最近列表写成功后，未落盘的活动槽也要重试，
    // 否则共享 LS_DATASET 仍是旧版，另一窗口会按它回退 LS_RECENTS(fix2609f G4d)。
    if (persistRecents(recents) && !retryUnpersistedActive()) {
      sessionLog('移除最近数据集后重试保存：活动槽仍写不下(浏览器存储空间不足)，当前工作表的最新版本尚未写入活动槽');
    }
    // 桌面端承诺「从最近列表移除的数据集仍可在库中找回」：从未入库的条目(如无 vault 的 .qproj 导入)补入本机库。
    if (platform.datasetDb) settleEvictedRecents(removed);
  },

  renameColumn: (col, name) => {
    if (deferEditDuringExport(() => get().renameColumn(col, name))) return;
    const m = get().model;
    const clean = name.trim();
    if (col < 0 || col >= m.n || clean === m.colNames[col]) return;
    if (clean === '') {
      useApp.getState().showToast('列名不能为空，未保存重命名');
      return;
    }
    // 盲审 P2:列名此前无任何长度闸,500 万字符列名会绕过单元格上限写进
    // localStorage 与撤销栈(每层快照都带一份)。与导入口共用同一常量。
    if (clean.length > MAX_COLUMN_NAME_CHARS) {
      useApp.getState().showToast(`列名超过 ${MAX_COLUMN_NAME_CHARS} 字符上限，未保存重命名`);
      return;
    }
    const duplicate = m.colNames.some((columnName, index) => index !== col && columnName === clean)
      || get().textCols.some((column) => column.name === clean);
    if (duplicate) {
      useApp.getState().showToast(`列名「${clean}」已存在，请使用唯一列名`);
      return;
    }
    const colNames = m.colNames.map((c, i) => (i === col ? clean : c));
    applyEdit(set, get, m.subs.map((s) => [...s.vals]), get().textCols, colNames);
  },

  deleteColumn: (col) => {
    if (structuralEditRefused()) return false;
    const m = get().model;
    if (m.n <= 1) return false; // 至少保留 1 个测量列
    if (col < 0 || col >= m.n) return false;
    const colNames = m.colNames.filter((_, i) => i !== col);
    const rows = m.subs.map((s) => s.vals.filter((_, i) => i !== col));
    const pendingCells = get().pendingCells
      .filter((p) => p.col !== col)
      .map((p) => ({ ...p, col: p.col > col ? p.col - 1 : p.col }));
    // 删除数值列会让文本列的 sourceIndex 锚点漂移(批次716-R2 自查):
    // 按删除前的显示序剔除被删列后重编号,保持文本列与其余数值列的相对显示序不变。
    const keptOrder = worksheetDisplayOrder(m.n, get().textCols)
      .filter((ref) => !(ref.kind === 'numeric' && ref.index === col));
    const textCols = get().textCols.map((column, ti) => ({
      ...column,
      sourceIndex: keptOrder.findIndex((ref) => ref.kind === 'text' && ref.index === ti),
    }));
    if (applyEdit(set, get, rows, textCols, colNames, pendingCells)) return false;
    useApp.setState({ selSub: null });
    return true;
  },

  insertColumn: () => {
    if (structuralEditRefused()) return false;
    const m = get().model;
    const currentTextCols = get().textCols;
    // 5,000 列或 200 万格边界先拒绝，不能先展开全部列名/行/待录入坐标。
    if (rejectWorksheetResize(m.k, m.n + 1, currentTextCols.length)) return false;
    const nextName = nextUniqueColumnName(`测量${m.n + 1}`, [...m.colNames, ...currentTextCols.map((column) => column.name)]);
    const colNames = [...m.colNames, nextName];
    // 双审 P3:新列是「待录入」,不能复制末列数值冒充实测(会立即改变 σ 组内);
    // 整列占位 0 + pendingCells 标记,与 newWorksheet 同一口径
    const rows = m.subs.map((s) => [...s.vals, 0]);
    const pendingCells = [
      ...get().pendingCells,
      ...m.subs.map((_, rowIdx) => ({ row: rowIdx, col: m.n })),
    ];
    if (applyEdit(set, get, rows, currentTextCols, colNames, pendingCells)) return false;
    return true;
  },

  addFormulaColumn: (name, expr) => {
    if (get().pendingCells.length > 0) return '工作表仍有待录入单元格，不能用占位值生成公式列';
    const m = get().model;
    const currentTextCols = get().textCols;
    const resizeError = rejectWorksheetResize(m.k, m.n + 1, currentTextCols.length);
    if (resizeError) return `公式列未添加：${resizeError}`;
    const requestedName = name.trim();
    const existingNames = [...m.colNames, ...currentTextCols.map((column) => column.name)];
    const clean = requestedName || nextUniqueColumnName(`公式${m.n + 1}`, existingNames);
    if (requestedName && existingNames.includes(clean)) return `列名「${clean}」已存在，请使用唯一列名`;
    if (clean.length > MAX_COLUMN_NAME_CHARS) return `列名超过 ${MAX_COLUMN_NAME_CHARS} 字符上限，未添加公式列`;
    const columns = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    let values: number[];
    try {
      values = evalFormula(expr, { columns, colNames: m.colNames, rowCount: m.k, columnNumbers: worksheetNumericColumnCodes(m.n, currentTextCols) }).values;
    } catch (e) {
      return e instanceof FormulaError ? e.message : '公式计算失败：' + (e as Error).message;
    }
    const invalidRow = values.findIndex((value) => !Number.isFinite(value));
    if (invalidRow >= 0) {
      return `公式第 ${invalidRow + 1} 行未得到有限数值（可能除以 0、对负数开方或数值溢出），未添加任何数据`;
    }
    // 全精度写入(双审 P2):toFixed(6) 会把 1e-7 量级结果整列静默归零、1e-5 量级引入
    // 最高 2.4% 相对误差;展示层统一经 nf() 格式化,存储不做量化
    const safe = values;
    const colNames = [...m.colNames, clean];
    const rows = m.subs.map((s, i) => [...s.vals, safe[i]]);
    const editError = applyEdit(set, get, rows, currentTextCols, colNames);
    if (editError) return `公式列未添加：${editError}`;
    sessionLog(`新增公式列「${clean}」= ${expr.trim()}`);
    return null;
  },

  findReplace: (find, replace, col) => {
    // 写入口有限性(对抗审查 P3):API 直调 replace=Infinity 会落盘为 null → 重启整店隔离
    if (replace != null && !Number.isFinite(replace)) return 0;
    if (!Number.isFinite(find)) return 0;
    const m = get().model;
    // 与工作表显示一致的匹配:精确相等或 3 位小数四舍五入后相等
    const hit = (v: number) => v === find || Math.abs(v - find) < 5e-4 && Number(v.toFixed(3)) === Number(find.toFixed(3));
    // 双审 P2:「待录入」占位格显示为待录入而非 0,不得按其内部占位值 0 参与匹配/替换
    const pendingKeys = new Set(get().pendingCells.map((cell) => `${cell.row}:${cell.col}`));
    let count = 0;
    const rows = m.subs.map((s, rowIdx) =>
      s.vals.map((v, j) => {
        if ((col === -1 || j === col) && !pendingKeys.has(`${rowIdx}:${j}`) && hit(v)) {
          count++;
          return replace != null ? replace : v;
        }
        return v;
      }),
    );
    if (replace == null || count === 0 || replace === find) return count;
    // fix2609m A2:导出快照期间整次替换直接拒绝、不排队(与其它结构性批量编辑同口径)，返回 0。
    if (structuralEditRefused()) return 0;
    // 第三轮 P1:匹配阶段已跳过占位格,被替换的必是真实观测——不得再按占位内部值 0
    // 命中与否过滤 pendingCells(那正是把「待录入」标记静默清掉、占位 0 变真实观测的半边修)
    // 被拒(如导出快照期间)时返回 0，调用方不得报告「已替换 N 处」。
    if (applyEdit(set, get, rows, get().textCols, undefined, get().pendingCells)) return 0;
    sessionLog(`查找替换:${find} → ${replace} · ${count} 处${col >= 0 ? ` · 限「${m.colNames[col]}」列` : ''}`);
    return count;
  },

  subsetByCondition: (cond) => {
    if (get().pendingCells.length > 0) {
      return { ok: false, error: '工作表仍有待录入单元格，请完成录入后再生成子集' };
    }
    const m = get().model;
    const columns = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    let flags: number[];
    try {
      flags = evalFormula(cond, { columns, colNames: m.colNames, rowCount: m.k, columnNumbers: worksheetNumericColumnCodes(m.n, get().textCols) }).values;
    } catch (e) {
      return { ok: false, error: e instanceof FormulaError ? e.message : '条件计算失败：' + (e as Error).message };
    }
    const keep = flags.map((v) => truthy(v));
    const kept = keep.filter(Boolean).length;
    if (kept === m.k) return { ok: false, error: `条件对全部 ${m.k} 行都成立,未筛除任何行` };
    if (kept < 2) return { ok: false, error: `仅 ${kept} 行满足条件,不足 2 行无法构成数据集` };
    const rows = m.subs.filter((_, i) => keep[i]).map((s) => [...s.vals]);
    const textCols = get().textCols.map((c) => ({ ...c, values: c.values.filter((_, i) => keep[i]) }));
    const base = m.name.replace(/\.[^.]+$/, '');
    // STORE-04:换条件再筛选不得覆盖上一份子集中用户补录/修正的数据
    const requested = `${base} (子集)`;
    let outcome: PersistOutcome;
    try {
      outcome = get().importMatrix(requested, [...m.colNames], rows, textCols, [], {
        onNameConflict: 'rename', derivedFrom: derivationSourceStamp(get()),
      });
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
    const name = outcome.name ?? requested;
    sessionLog(`条件筛选「${cond.trim()}」→ ${name} · 保留 ${kept}/${m.k} 行`);
    return { ok: true, name, requested, kept, total: m.k, outcome };
  },

  transposeDataset: (sourceColumns) => {
    if (get().pendingCells.length > 0) throw new Error('工作表仍有待录入单元格，请完成录入后再转置');
    const m = get().model;
    const rows = m.subs.map((s) => s.vals);
    if (rows.length > 10) {
      throw new Error(`转置后每个子组将包含 ${rows.length} 次测量；X̄-R/X̄-S 的组内样本量需为 2–10。数值列数量本身不限。`);
    }
    const selectedIndices = sourceColumns == null
      ? m.colNames.map((_, index) => index)
      : sourceColumns.map((name) => m.colNames.indexOf(name)).filter((index) => index >= 0);
    if (selectedIndices.length < 2 || new Set(selectedIndices).size !== selectedIndices.length) {
      throw new Error('转置至少需要 2 个不重复的数值子组列');
    }
    const t: number[][] = selectedIndices.map((j) => rows.map((r) => r[j]));
    // 转置后每行才是一个子组；原数值列名是子组身份，必须保留而不是改成隐含序号。
    const colNames = rows.map((_, i) => `测量${i + 1}`);
    const subgroupLabels: TextColumn[] = [{ name: '原列子组', values: selectedIndices.map((i) => m.colNames[i]) }];
    // 改名策略产生的「X (转置) (2)」再做同操作时同样回到基名，不叠成「X (转置) (2) (转置)」
    const base = m.name.replace(/ \(转置\)(?: \(\d+\))?$/, '');
    const requested = `${base} (转置)`;
    const outcome = get().importMatrix(requested, colNames, t, subgroupLabels, [], {
      onNameConflict: 'rename', derivedFrom: derivationSourceStamp(get()),
    });
    return { name: outcome.name ?? requested, requested, outcome };
  },

  stackColumns: () => {
    if (get().pendingCells.length > 0) throw new Error('工作表仍有待录入单元格，请完成录入后再堆叠');
    const m = get().model;
    if (m.n < 2) throw new Error('单列数据无需堆叠');
    // 双审 P2:堆叠产出 行×列 的新数据集,必须复用导入行数包线——
    // 20 万行×10 列一键堆成 200 万行会精确复活「编辑深拷贝卡死→OOM」场景
    if (m.k * m.n > MAX_IMPORT_DATA_ROWS) {
      throw new Error(`堆叠后将有 ${(m.k * m.n).toLocaleString()} 行,超过 ${MAX_IMPORT_DATA_ROWS.toLocaleString()} 行上限;请先用「子集/条件筛选」缩小数据`);
    }
    const rows: number[][] = [];
    const source: string[] = [];
    // 按列堆叠：列内行序保持（Minitab Stack 语义）
    m.colNames.forEach((cn, j) => {
      m.subs.forEach((s) => {
        rows.push([s.vals[j]]);
        source.push(cn);
      });
    });
    // 改名策略产生的「X (堆叠) (2)」再做同操作时同样回到基名，不叠成「X (堆叠) (2) (堆叠)」
    const base = m.name.replace(/ \(堆叠\)(?: \(\d+\))?$/, '');
    const requested = `${base} (堆叠)`;
    const outcome = get().importMatrix(requested, ['测量值'], rows, [{ name: '来源列', values: source }], [], {
      onNameConflict: 'rename', derivedFrom: derivationSourceStamp(get()),
    });
    return { name: outcome.name ?? requested, requested, outcome };
  },

  startMesDataset: (n) => {
    const resourceError = worksheetResourceError({ rows: 2, cols: n });
    if (resourceError) throw new Error(`MES 数据集未启动：${resourceError}`);
    beginDatasetIntent();
    // 以两个种子子组起步（模型要求 ≥2 行）
    const seedRows = [
      Array.from({ length: n }, () => 25 + (Math.random() - 0.5) * 0.05),
      Array.from({ length: n }, () => 25 + (Math.random() - 0.5) * 0.05),
    ];
    const colNames = Array.from({ length: n }, (_, i) => `测点${i + 1}`);
    const model = computeVarModel('MES 实时采集', colNames, seedRows);
    const data: StoredDataset = {
      name: model.name, colNames, rows: seedRows, textCols: [], pendingCells: [], savedAt: new Date().toISOString(),
    };
    pristineDatasets.delete(data.name);
    const { recents, evicted } = trimRecents([
      { name: data.name, savedAt: data.savedAt, data },
      ...get().recents.filter((entry) => !sameDatasetName(entry.name, data.name)),
    ]);
    set({ model, textCols: [], pendingCells: [], recents, undoStack: [], redoStack: [] });
    resetDatasetSpcRoles();
    persistActive(data);
    persistRecents(recents, data);
    archiveToVault(data);
    settleEvictedRecents(evicted);
    suggestSpec(model, []);
  },

  appendSubgroup: (vals) => {
    beginDatasetIntent();
    const m = get().model;
    // 双审 P1 配套:列数不匹配或目标表带文本分组列时拒绝追加(MES 流数据集永远无文本列),
    // 防止把模拟子组塞进结构不同的真实工作表造成行列错位
    if (vals.length !== m.colNames.length || get().textCols.length > 0) {
      set({ mesRunning: false });
      return;
    }
    if (m.subs.length >= MAX_MES_SUBGROUPS) {
      set({ mesRunning: false });
      return;
    }
    const rows = [...m.subs.map((s) => s.vals), vals];
    const model = computeVarModel(m.name, m.colNames, rows);
    const data: StoredDataset = {
      name: model.name, colNames: [...model.colNames], rows, textCols: [], pendingCells: [], savedAt: new Date().toISOString(),
    };
    pristineDatasets.delete(data.name);
    const { recents, evicted } = trimRecents([
      { name: data.name, savedAt: data.savedAt, data },
      ...get().recents.filter((entry) => !sameDatasetName(entry.name, data.name)),
    ]);
    set({ model, pendingCells: [], recents });
    persistActive(data);
    persistRecents(recents, data);
    archiveToVault(data);
    settleEvictedRecents(evicted);
  },

  setMesRunning: (mesRunning) => set({ mesRunning }),
}));

// 模块启动已在内存中把同名 recent 提升为活动表版本；store 构造完成后再尝试
// 修复磁盘，失败则 recentsUnpersisted/activeUnpersisted 持续警告且项目导出取 dirty 覆盖。
if (startupRecentCoordination.changed) persistRecents(storedRecents, stored ?? undefined);
settleEvictedRecents(startupRecentCoordination.evicted);

/** SPC 角色在导入之后才被用户明确时，同步刷新全局规格建议，供仪表盘与能力页共用。 */
export function syncSpecForActiveMeasurement() {
  const { model, textCols } = useData.getState();
  const suggestion = specForActiveMeasurement(model, textCols);
  if (suggestion) useApp.setState(suggestion);
  return suggestion;
}

interface ActiveVaultHydrationResult {
  hydrated: boolean;
  error: string | null;
}

async function hydrateActiveRefFromVault(
  db: NonNullable<typeof platform.datasetDb>,
): Promise<ActiveVaultHydrationResult> {
  let ref: string | null = null;
  try {
    ref = localStorage.getItem(LS_ACTIVE_REF);
  } catch (error) {
    const detail = `读取活动数据集恢复引用失败：${errText(error)}`;
    sessionLog(detail);
    return { hydrated: false, error: detail };
  }
  if (!ref) return { hydrated: false, error: null };
  const revision = datasetIntentRevision;
  const clearRefIfStillOwned = (): string | null => {
    try {
      if (isCurrentDatasetIntent(revision) && localStorage.getItem(LS_ACTIVE_REF) === ref) {
        removeActiveRefVerified(ref);
      }
      return null;
    } catch (error) {
      // 引用保留比误删更安全；未经读回确认时启动必须 fail closed。
      return `活动数据集恢复引用未能删除：${errText(error)}`;
    }
  };
  let localJson: string | null;
  try { localJson = localStorage.getItem(LS_DATASET); } catch (error) {
    const detail = `读取 localStorage 活动数据集失败：${errText(error)}`;
    sessionLog(detail);
    return { hydrated: false, error: detail };
  }
  let json: string | null;
  try {
    json = await db.get(ref);
  } catch (error) {
    // IPC/锁竞争/磁盘暂时不可用不是“数据不存在”。保留同一个 ref，下次启动仍可重试。
    const detail = `活动数据集 ${ref} 暂时无法从本机库读取，已保留恢复引用 · ${errText(error)}`;
    sessionLog(detail);
    return { hydrated: false, error: detail };
  }
  if (!isCurrentDatasetIntent(revision)) return { hydrated: false, error: null };
  if (json === null) {
    // 只有 SQLite 明确返回不存在才清理悬空引用。
    const clearError = clearRefIfStillOwned();
    if (clearError) {
      sessionLog(clearError);
      return { hydrated: false, error: clearError };
    }
    sessionLog(`活动数据集 ${ref} 在本机库中不存在，已清除悬空恢复引用`);
    return { hydrated: false, error: null };
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    const detail = projectStoreValidationError(LS_DATASET, parsed);
    if (detail) throw new Error(detail);
    const data = parsed as StoredDataset;
    if (data.name !== ref) throw new Error('活动数据集引用与库内容名称不一致');
    let authoritative = data;
    let authority = 'SQLite';
    if (localJson !== null) {
      let localData: StoredDataset | null = null;
      try {
        const localParsed = JSON.parse(localJson) as unknown;
        const localDetail = projectStoreValidationError(LS_DATASET, localParsed);
        if (localDetail) throw new Error(localDetail);
        localData = localParsed as StoredDataset;
      } catch (error) {
        quarantineCorruptStore(LS_DATASET, localJson, `localStorage 活动数据集损坏：${errText(error)}`);
      }
      if (localData) {
        const sameContent = JSON.stringify(localData) === JSON.stringify(data);
        const localSavedAt = Date.parse(localData.savedAt);
        const vaultSavedAt = Date.parse(data.savedAt);
        if (sameContent || (Number.isFinite(localSavedAt) && Number.isFinite(vaultSavedAt)
          && localSavedAt > vaultSavedAt)) {
          // localStorage 是同一版或明确更新的版本。先删除旧 ref 并读回确认，
          // 再发布本地值；否则下次启动仍可能被旧 SQLite 覆盖。
          const clearError = clearRefIfStillOwned();
          if (clearError) {
            sessionLog(clearError);
            return { hydrated: false, error: clearError };
          }
          authoritative = localData;
          authority = 'localStorage';
        } else if (!Number.isFinite(localSavedAt) || !Number.isFinite(vaultSavedAt)
          || localSavedAt === vaultSavedAt) {
          const conflict = `活动数据集「${ref}」的 localStorage 与 SQLite 内容不同，且 savedAt 无法确定新旧；已保留两份副本并阻止启动`;
          sessionLog(conflict);
          return { hydrated: false, error: conflict };
        }
        // vaultSavedAt > localSavedAt 时 SQLite 明确更新，保留 ref 作为超配额恢复路径。
      }
    }
    const model = modelFromStored(authoritative);
    if (!isCurrentDatasetIntent(revision)) return { hydrated: false, error: null };
    const coordinated = coordinateRecentsWithActive(useData.getState().recents, authoritative);
    useData.setState({
      model, textCols: authoritative.textCols ?? [], pendingCells: pendingFromStored(authoritative),
      recents: coordinated.recents, undoStack: [], redoStack: [],
    });
    if (coordinated.changed) persistRecents(coordinated.recents, authoritative);
    settleEvictedRecents(coordinated.evicted);
    suggestSpec(model, authoritative.textCols ?? []);
    sessionLog(authority === 'SQLite'
      ? `从数据集库恢复活动数据集 ${ref}(上次因超配额存于本机库)`
      : `localStorage 活动数据集比 SQLite 引用更新，已保留 ${authoritative.name} 并清除旧引用`);
    return { hydrated: true, error: null };
  } catch (error) {
    // 读成功但载荷结构损坏：保存原始 JSON 证据，再清当前悬空/有害引用。
    const detail = `SQLite 活动数据集「${ref}」结构损坏：${errText(error)}`;
    const preserved = preserveCorruptStore(LS_DATASET, json, detail);
    const clearError = clearRefIfStillOwned();
    sessionLog(`${detail}；${preserved ? '原始文本已隔离' : '隔离失败（可能空间不足）'}${clearError ? `；${clearError}` : ''}`);
    try {
      useApp.getState().showToast(
        `本机库活动数据集「${ref}」已损坏，恢复引用已停用${preserved ? '，原始文本已保留在隔离区' : ''}`,
      );
    } catch { /* 非 UI 环境忽略 */ }
    return { hydrated: false, error: clearError };
  }
}

export interface PersistentDataStartupResult {
  /** false 时主界面不得挂载，避免用户在半恢复项目上继续编辑。 */
  ready: boolean;
  hydrated: boolean;
  /** SQLite/localStorage 已确定前向完成或完整回滚，必须刷新全部模块级 store。 */
  reloadRequired: boolean;
  error: string | null;
}

/**
 * 项目 journal 已在加载任何业务 store 之前收口。本阶段只处理
 * 超 localStorage 后仅存 SQLite 的活动表，并且仍在 App 挂载之前完成。
 */
export async function hydrateLoadedDataAfterProjectRecovery(): Promise<PersistentDataStartupResult> {
  const db = platform.datasetDb;
  if (!db) return { ready: true, hydrated: false, reloadRequired: false, error: null };
  const active = await hydrateActiveRefFromVault(db);
  return {
    ready: active.error === null,
    hydrated: active.hydrated,
    reloadRequired: false,
    error: active.error,
  };
}

/**
 * 应用启动屏障：先收口项目 journal，再恢复仅存 SQLite 的活动数据集。
 * main.tsx 必须等待本函数，不能让 App 在未完成恢复时进入可编辑状态。
 */
export async function initializePersistentData(): Promise<PersistentDataStartupResult> {
  const db = platform.datasetDb;
  // Web 端也有独立的 stores journal；不得因没有 datasetDb 就跳过启动屏障。
  // 无任何 journal 时保留旧的单微任务 hydrate 时序，不为每次正常启动额外打开 IndexedDB。
  if (hasPendingProjectImportJournal() || Boolean(db?.pendingProjectImport)) {
    const recovery = await recoverPendingProjectImport();
    if (recovery.error) sessionLog(recovery.error);
    if (recovery.reloadRequired) {
      return {
        ready: false,
        hydrated: false,
        reloadRequired: true,
        error: recovery.error,
      };
    }
    if (recovery.error) {
      return {
        ready: false,
        hydrated: false,
        reloadRequired: false,
        error: recovery.error,
      };
    }
  }
  return hydrateLoadedDataAfterProjectRecovery();
}

/**
 * 兼容既有测试/显式恢复入口。生产启动由 main.tsx 调用 initializePersistentData；
 * 不再在模块加载时 fire-and-forget，避免恢复完成前 UI 已经可编辑。
 */
export async function hydrateActiveFromVault(): Promise<boolean> {
  const startup = await initializePersistentData();
  if (startup.reloadRequired && platform.isDesktop && typeof window !== 'undefined') {
    window.location.reload();
    return false;
  }
  return startup.ready && startup.hydrated;
}
