/**
 * 项目文件 (.qproj) — 单机数据的完整备份与迁移。
 * 导出:全部 qp-* 本地存储打包为单个 JSON 文件;
 * 导入:白名单校验后写回并重载,另一台机器打开即完整恢复。
 */
import { platform } from './adapter';
import { AQL_COLS, MAX_AQL_RECORDS, MAX_LOT_SIZE, normalizeSwitchStatus, ruleKValueError, type NelsonRuleK, type SwitchStatus } from '../core';

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
// 当前读取器仍兼容 v1；旧读取器会明确拒绝 v2，避免“成功”导入却静默丢活动表或账本。
const FORMAT_VERSION = 2;

interface ProjectFile {
  format: typeof FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  stores: Record<string, string>;
  /** 桌面端 SQLite 数据集库快照(name → 数据集 JSON)。可选,旧版本读取时忽略。 */
  vault?: Record<string, string>;
}

type ProjectStoreBackup = Map<(typeof PROJECT_KEYS)[number], string | null>;

const PROJECT_KEY_SET: ReadonlySet<string> = new Set(PROJECT_KEYS);

type ProjectLifecycleHooks = {
  /** 导入覆盖任何本地数据前停止采集、取消旧防抖等写入源。 */
  beforeMutation?: () => void;
  /** 取消新写入源后，等待已经提交到底层的写入完成。 */
  settleBeforeMutation?: () => void | Promise<void>;
  /** 导出逐键取快照前停止采集并把在途持久化写入落稳。 */
  beforeExport?: () => void | Promise<void>;
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

async function prepareProjectExport(): Promise<Partial<Record<(typeof PROJECT_KEYS)[number], string>>> {
  for (const hooks of projectLifecycleHooks) await hooks.beforeExport?.();
  const overrides: Partial<Record<(typeof PROJECT_KEYS)[number], string>> = {};
  for (const hooks of projectLifecycleHooks) Object.assign(overrides, hooks.projectStoreOverrides?.() ?? {});
  return overrides;
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

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
  const colNames = raw.colNames;
  if (!isStringArray(colNames) || colNames.length === 0 || colNames.some((name) => !name.trim())) {
    return '数据集 colNames 必须是非空字符串数组';
  }
  if (!Array.isArray(raw.rows) || raw.rows.length < 2) return '数据集 rows 至少需要 2 行';
  if (raw.rows.some((row) => !isFiniteNumberArray(row) || row.length !== colNames.length)) {
    return '数据集矩阵包含非有限数，或行列数与 colNames 不一致';
  }
  if (raw.textCols !== undefined) {
    if (!Array.isArray(raw.textCols)) return '数据集 textCols 不是数组';
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
  if (raw.pendingCells !== undefined) {
    if (!Array.isArray(raw.pendingCells)) return '数据集 pendingCells 不是数组';
    for (const cell of raw.pendingCells) {
      if (!isObject(cell) || !Number.isInteger(cell.row) || !Number.isInteger(cell.col)
        || (cell.row as number) < 0 || (cell.row as number) >= raw.rows.length
        || (cell.col as number) < 0 || (cell.col as number) >= colNames.length) {
        return '数据集待录入单元格坐标越界';
      }
    }
  }
  if (raw.isDemo !== undefined && typeof raw.isDemo !== 'boolean') return '数据集 isDemo 不是布尔值';
  if (raw.indivSeries !== undefined
    && (!isFiniteNumberArray(raw.indivSeries) || raw.indivSeries.length < 2)) {
    return '数据集 indivSeries 必须是至少 2 项的有限数数组';
  }
  if (requireSavedAt && (typeof raw.savedAt !== 'string' || !raw.savedAt.trim())) {
    return '数据集缺少有效 savedAt';
  }
  if (!requireSavedAt && raw.savedAt !== undefined && typeof raw.savedAt !== 'string') {
    return '数据集 savedAt 类型无效';
  }
  return null;
}

function paretoValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '帕累托数据顶层不是对象';
  if (typeof raw.name !== 'string' || !raw.name.trim()) return '帕累托数据集名称无效';
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) return '帕累托 rows 必须是非空数组';
  if (raw.rows.some((row) => !isObject(row) || typeof row.name !== 'string' || !row.name.trim()
    || typeof row.count !== 'number' || !Number.isFinite(row.count) || row.count < 0)) {
    return '帕累托类别必须包含有效名称和非负有限频数';
  }
  if (raw.rows.every((row) => (row as JsonObject).count === 0)) return '帕累托频数不能全部为 0';
  return null;
}

