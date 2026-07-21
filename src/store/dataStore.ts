/**
 * 活动数据集 store — 变量模型 + 计数模型（P/C）+ 文本分组列。
 * localStorage 持久化：偏好由 appStore persist,数据集与最近列表在此维护。
 */
import { create } from 'zustand';
import {
  buildData, computeVarModel, computePChart, computeCChart, evalFormula, truthy, FormulaError, prepareSpcData, isDoeAnalysisColumn, worksheetDisplayOrder, worksheetNumericColumnCodes, mean, stdev,
  type VarModel, type PChartModel, type CChartModel, type TextColumn, type SpcPreparedData,
} from '../core';
import { useApp } from './appStore';
import { sessionLog } from './sessionLog';
import { platform } from '../platform/adapter';
import { projectStoreValidationError, registerProjectLifecycleHooks } from '../platform/project';
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
const MAX_RECENTS = 5;
const MAX_MES_SUBGROUPS = 200;

/** 本会话内所有已见数据集名（包括已从最近列表滑出的名称）。 */
const knownDatasetNames = new Set<string>();
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
}

export interface DatasetModelOptions {
  isDemo?: boolean;
  indivSeries?: number[];
  /** 仅用于“另存为副本”等列结构完全不变的切换；普通导入必须清除旧 SPC 角色。 */
  preserveSpcRoles?: boolean;
  /** 历史恢复/同结构副本会在随后回放规格；普通同名重导入必须忘掉旧内容的规格。 */
  preserveSpecs?: boolean;
}

export interface PendingCell { row: number; col: number }

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
/** P0-5:持久化结果契约——只有 persisted=true 才允许 UI 显示绿色成功。 */
export interface PersistOutcome { persisted: boolean; archiving: boolean }

let activeUnpersistedFlag = false;
function setActiveUnpersisted(v: boolean) {
  if (activeUnpersistedFlag === v) return;
  activeUnpersistedFlag = v;
  try { useData.setState({ activeUnpersisted: v }); } catch { /* store 尚未就绪时忽略 */ }
}
/** 项目导入成功后旧内存数据注定被替换——上遮罩重载前清除未持久化标记,避免 beforeunload 拦截自动重载。 */
export function markActiveDataReplaced(): void { setActiveUnpersisted(false); }

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!activeUnpersistedFlag) return;
    e.preventDefault();
    e.returnValue = '当前数据尚未持久化，离开将丢失；请先「文件 → 导出项目」备份。';
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
    dirtyProjectStores.delete(key);
    storageWarned = false;
    return true;
  } catch {
    dirtyProjectStores.set(key, encoded);
    // 存储超限(浏览器 localStorage 通常约 5MB)：应用继续在内存工作。
    // silent=true 时由调用方接管提示(桌面端会转投 SQLite 数据集库)。
    if (!silent && !storageWarned) {
      storageWarned = true;
      sessionLog('本地存储写入失败(可能超限)· 数据仍在内存,建议 保存到项目 导出文件');
      try {
        useApp.getState().showToast('本地存储已满,本次未自动保存;请用「保存到项目」导出为文件');
      } catch { /* 非浏览器环境忽略 */ }
    }
    return false;
  }
}

type CopySequenceMap = Record<string, number>;

function copyBaseOf(name: string): string {
  return name.replace(/ \(副本\d*\)$/, '');
}

function copySequenceOf(name: string, base: string): number | null {
  const prefix = `${base} (副本`;
  if (!name.startsWith(prefix) || !name.endsWith(')')) return null;
  const suffix = name.slice(prefix.length, -1);
  if (suffix === '') return 1;
  return /^\d+$/.test(suffix) && Number(suffix) >= 2 ? Number(suffix) : null;
}