function pChartValidationError(raw: unknown): string | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return 'P 图数据缺少有效名称';
  if (!Array.isArray(raw.counts) || raw.counts.length < 2
    || raw.counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
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
  if (!Array.isArray(raw.counts) || raw.counts.length < 2
    || raw.counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
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
    || !Array.isArray(category.causes) || category.causes.some((cause) => typeof cause !== 'string'))) {
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

function aqlSwitchValidationError(rawSwitch: unknown): string | null {
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
    return 'AQL 责任账本含有损坏或矛盾记录';
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
  return null;
}

function aqlStateValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return 'AQL 业务状态不是有效对象';
  const allowed = new Set(['aqlLot', 'aqlLevel', 'aqlAQL', 'aqlMethod', 'aqlAcMethod', 'aqlSwitch']);
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
  if (raw.aqlMethod !== 'gb' || raw.aqlAcMethod !== 'gb') return 'AQL 正式产品路径必须使用国标方案';
  if (!('aqlSwitch' in raw)) return 'AQL 业务状态缺少责任账本';
  return aqlSwitchValidationError(raw.aqlSwitch);
}

function prefsValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '偏好设置不是有效对象';
  const envelope = raw as { state?: unknown };
  if (!isObject(envelope.state)) {
    return '偏好设置缺少有效 state';
  }
  const state = envelope.state;
  const allowedStateKeys = new Set([
    'chartStyle', 'showGrid', 'projectName', 'lsl', 'usl', 'tgt', 'lslOn', 'uslOn', 'capabilityBins',
    'gageUseReal', 'gageValueName', 'gagePartName', 'gageOperatorName',
    'aqlLot', 'aqlLevel', 'aqlAQL', 'aqlMethod', 'aqlAcMethod', 'aqlSwitch',
    'spcRules', 'spcRuleK', 'spcDataLayout', 'spcValueCol', 'spcSubgroupCol', 'spcStageCol',
    'doeView', 'doeTab', 'doeFactorCols', 'doeRespCol', 'doeModelTerms', 'doeIncludeCurvature',
    't1ColName', 't1Mu0', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
    'paretoView', 'paretoMergeOther', 'paretoThreshold',
  ]);
  const extraStateKey = Object.keys(state).find((key) => !allowedStateKeys.has(key));
  if (extraStateKey) return `偏好设置含有非白名单字段 ${extraStateKey}`;
  const extraEnvelopeKey = Object.keys(raw).find((key) => key !== 'state' && key !== 'version');
  if (extraEnvelopeKey) return `偏好设置 envelope 含有非白名单字段 ${extraEnvelopeKey}`;
  if (raw.version !== undefined && (!Number.isSafeInteger(raw.version)
    || (raw.version as number) < 0 || (raw.version as number) > 3)) {
    return '偏好设置版本无效';
  }
  const enums: Array<[string, ReadonlySet<string>]> = [
    ['chartStyle', new Set(['经典', '现代', '高对比'])],
    ['spcDataLayout', new Set(['auto', 'rows', 'stacked', 'columns', 'individuals'])],
    ['doeView', new Set(['main', 'interact', 'pareto', 'cube'])],
    ['doeTab', new Set(['analyze', 'create'])],
    ['paretoView', new Set(['pareto', 'fishbone'])],
    ['aqlMethod', new Set(['shift', 'gb'])],
    ['aqlAcMethod', new Set(['binom', 'gb'])],
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
  if (state.spcRuleK !== undefined) {
    const detail = spcRuleKValidationError(state.spcRuleK, 'SPC 判异参数');
    if (detail) return detail;
  }
  for (const key of ['showGrid', 'lslOn', 'uslOn', 'gageUseReal', 'doeIncludeCurvature', 'paretoMergeOther'] as const) {
    if (state[key] !== undefined && typeof state[key] !== 'boolean') return `偏好设置 ${key} 不是布尔值`;
  }
  for (const key of [
    'projectName', 'gageValueName', 'gagePartName', 'gageOperatorName', 'spcValueCol', 'spcSubgroupCol',
    'spcStageCol', 'doeRespCol', 't1ColName', 't2ColAName', 't2ColBName', 'regXName', 'regYName',
  ] as const) {
    if (state[key] !== undefined && state[key] !== null && typeof state[key] !== 'string') {
      return `偏好设置 ${key} 类型无效`;
    }
  }
  if ('aqlLot' in state && (!Number.isSafeInteger(state.aqlLot)
    || (state.aqlLot as number) < 2 || (state.aqlLot as number) > MAX_LOT_SIZE)) {
    return 'AQL 批量超出允许范围';
  }
  if ('aqlLevel' in state && !['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'].includes(state.aqlLevel as string)) {
    return 'AQL 检验水平无效';
  }
  if ('aqlAQL' in state && (typeof state.aqlAQL !== 'number' || !AQL_COLS.includes(state.aqlAQL))) {
    return 'AQL 值不在正式主表范围';
  }
  if (!('aqlSwitch' in state)) return null;
  return aqlSwitchValidationError(state.aqlSwitch);
}