function allocateCopyName(sourceName: string, currentNames: Iterable<string>): string {
  const base = copyBaseOf(sourceName);
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

interface DataState {
  /** P0-5:活动数据仅存在内存、未成功持久化(刷新会丢)。 */
  activeUnpersisted: boolean;
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
  ): void;
  importCounts(kind: 'p' | 'c', name: string, counts: number[], sampleSize?: number | number[]): PersistOutcome;
  /** 导入帕累托「类别+频数」数据并持久化 */
  importPareto(name: string, rows: ParetoRow[]): PersistOutcome;
  /** 清除活动帕累托数据（旧分析记录无法重建时用于避免误显当前数据）。 */
  clearPareto(): void;
  /** 加载成功返回 true；异步库读取会丢弃过期响应，避免后完成的旧请求覆盖新工作。 */
  loadRecent(name: string, preserveSpcRoles?: boolean): Promise<boolean>;
  resetDemo(): void;
  /** 手工录入：编辑单元格 / 添加子组（复制末行） / 删除行。编辑演示集自动转「副本」。 */
  updateCell(row: number, col: number, value: number): void;
  addSubgroupRow(): void;
  deleteRow(row: number): void;
  undoEdit(): boolean;
  redoEdit(): boolean;
  /** 新建空白工作表（5 列 × 3 行；有限占位值与 pendingCells 分离） */
  newWorksheet(): void;
  /** 当前数据集另存为「xxx (副本)」并激活 */
  saveAsCopy(): string;
  /** 列 z-score 标准化 → 新数据集 */
  standardize(): string | null;
  /** 生成正态随机数据集 */
  generateRandom(mu: number, sigma: number, k: number, n: number): string;
  /** 按测量列排序（文本列同步重排） */
  sortBy(col: number, asc: boolean): void;
  /** 从最近列表移除（不影响当前数据集） */
  removeRecent(name: string): void;
  /** 重命名测量列（col 为测量列索引 0-based） */
  renameColumn(col: number, name: string): void;
  /** 删除测量列（至少保留 1 列） */
  deleteColumn(col: number): void;
  /** 在末尾插入数值列（值默认取各行首列的副本,便于随后编辑） */
  insertColumn(): void;
  /** 用公式（引用工作表顶部 C# 数值列/列名）算出一列并追加;成功返回 null,失败返回错误信息 */
  addFormulaColumn(name: string, expr: string): string | null;
  /** 按条件表达式（C# 与工作表顶部编号同源）筛出子集为新数据集 */
  subsetByCondition(cond: string): { ok: true; name: string; kept: number; total: number } | { ok: false; error: string };
  /** 统计与替换测量值(3dp 显示容差);col=-1 全部列。replace 为 null 只计数。可撤销。 */
  findReplace(find: number, replace: number | null, col: number): number;
  /** 转置：k×n → n×k；可只转置 SPC 角色层确认的子组列。 */
  transposeDataset(sourceColumns?: string[]): void;
  /** 堆叠：多测量列堆成单列 + 「来源列」分组标签,生成新数据集「xxx (堆叠)」 */
  stackColumns(): void;
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

function specRoleKey(model: VarModel, textCols: TextColumn[]): string | null {
  const prepared = resolveActiveMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return null;
  return `v2:${encodeURIComponent(model.name)}:${encodeURIComponent(prepared.variableName)}`;
}

function forgetSpecsForDataset(name: string): void {
  const map = loadValidatedStoreJson<SpecMap>(LS_SPECS) ?? {};
  const prefix = `v2:${encodeURIComponent(name)}:`;
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key === name || key.startsWith(prefix)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) saveJson(LS_SPECS, map);
}

/** 记住某数据集的规格限（Capability 页编辑时写入） */
export function rememberSpecFor(name: string, spec: { lsl: number; tgt: number; usl: number }) {
  const map = loadValidatedStoreJson<SpecMap>(LS_SPECS) ?? {};
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
  const map = loadValidatedStoreJson<SpecMap>(LS_SPECS) ?? {};
  map[key] = spec;
  saveJson(LS_SPECS, map);
}

/** 能力页规格键:跟随能力口径(capSubgroup*)解析出的测量特性;默认「沿用 SPC 角色」时与 SPC 键一致。
 * 批次716-R2 P0:规格必须绑定能力口径,否则切换能力测量列后沿用旧量纲规格会产出虚假 Cpk。
 * 导出供能力页比较口径键是否真的变化——零变化的点击不得触发规格同步(否则会冲掉历史回放的快照规格)。 */
export function capabilitySpecKey(model: VarModel, textCols: TextColumn[]): string | null {
  const prepared = resolveCapabilityMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return null;
  return `v2:${encodeURIComponent(model.name)}:${encodeURIComponent(prepared.variableName)}`;
}

/** 能力页编辑规格时按「数据集 + 能力口径测量特性」记忆,不再写入 SPC 口径的键(防反向污染)。 */
export function rememberSpecForCapabilityMeasurement(
  model: VarModel,
  textCols: TextColumn[],
  spec: { lsl: number; tgt: number; usl: number; lslOn: boolean; uslOn: boolean },
): void {
  const key = capabilitySpecKey(model, textCols);
  if (!key) return;
  const map = loadValidatedStoreJson<SpecMap>(LS_SPECS) ?? {};
  map[key] = spec;
  saveJson(LS_SPECS, map);
}

/** 能力口径变化(切换子组模式/测量列/ID 列)后同步规格:该特性有记忆用记忆,否则按新口径
 * μ±4σ 重建议;口径解析失败时不动当前规格(页面会显示错误卡)。返回规格是否发生变化。 */