function recentsValidationError(raw: unknown): string | null {
  if (!Array.isArray(raw)) return '最近数据集顶层不是数组';
  for (const recent of raw) {
    if (!isObject(recent) || typeof recent.name !== 'string' || !recent.name.trim()
      || typeof recent.savedAt !== 'string' || !recent.savedAt.trim()) {
      return '最近数据集条目缺少有效 name/savedAt';
    }
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
    && (!Number.isSafeInteger(raw.snapshotVersion) || ![2, 3, 4, 5].includes(raw.snapshotVersion as number))) {
    return '分析 snapshotVersion 无效';
  }
  const enums: Array<[string, ReadonlySet<string>]> = [
    ['spcType', new Set(['xbar-r', 'xbar-s', 'i-mr', 'ewma', 'cusum', 'p', 'c'])],
    ['spcDataLayout', new Set(['auto', 'rows', 'stacked', 'columns', 'individuals'])],
    ['aqlLevel', new Set(['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'])],
    ['aqlMethod', new Set(['shift', 'gb'])],
    ['aqlAcMethod', new Set(['binom', 'gb'])],
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
  if (raw.aqlLot !== undefined && (!Number.isSafeInteger(raw.aqlLot)
    || (raw.aqlLot as number) < 2 || (raw.aqlLot as number) > MAX_LOT_SIZE)) return '分析 AQL 批量无效';
  if (raw.aqlAQL !== undefined && (typeof raw.aqlAQL !== 'number' || !AQL_COLS.includes(raw.aqlAQL))) {
    return '分析 AQL 值不在正式主表范围';
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
  for (const key of [
    'lslOn', 'uslOn', 'gageUseReal', 'gageRequestedReal', 'gageSourceReal', 'doeIncludeCurvature',
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
  if (raw.sourceData !== undefined) {
    const detail = worksheetValidationError(raw.sourceData, false);
    if (detail) return `分析内嵌工作表损坏：${detail}`;
  }
  if (raw.sourceDataKey !== undefined && (typeof raw.sourceDataKey !== 'string' || !raw.sourceDataKey.trim())) {
    return '分析 sourceDataKey 无效';
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

function analysesValidationError(raw: unknown): string | null {
  if (!Array.isArray(raw)) return '分析历史顶层不是数组';
  const kinds = new Set(['spc', 'capability', 'gagerr', 'anova', 'pareto', 'doe', 'aql', 'summary']);
  for (const analysis of raw) {
    if (!isObject(analysis)) return '分析历史条目不是对象';
    for (const key of ['id', 'title', 'datasetName', 'metric', 'status', 'statusColor', 'statusBg'] as const) {
      if (typeof analysis[key] !== 'string') return `分析历史 ${key} 不是字符串`;
    }
    // P1-3:颜色字段会拼进导出 HTML 的 style 属性,必须是严格 hex,阻断事件属性注入。
    for (const key of ['statusColor', 'statusBg'] as const) {
      if (!/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(analysis[key] as string)) {
        return `分析历史 ${key} 不是合法十六进制颜色`;
      }
    }
    if (typeof analysis.kind !== 'string' || !kinds.has(analysis.kind)) return '分析历史 kind 无效';
    if (typeof analysis.createdAt !== 'number' || !Number.isFinite(analysis.createdAt)) return '分析历史 createdAt 无效';
    const detail = snapshotValidationError(analysis.snapshot);
    if (detail) return detail;
  }
  return null;
}

function analysisDataValidationError(raw: unknown): string | null {
  if (!isObject(raw)) return '分析数据仓库顶层不是对象';
  for (const [key, source] of Object.entries(raw)) {
    if (!key.trim()) return '分析数据仓库含空键';
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

function validateProjectFile(text: string): { file: ProjectFile; error: null } | { file: null; error: string } {
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
  const analyses = parsedStores.get('qp-analyses-v1');
  const analysisData = parsedStores.get('qp-analysis-data-v1');
  if (Array.isArray(analyses)) {
    for (const analysis of analyses as JsonObject[]) {
      const snapshot = analysis.snapshot as JsonObject;
      if (snapshot.sourceData === undefined && typeof snapshot.sourceDataKey === 'string'
        && (!isObject(analysisData) || !Object.prototype.hasOwnProperty.call(analysisData, snapshot.sourceDataKey))) {
        return {
          file: null,
          error: `分析历史引用的数据「${snapshot.sourceDataKey}」未包含在项目文件中`,
        };
      }
    }
  }
  if (activeRef !== undefined && !vault.entries.some(([name]) => name === activeRef)) {
    return { file: null, error: `项目活动数据集引用「${activeRef}」在 vault 中没有对应数据集` };
  }
  return { file, error: null };
}

function validateVault(raw: unknown): { entries: Array<[string, string]>; error: null } | { entries: []; error: string } {
  if (raw === undefined) return { entries: [], error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries: [], error: '项目文件的 vault 数据损坏' };
  }
  const entries: Array<[string, string]> = [];
  for (const [name, json] of Object.entries(raw)) {
    if (!name.trim()) return { entries: [], error: '项目文件的 vault 数据集名称无效' };
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

function restoreProjectStores(backup: ProjectStoreBackup): boolean {
  let restored = true;
  for (const k of PROJECT_KEYS) {
    try {
      const original = backup.get(k);
      if (original == null) localStorage.removeItem(k);
      else localStorage.setItem(k, original);
    } catch {
      restored = false;
    }
  }
  return restored;
}

function writeProjectStores(file: ProjectFile, backup: ProjectStoreBackup): string | null {
  try {
    for (const k of PROJECT_KEYS) {
      const v = file.stores[k];
      if (v != null) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    }
    return null;
  } catch {
    const restored = restoreProjectStores(backup);
    return restored
      ? '写入本地存储失败（可能空间不足），原项目已回滚'
      : '写入本地存储失败，且原项目回滚不完整；请勿继续使用当前页面并从备份恢复';
  }
}

export function buildProjectJson(
  appVersion: string,
  allowEmpty = false,
  storeOverrides: Partial<Record<(typeof PROJECT_KEYS)[number], string>> = {},
): string {
  const stores: Record<string, string> = {};
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
        throw new Error(`项目数据「${k}」JSON 损坏，项目未导出`);
      }
      const detail = projectStoreValidationError(k, parsed);
      if (detail) throw new Error(`项目数据「${k}」损坏，项目未导出：${detail}`);
    }
    stores[k] = v;
  }
  if (!allowEmpty && Object.keys(stores).length === 0) throw new Error('当前项目没有可导出的持久化数据');
  const file: ProjectFile = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    stores,
  };
  const encoded = JSON.stringify(file, null, 2);
  // Web 项目不含 SQLite 活动引用，可立即执行完整的自导入校验。
  if (Object.keys(stores).length > 0 && stores['qp-active-ref-v1'] === undefined) {
    const checked = validateProjectFile(encoded);
    if (checked.file === null) throw new Error(`生成的项目文件未通过自校验：${checked.error}`);
  }
  return encoded;
}

/** 完整导出:桌面端把 SQLite 数据集库一并嵌入(排除最近列表里已带全量数据的,避免双份)。 */
export async function buildProjectJsonFull(appVersion: string): Promise<string> {
  const overrides = await prepareProjectExport();
  const base = JSON.parse(buildProjectJson(appVersion, true, overrides)) as ProjectFile;
  const activeRef = base.stores['qp-active-ref-v1'];
  const db = platform.datasetDb;
  if (activeRef !== undefined && !activeRef.trim()) {
    throw new Error('活动数据集引用为空，项目未导出');
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
      const vault: Record<string, string> = {};
      for (const meta of await db.list()) {
        // 活动引用必须始终随 vault 导出；即使最近列表意外含有同名全量副本也不能省略。
        if (inRecents.has(meta.name) && meta.name !== activeRef) continue;
        const json = await db.get(meta.name);
        if (json == null) throw new Error(`数据集「${meta.name}」在导出期间不可读取`);
        vault[meta.name] = json;
      }
      if (activeRef !== undefined && vault[activeRef] === undefined) {
        const json = await db.get(activeRef);
        if (json == null) throw new Error(`活动数据集「${activeRef}」在导出期间不可读取`);
        vault[activeRef] = json;
      }
      const checkedVault = validateVault(vault);
      if (checkedVault.error) throw new Error(checkedVault.error);
      if (Object.keys(vault).length > 0) base.vault = vault;
    } catch (error) {
      // 完整项目不能在库读取失败时静默降级成残缺备份。
      const failure = new Error(`读取本机数据集库失败，项目未导出：${errorMessage(error)}`) as Error & {
        cause?: unknown;
      };
      failure.cause = error;
      throw failure;
    }
  }
  const encoded = JSON.stringify(base, null, 2);
  const checked = validateProjectFile(encoded);
  if (checked.file === null) throw new Error(`生成的完整项目文件未通过自校验：${checked.error}`);
  return encoded;
}

/** 导出项目文件（原生保存对话框 / 浏览器下载）。projectName 用作默认文件名。 */
export async function exportProject(appVersion: string, projectName = '质检项目'): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '_').trim() || '质检项目';
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
  return writeProjectStores(validated.file, backup);
}

export function isProjectFile(name: string): boolean {
  return /\.qproj$/i.test(name);
}

/** 完整导入:stores 写回 localStorage;文件带 vault 且本端为桌面时,把库数据集恢复进 SQLite。
 * 返回 { error, note }:error 非空即失败;note 为补充提示(恢复个数 / Web 端跳过)。 */
export async function applyProjectText(text: string): Promise<{ error: string | null; note?: string }> {
  const validated = validateProjectFile(text);
  if (validated.file === null) return { error: validated.error };
  const vault = validateVault(validated.file.vault);
  if (vault.error) return { error: vault.error };

  const db = platform.datasetDb;
  const activeRef = validated.file.stores['qp-active-ref-v1'];
  if (activeRef !== undefined && !db) {
    return { error: `项目活动数据集「${activeRef}」仅存在于本机数据集库，当前环境无法完整导入` };
  }
  const prepareError = prepareProjectMutation();
  if (prepareError) return { error: prepareError };
  const settleError = await settleProjectMutation();
  if (settleError) return { error: settleError };
  const vaultBackup = new Map<string, string | null>();
  if (db) {
    // 在改写任何 store 之前先确认库可读，并保留所有将被覆盖的数据集。
    try {
      for (const [name] of vault.entries) vaultBackup.set(name, await db.get(name));
    } catch (error) {
      return { error: `读取本机数据集库失败，项目未导入：${errorMessage(error)}` };
    }
  }

  let storeBackup: ProjectStoreBackup;
  try {
    storeBackup = snapshotProjectStores();
  } catch {
    return { error: '读取当前本地存储失败，项目未导入' };
  }
  const storeError = writeProjectStores(validated.file, storeBackup);
  if (storeError) return { error: storeError };

  if (vault.entries.length === 0) {
    finishProjectMutation();
    return { error: null };
  }
  if (!db) {
    finishProjectMutation();
    return { error: null, note: `项目内含 ${vault.entries.length} 个库数据集,仅桌面版可恢复,本次已跳过` };
  }

  const attempted: string[] = [];
  try {
    for (const [name, json] of vault.entries) {
      // 先记录再写：即使底层在部分写入后抛错，也会尝试恢复当前条目。
      attempted.push(name);
      await db.put(name, json);
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
    return { error: `写入本机数据集库失败，项目未导入：${errorMessage(error)}；${rollback}` };
  }

  finishProjectMutation();
  return { error: null, note: `已恢复 ${vault.entries.length} 个数据集到本机数据集库` };
}