export function syncSpecForCapabilityMeasurement(): boolean {
  const { model, textCols } = useData.getState();
  const prepared = resolveCapabilityMeasurementData(model, textCols);
  if (!prepared.model || prepared.error) return false;
  const key = `v2:${encodeURIComponent(model.name)}:${encodeURIComponent(prepared.variableName)}`;
  const map = loadValidatedStoreJson<SpecMap>(LS_SPECS) ?? {};
  const app0 = useApp.getState();
  // 旧版仅按数据集名保存的记忆规格:与 specForActiveMeasurement 同口径兼容读取
  // (仅默认「沿用 SPC 角色」且完全自动、无显式角色时),避免建议值顶掉用户的图纸规格。
  const legacy = app0.capSubgroupMode === 'spc' && app0.spcDataLayout === 'auto'
    && app0.spcValueCol == null && app0.spcSubgroupCol == null
    ? map[model.name]
    : undefined;
  const saved = map[key] ?? legacy;
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
  const map = loadValidatedStoreJson<SpecMap>(LS_SPECS) ?? {};
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
const storedAttr = loadValidatedStoreJson<{
  p?: { name: string; counts: number[]; sampleSize?: number; sampleSizes?: number[] };
  c?: { name: string; counts: number[] };
}>(LS_ATTR);
const stored = loadValidatedStoreJson<StoredDataset>(LS_DATASET);
const storedRecents = loadValidatedStoreJson<RecentEntry[]>(LS_RECENTS) ?? [];
if (stored?.name) knownDatasetNames.add(stored.name);
storedRecents.forEach((entry) => knownDatasetNames.add(entry.name));
// 列库是异步能力：启动后预热名称缓存，供后续同步的「另存为副本」尽可能规避库中旧名。
platform.datasetDb?.list().then((entries) => {
  entries.forEach((entry) => knownDatasetNames.add(entry.name));
}).catch(() => { /* 库不可用不影响本地高水位 */ });

function modelFromStored(data: StoredDataset): VarModel {
  const detail = projectStoreValidationError(LS_DATASET, data);
  if (detail) throw new Error(`数据集结构损坏：${detail}`);
  return computeVarModel(data.name, data.colNames, data.rows, {
    isDemo: data.isDemo === true,
    indivSeries: data.indivSeries?.map((value) => value),
  });
}

function storedModelMetadata(model: VarModel, rows: number[][]): Pick<StoredDataset, 'isDemo' | 'indivSeries'> {
  const flattened = rows.flat();
  const hasDistinctIndiv = flattened.length !== model.indiv.length
    || flattened.some((value, index) => value !== model.indiv[index]);
  return {
    isDemo: model.isDemo || undefined,
    indivSeries: hasDistinctIndiv ? [...model.indiv] : undefined,
  };
}

function pendingFromStored(data: StoredDataset): PendingCell[] {
  const source = data.pendingCells ?? data.colNames.flatMap((name, col) =>
    /待录入/.test(name)
      ? data.rows.flatMap((row, rowIndex) => row[col] === 0 ? [{ row: rowIndex, col }] : [])
      : [],
  );
  return source.filter((p) =>
    Number.isInteger(p.row) && Number.isInteger(p.col)
    && p.row >= 0 && p.row < data.rows.length && p.col >= 0 && p.col < data.colNames.length,
  );
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

/** 每次用户主动切换/编辑活动数据集都推进版本，异步恢复只能提交同一版本的结果。 */
let datasetIntentRevision = 0;
function beginDatasetIntent(): number {
  datasetIntentRevision += 1;
  return datasetIntentRevision;
}

function isCurrentDatasetIntent(revision: number): boolean {
  return revision === datasetIntentRevision;
}

function snapshotOf(st: DataState): EditSnapshot {
  return {
    name: st.model.name,
    colNames: [...st.model.colNames],
    rows: st.model.subs.map((s) => [...s.vals]),
    textCols: st.textCols.map((c) => ({ ...c, values: [...c.values] })),
    pendingCells: st.pendingCells.map((p) => ({ ...p })),
    ...storedModelMetadata(st.model, st.model.subs.map((subgroup) => subgroup.vals)),
  };
}

function restoreSnapshot(set: SetFn, get: GetFn, snap: EditSnapshot) {
  beginDatasetIntent();
  const model = computeVarModel(snap.name, snap.colNames, snap.rows, {
    isDemo: snap.isDemo === true,
    indivSeries: snap.indivSeries?.map((value) => value),
  });
  const data: StoredDataset = {
    name: snap.name, colNames: snap.colNames, rows: snap.rows, textCols: snap.textCols,
    pendingCells: snap.pendingCells, isDemo: snap.isDemo, indivSeries: snap.indivSeries,
    savedAt: new Date().toISOString(),
  };
  const recents = [
    { name: data.name, savedAt: data.savedAt, data },
    ...get().recents.filter((r) => r.name !== data.name),
  ].slice(0, MAX_RECENTS);
  set({ model, textCols: snap.textCols, pendingCells: snap.pendingCells, recents });
  persistActive(data);
  persistRecents(recents);
  archiveToVault(data);
}

/** 桌面端把数据集镜像归档到本机 SQLite 数据集库(不受 localStorage 配额限制)。
 * 400ms 尾随防抖,连续编辑只落一次;Web 端 datasetDb 为 null,静默跳过。 */
interface PendingVaultArchive { timer: ReturnType<typeof setTimeout>; data: StoredDataset }
const vaultTimers = new Map<string, PendingVaultArchive>();
const vaultWrites = new Set<Promise<void>>();
const failedVaultArchives = new Map<string, StoredDataset>();
/** localStorage 超限但最新活动表尚未在 SQLite+active-ref 同时确认的载荷。 */
let pendingOversizeActive: StoredDataset | null = null;

function establishActiveRef(name: string): void {
  if (protectedCorruptStores.has(LS_DATASET)) {
    throw new Error('损坏的活动数据原文尚未成功隔离，已禁止建立会覆盖它的恢复引用');
  }
  try {
    localStorage.setItem(LS_ACTIVE_REF, name);
  } catch {
    localStorage.removeItem(LS_DATASET);
    localStorage.setItem(LS_ACTIVE_REF, name);
  }
  // active-ref 已确认后，SQLite 才是唯一权威副本；必须移除同名旧 localStorage 矩阵。
  // 即使移除异常，启动恢复也会无条件优先读取 active-ref，不能按名称误判为“已恢复”。
  try { localStorage.removeItem(LS_DATASET); } catch { /* active-ref 仍可保证恢复优先级 */ }
  dirtyProjectStores.delete(LS_DATASET);
}

function trackVaultWrite(promise: Promise<void>): Promise<void> {
  const tracked = promise.finally(() => vaultWrites.delete(tracked));
  vaultWrites.add(tracked);
  return tracked;
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

/** 删除单个库数据集前，取消同名防抖并等待更早的同名/其他在途写入落定。 */
export async function prepareVaultDatasetRemoval(name: string): Promise<void> {
  if (useData.getState().model.name === name) {
    throw new Error(`不能删除当前活动数据集「${name}」；请先切换数据集或导出项目`);
  }
  const pending = vaultTimers.get(name);
  if (pending) clearTimeout(pending.timer);
  vaultTimers.delete(name);
  await waitForVaultWrites();
  let activeRef: string | null = null;
  try { activeRef = localStorage.getItem(LS_ACTIVE_REF); } catch { /* 由下面其他守卫继续保护 */ }
  if (useData.getState().model.name === name || pendingOversizeActive?.name === name || activeRef === name) {
    throw new Error(`不能删除当前活动数据集「${name}」；请先切换数据集或导出项目`);
  }
  failedVaultArchives.delete(name);
}

/** 导出项目前把 400ms 防抖内容即时写入，并等待所有已经提交的 SQLite 写入。 */
async function flushPendingVaultWrites(): Promise<void> {
  const db = platform.datasetDb;
  const pending = [...vaultTimers.values()];
  pending.forEach(({ timer }) => clearTimeout(timer));
  vaultTimers.clear();
  // 先等已经提交的旧写入结束，再写本轮捕获的最新防抖值；顺序反过来会让迟到旧写覆盖新快照。
  await waitForVaultWrites();
  if (db) {
    const latest = new Map<string, StoredDataset>([...failedVaultArchives.entries()]);
    for (const { data } of pending) latest.set(data.name, data);
    for (const data of latest.values()) {
      try {
        await db.put(data.name, JSON.stringify(data));
        failedVaultArchives.delete(data.name);
      } catch (error) {
        failedVaultArchives.set(data.name, data);
        throw error;
      }
    }
  }
  if (pendingOversizeActive) {
    if (!db) throw new Error('活动数据集尚未持久化，且 SQLite 数据集库不可用');
    const latest = pendingOversizeActive;
    if (useData.getState().model.name !== latest.name) {
      pendingOversizeActive = null;
      return;
    }
    await db.put(latest.name, JSON.stringify(latest));
    establishActiveRef(latest.name);
    pendingOversizeActive = null;
  }
}

/** 清空数据前取消尚未落库的防抖任务，并使所有在途加载/恢复请求失效。 */
export function cancelPendingDatasetWork(): void {
  beginDatasetIntent();
  vaultTimers.forEach(({ timer }) => clearTimeout(timer));
  vaultTimers.clear();
  failedVaultArchives.clear();
  pendingOversizeActive = null;
  dirtyProjectStores.clear();
  protectedCorruptStores.clear();
  knownDatasetNames.clear();
  knownDatasetNames.add('质检数据.mtw');
}

export function archiveToVault(data: StoredDataset) {
  knownDatasetNames.add(data.name);
  const db = platform.datasetDb;
  if (!db) return;
  const prev = vaultTimers.get(data.name);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    vaultTimers.delete(data.name);
    const write = trackVaultWrite(db.put(data.name, JSON.stringify(data)).then(() => {
      failedVaultArchives.delete(data.name);
    }));
    void write.catch(() => {
      failedVaultArchives.set(data.name, data);
      // 普通镜像失败不打断编辑；项目导出会重试并显式失败。
    });
  }, 400);
  vaultTimers.set(data.name, { timer, data });
}

/** 活动数据集落盘。localStorage 写不下时(超 ~5MB):桌面端即时归档到 SQLite
 * 并留恢复标记(重启自动恢复),Web 端沿用原有超限提示。 */
function persistActive(data: StoredDataset): PersistOutcome {
  const db = platform.datasetDb;
  if (saveJson(LS_DATASET, data, db != null)) {
    pendingOversizeActive = null;
    try { localStorage.removeItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
    setActiveUnpersisted(false);
    return { persisted: true, archiving: false };
  }
  if (!db) { setActiveUnpersisted(true); return { persisted: false, archiving: false }; } // Web 端:仅内存,未落盘
  pendingOversizeActive = data;
  const prev = vaultTimers.get(data.name); // 绕过防抖,立即归档,避免窗口期丢数据
  if (prev) { clearTimeout(prev.timer); vaultTimers.delete(data.name); }
  const revision = datasetIntentRevision;
  const write = trackVaultWrite(db.put(data.name, JSON.stringify(data)).then(() => {
    if (!isCurrentDatasetIntent(revision) || useData.getState().model.name !== data.name) return;
    // 配额已满时先移除旧的活动矩阵副本，再写极小的 SQLite 恢复引用。
    establishActiveRef(data.name);
    pendingOversizeActive = null;
    setActiveUnpersisted(false);
    sessionLog(`数据集 ${data.name} 超浏览器配额,已存入本机数据集库(重启自动恢复)`);
    try {
      useApp.getState().showToast('数据集超出浏览器存储配额,已安全存入本机数据集库,重启自动恢复');
    } catch { /* 非浏览器环境忽略 */ }
  }));
  void write.catch(() => {
    // 只有成功写库后才建立 active-ref；失败时绝不能让旧同名库数据冒充本次活动表。
    try {
      if (localStorage.getItem(LS_ACTIVE_REF) === data.name) localStorage.removeItem(LS_ACTIVE_REF);
      // 与成功回调同一守卫:过期失败不得把「已被替换且已持久化」的当前数据集误标为未持久化。
      if (!isCurrentDatasetIntent(revision) || useData.getState().model.name !== data.name) return;
      setActiveUnpersisted(true);
      useApp.getState().showToast('数据集过大且归档失败,当前数据尚未持久化；请释放空间后重试');
    } catch { /* 忽略 */ }
  });
  setActiveUnpersisted(true); // 归档完成前视为未持久化;成功回调会清除
  return { persisted: false, archiving: true };
}

/** 最近列表落盘。写不下时桌面端把条目瘦身(仅名称/时间,数据在 SQLite 库)再写一次。 */
function persistRecents(recents: RecentEntry[]) {
  const db = platform.datasetDb;
  if (saveJson(LS_RECENTS, recents, db != null)) return;
  if (!db) return;
  const light = recents.map((r) => ({ name: r.name, savedAt: r.savedAt }));
  saveJson(LS_RECENTS, light, true);
}

registerProjectLifecycleHooks({
  beforeMutation: () => {
    // 先阻止新加载/新防抖触发，但保留待写载荷；只有 flush 成功后项目导入才可继续。
    beginDatasetIntent();
    vaultTimers.forEach(({ timer }) => clearTimeout(timer));
  },
  settleBeforeMutation: flushPendingVaultWrites,
  beforeExport: async () => {
    if (protectedCorruptStores.size > 0) {
      throw new Error(`损坏的本地数据尚未成功复制到隔离区（${[...protectedCorruptStores.keys()].join('、')}），项目未导出`);
    }
    await flushPendingVaultWrites();
  },
  projectStoreOverrides: () => Object.fromEntries(dirtyProjectStores),
});

/** 编辑落库：演示集首次编辑转「质检数据 (副本)」,导入集原名持久化并同步最近列表。
 * colNames 省略时沿用当前列名（值编辑）;传入时用于列结构变化（重命名/增删列）。 */
function applyEdit(
  set: SetFn, get: GetFn, rows: number[][], textCols: TextColumn[], colNames?: string[],
  pendingCells: PendingCell[] = get().pendingCells,
) {
  beginDatasetIntent();
  const st = get();
  const m = st.model;
  // 编辑前快照入撤销栈,清空重做栈
  set({
    undoStack: [...st.undoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
    redoStack: [],
  });
  const cols = colNames ?? m.colNames;
  const name = m.isDemo ? '质检数据 (副本)' : m.name;
  const model = computeVarModel(name, cols, rows);
  const data: StoredDataset = { name, colNames: cols, rows, textCols, pendingCells, savedAt: new Date().toISOString() };
  const recents = [
    { name, savedAt: data.savedAt, data },
    ...get().recents.filter((r) => r.name !== name),
  ].slice(0, MAX_RECENTS);
  set({ model, textCols, pendingCells, recents });
  persistActive(data);
  persistRecents(recents);
  archiveToVault(data);
}

export const useData = create<DataState>((set, get) => ({
  model: initModel,
  textCols: initText,
  pModel: initP,
  cModel: initC,
  paretoModel: loadValidatedStoreJson<ParetoModel>(LS_PARETO),
  pendingCells: initPending,
  recents: storedRecents,
  activeUnpersisted: false,
  mesRunning: false,
  undoStack: [],
  redoStack: [],

  importMatrix: (name, colNames, rows, textCols = [], pendingCells = [], modelOptions = {}) => {
    beginDatasetIntent();
    const normalized = normalizeImportColumns(colNames, textCols);
    const model = computeVarModel(name, normalized.colNames, rows, {
      isDemo: modelOptions.isDemo === true,
      indivSeries: modelOptions.indivSeries?.map((value) => value),
    });
    const validPending = pendingCells.filter((p) =>
      Number.isInteger(p.row) && Number.isInteger(p.col)
      && p.row >= 0 && p.row < rows.length && p.col >= 0 && p.col < normalized.colNames.length,
    );
    const data: StoredDataset = {
      name, colNames: normalized.colNames, rows, textCols: normalized.textCols, pendingCells: validPending,
      ...storedModelMetadata(model, rows),
      savedAt: new Date().toISOString(),
    };
    const recents = [
      { name, savedAt: data.savedAt, data },
      ...get().recents.filter((r) => r.name !== name),
    ].slice(0, MAX_RECENTS);
    // 导入/创建/另存为会切换数据集，编辑历史不得跨数据集生效。
    set({ model, textCols: normalized.textCols, pendingCells: validPending, recents, undoStack: [], redoStack: [] });
    if (!modelOptions.preserveSpcRoles) resetDatasetSpcRoles();
    if (!modelOptions.preserveSpecs) forgetSpecsForDataset(name);
    useApp.setState({ anovaShowDemo: false });
    knownDatasetNames.add(name);
    const outcome = persistActive(data);
    persistRecents(recents);
    archiveToVault(data);
    if (!modelOptions.preserveSpecs) suggestSpec(model, normalized.textCols);
    if (normalized.changed) {
      sessionLog(`导入列名已规范化 ${name} · 空名使用 C#/T#，重名追加序号`);
      try { useApp.getState().showToast('导入列名存在空值或重复，已稳定规范化（重名列追加序号）'); } catch { /* 非 UI 环境忽略 */ }
    }
    sessionLog(`导入变量数据 ${name} · ${rows.length} 行 × ${normalized.colNames.length} 个数值列`);
    return outcome;
  },

  writeAnalysisColumns: (numericColumns, textColumns = []) => {
    const st = get();
    const rowCount = st.model.k;
    const allNames = [...numericColumns.map((column) => column.name), ...textColumns.map((column) => column.name)];
    if (new Set(allNames).size !== allNames.length) throw new Error('分析输出列名不能重复');
    for (const column of numericColumns) {
      if (!column.name.trim()) throw new Error('分析输出列名不能为空');
      if (column.values.length !== rowCount) throw new Error(`「${column.name}」行数与工作表不一致`);
      if (column.values.some((value) => !Number.isFinite(value))) throw new Error(`「${column.name}」包含非有限数值`);
    }
    for (const column of textColumns) {
      if (!column.name.trim()) throw new Error('分析输出列名不能为空');
      if (column.values.length !== rowCount) throw new Error(`「${column.name}」行数与工作表不一致`);
    }

    const textNameSet = new Set(textColumns.map((column) => column.name));
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
    const numericNameSet = new Set(numericColumns.map((column) => column.name));
    const nextText = st.textCols
      .filter((column) => !numericNameSet.has(column.name) && !textNameSet.has(column.name))
      .map((column) => ({ ...column, values: [...column.values] }));
    nextText.push(...textColumns.map((column) => ({ name: column.name, values: [...column.values] })));
    applyEdit(set, get, rows, nextText, colNames, pendingCells);
    sessionLog(`写回分析结果 · ${numericColumns.length} 个数值列 + ${textColumns.length} 个文本列`);
  },

  importCounts: (kind, name, counts, sampleSize: number | number[] = 50) => {
    let persisted: boolean;
    if (kind === 'p') {
      const pModel = computePChart(counts, sampleSize, name);
      set({ pModel });
      persisted = persistAttr(pModel, get().cModel);
    } else {
      const cModel = computeCChart(counts, name);
      set({ cModel });
      persisted = persistAttr(get().pModel, cModel);
    }
    useApp.setState({ selSub: null, spcType: kind });
    sessionLog(`导入计数数据 ${name} · ${counts.length} 个${kind === 'p' ? '样本(P图)' : '单位(C图)'}`);
    return { persisted, archiving: false };
  },

  importPareto: (name, rows) => {
    const paretoModel: ParetoModel = { name, rows };
    set({ paretoModel });
    useApp.setState({ paretoShowDemo: false });
    const persisted = saveJson(LS_PARETO, paretoModel);
    sessionLog(`导入帕累托数据 ${name} · ${rows.length} 个类别`);
    return { persisted, archiving: false };
  },

  clearPareto: () => {
    set({ paretoModel: null });
    try { localStorage.removeItem(LS_PARETO); } catch { /* 非浏览器环境忽略 */ }
  },

  loadRecent: async (name, preserveSpcRoles = false) => {
    const revision = beginDatasetIntent();
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
    beginDatasetIntent();
    const d = demoInit();
    set({
      model: d.model, textCols: [], pModel: d.p, cModel: d.c, paretoModel: null,
      pendingCells: [], mesRunning: false, undoStack: [], redoStack: [],
    });
    resetDatasetSpcRoles();
    useApp.setState({ paretoShowDemo: false, anovaShowDemo: false });
    try {
      localStorage.removeItem(LS_DATASET);
      localStorage.removeItem(LS_ATTR);
      localStorage.removeItem(LS_PARETO);
      localStorage.removeItem(LS_ACTIVE_REF);
    } catch { /* 非浏览器环境忽略 */ }
    suggestSpec(d.model, []);
    sessionLog('恢复演示数据集 质检数据.mtw');
  },

  updateCell: (row, col, value) => {
    if (!Number.isFinite(value)) return;
    const m = get().model;
    const rows = m.subs.map((s) => [...s.vals]);
    if (row < 0 || row >= rows.length || col < 0 || col >= m.n) return;
    rows[row][col] = value;
    const pendingCells = get().pendingCells.filter((p) => p.row !== row || p.col !== col);
    applyEdit(set, get, rows, get().textCols, undefined, pendingCells);
  },

  addSubgroupRow: () => {
    const m = get().model;
    const rows = m.subs.map((s) => [...s.vals]);
    rows.push([...rows[rows.length - 1]]); // 复制末行,便于就地修改
    const textCols = get().textCols.map((c) => ({ ...c, values: [...c.values, c.values[c.values.length - 1] ?? ''] }));
    // 若末行仍含占位值，新复制行必须继承同列的待录入语义。
    const pendingCells = [
      ...get().pendingCells,
      ...get().pendingCells.filter((p) => p.row === m.k - 1).map((p) => ({ row: m.k, col: p.col })),
    ];
    applyEdit(set, get, rows, textCols, undefined, pendingCells);
  },

  deleteRow: (row) => {
    const m = get().model;
    if (m.k <= 2) return; // 模型至少 2 行
    const rows = m.subs.map((s) => [...s.vals]);
    if (row < 0 || row >= rows.length) return;
    rows.splice(row, 1);
    const textCols = get().textCols.map((c) => {
      const values = [...c.values];
      values.splice(row, 1);
      return { ...c, values };
    });
    const pendingCells = get().pendingCells
      .filter((p) => p.row !== row)
      .map((p) => ({ ...p, row: p.row > row ? p.row - 1 : p.row }));
    applyEdit(set, get, rows, textCols, undefined, pendingCells);
    useApp.setState({ selSub: null });
  },

  undoEdit: () => {
    const st = get();
    const snap = st.undoStack[st.undoStack.length - 1];
    if (!snap) return false;
    set({
      undoStack: st.undoStack.slice(0, -1),
      redoStack: [...st.redoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
    });
    restoreSnapshot(set, get, snap);
    sessionLog('撤销编辑');
    return true;
  },

  redoEdit: () => {
    const st = get();
    const snap = st.redoStack[st.redoStack.length - 1];
    if (!snap) return false;
    set({
      redoStack: st.redoStack.slice(0, -1),
      undoStack: [...st.undoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
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
    get().importMatrix(name, colNames, rows, [], pendingCells);
    set({ undoStack: [], redoStack: [] });
  },

  saveAsCopy: () => {
    const m = get().model;
    const names = [m.name, ...get().recents.map((entry) => entry.name)];
    const name = allocateCopyName(m.name, names);
    get().importMatrix(
      name,
      [...m.colNames],
      m.subs.map((s) => [...s.vals]),
      get().textCols.map((column) => ({ ...column, values: [...column.values] })),
      get().pendingCells.map((cell) => ({ ...cell })),
      { preserveSpcRoles: true, preserveSpecs: true },
    );
    return name;
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
    const name = m.name.replace(/\.[^.]+$/, '') + ' (标准化)';
    get().importMatrix(name, m.colNames.map((c) => c + '_z'), rows, get().textCols);
    return name;
  },

  generateRandom: (mu, sigma, k, n) => {
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
    const name = `随机数据 N(${mu},${sigma})`;
    get().importMatrix(name, Array.from({ length: n }, (_, i) => `X${i + 1}`), rows);
    return name;
  },

  sortBy: (col, asc) => {
    const m = get().model;
    if (col < 0 || col >= m.n) return;
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
    applyEdit(set, get, rows, textCols, undefined, pendingCells);
    sessionLog(`按「${m.colNames[col]}」${asc ? '升序' : '降序'}排序`);
  },

  removeRecent: (name) => {
    const recents = get().recents.filter((r) => r.name !== name);
    set({ recents });
    saveJson(LS_RECENTS, recents);
  },

  renameColumn: (col, name) => {
    const m = get().model;
    const clean = name.trim();
    if (col < 0 || col >= m.n || clean === m.colNames[col]) return;
    if (clean === '') {
      useApp.getState().showToast('列名不能为空，未保存重命名');
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
    const m = get().model;
    if (m.n <= 1) return; // 至少保留 1 个测量列
    if (col < 0 || col >= m.n) return;
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
    applyEdit(set, get, rows, textCols, colNames, pendingCells);
    useApp.setState({ selSub: null });
  },

  insertColumn: () => {
    const m = get().model;
    const nextName = nextUniqueColumnName(`测量${m.n + 1}`, [...m.colNames, ...get().textCols.map((column) => column.name)]);
    const colNames = [...m.colNames, nextName];
    const rows = m.subs.map((s) => [...s.vals, s.vals[s.vals.length - 1]]);
    const pendingCells = [
      ...get().pendingCells,
      ...get().pendingCells.filter((p) => p.col === m.n - 1).map((p) => ({ row: p.row, col: m.n })),
    ];
    applyEdit(set, get, rows, get().textCols, colNames, pendingCells);
  },

  addFormulaColumn: (name, expr) => {
    if (get().pendingCells.length > 0) return '工作表仍有待录入单元格，不能用占位值生成公式列';
    const m = get().model;
    const requestedName = name.trim();
    const existingNames = [...m.colNames, ...get().textCols.map((column) => column.name)];
    const clean = requestedName || nextUniqueColumnName(`公式${m.n + 1}`, existingNames);
    if (requestedName && existingNames.includes(clean)) return `列名「${clean}」已存在，请使用唯一列名`;
    const columns = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    let values: number[];
    try {
      values = evalFormula(expr, { columns, colNames: m.colNames, rowCount: m.k, columnNumbers: worksheetNumericColumnCodes(m.n, get().textCols) }).values;
    } catch (e) {
      return e instanceof FormulaError ? e.message : '公式计算失败：' + (e as Error).message;
    }
    const invalidRow = values.findIndex((value) => !Number.isFinite(value));
    if (invalidRow >= 0) {
      return `公式第 ${invalidRow + 1} 行未得到有限数值（可能除以 0、对负数开方或数值溢出），未添加任何数据`;
    }
    const safe = values.map((value) => Number(value.toFixed(6)));
    const colNames = [...m.colNames, clean];
    const rows = m.subs.map((s, i) => [...s.vals, safe[i]]);
    applyEdit(set, get, rows, get().textCols, colNames);
    sessionLog(`新增公式列「${clean}」= ${expr.trim()}`);
    return null;
  },

  findReplace: (find, replace, col) => {
    const m = get().model;
    // 与工作表显示一致的匹配:精确相等或 3 位小数四舍五入后相等
    const hit = (v: number) => v === find || Math.abs(v - find) < 5e-4 && Number(v.toFixed(3)) === Number(find.toFixed(3));
    let count = 0;
    const rows = m.subs.map((s) =>
      s.vals.map((v, j) => {
        if ((col === -1 || j === col) && hit(v)) {
          count++;
          return replace != null ? replace : v;
        }
        return v;
      }),
    );
    // 查找或“原值替换为原值”不代表确认录入，不能借此清除待录入标记。
    if (replace == null || count === 0 || replace === find) return count;
    const pendingCells = get().pendingCells.filter((p) => {
      if (col !== -1 && p.col !== col) return true;
      return !hit(m.subs[p.row]?.vals[p.col]);
    });
    applyEdit(set, get, rows, get().textCols, undefined, pendingCells);
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
    const name = `${base} (子集)`;
    get().importMatrix(name, [...m.colNames], rows, textCols);
    sessionLog(`条件筛选「${cond.trim()}」→ ${name} · 保留 ${kept}/${m.k} 行`);
    return { ok: true, name, kept, total: m.k };
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
    const base = m.name.replace(/ \(转置\)$/, '');
    get().importMatrix(`${base} (转置)`, colNames, t, subgroupLabels);
  },

  stackColumns: () => {
    if (get().pendingCells.length > 0) throw new Error('工作表仍有待录入单元格，请完成录入后再堆叠');
    const m = get().model;
    if (m.n < 2) throw new Error('单列数据无需堆叠');
    const rows: number[][] = [];
    const source: string[] = [];
    // 按列堆叠：列内行序保持（Minitab Stack 语义）
    m.colNames.forEach((cn, j) => {
      m.subs.forEach((s) => {
        rows.push([s.vals[j]]);
        source.push(cn);
      });
    });
    const base = m.name.replace(/ \(堆叠\)$/, '');
    get().importMatrix(`${base} (堆叠)`, ['测量值'], rows, [{ name: '来源列', values: source }]);
  },

  startMesDataset: (n) => {
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
    const recents = [
      { name: data.name, savedAt: data.savedAt, data },
      ...get().recents.filter((entry) => entry.name !== data.name),
    ].slice(0, MAX_RECENTS);
    set({ model, textCols: [], pendingCells: [], recents, undoStack: [], redoStack: [] });
    resetDatasetSpcRoles();
    persistActive(data);
    persistRecents(recents);
    archiveToVault(data);
    suggestSpec(model, []);
  },

  appendSubgroup: (vals) => {
    beginDatasetIntent();
    const m = get().model;
    if (m.subs.length >= MAX_MES_SUBGROUPS) {
      set({ mesRunning: false });
      return;
    }
    const rows = [...m.subs.map((s) => s.vals), vals];
    const model = computeVarModel(m.name, m.colNames, rows);
    const data: StoredDataset = {
      name: model.name, colNames: [...model.colNames], rows, textCols: [], pendingCells: [], savedAt: new Date().toISOString(),
    };
    const recents = [
      { name: data.name, savedAt: data.savedAt, data },
      ...get().recents.filter((entry) => entry.name !== data.name),
    ].slice(0, MAX_RECENTS);
    set({ model, pendingCells: [], recents });
    persistActive(data);
    persistRecents(recents);
    archiveToVault(data);
  },

  setMesRunning: (mesRunning) => set({ mesRunning }),
}));

/** SPC 角色在导入之后才被用户明确时，同步刷新全局规格建议，供仪表盘与能力页共用。 */
export function syncSpecForActiveMeasurement() {
  const { model, textCols } = useData.getState();
  const suggestion = specForActiveMeasurement(model, textCols);
  if (suggestion) useApp.setState(suggestion);
  return suggestion;
}

/** 启动恢复:活动数据集曾因超配额只存到 SQLite 库时(留有标记),从库中取回。
 * Web 端 datasetDb 为 null 直接跳过;测试中可显式调用。 */
export async function hydrateActiveFromVault(): Promise<boolean> {
  const db = platform.datasetDb;
  if (!db) return false;
  let ref: string | null = null;
  try { ref = localStorage.getItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
  if (!ref) return false;
  const revision = datasetIntentRevision;
  try {
    const json = await db.get(ref);
    if (!isCurrentDatasetIntent(revision)) return false;
    if (!json) {
      try { localStorage.removeItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
      return false;
    }
    const data = JSON.parse(json) as StoredDataset;
    if (data.name !== ref) throw new Error('活动数据集引用与库内容名称不一致');
    const model = modelFromStored(data);
    if (!isCurrentDatasetIntent(revision)) return false;
    useData.setState({
      model, textCols: data.textCols ?? [], pendingCells: pendingFromStored(data),
      undoStack: [], redoStack: [],
    });
    suggestSpec(model, data.textCols ?? []);
    sessionLog(`从数据集库恢复活动数据集 ${ref}(上次因超配额存于本机库)`);
    return true;
  } catch {
    try { localStorage.removeItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
    sessionLog(`活动数据集 ${ref} 恢复失败，已清除无效引用`);
    return false;
  }
}

void hydrateActiveFromVault();
