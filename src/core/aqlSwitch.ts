/**
 * GB/T 2828.1-2012 / ISO 2859-1:1999 正常、加严、放宽检验及正式转移规则。
 *
 * 方案分别来自表 2-A / 2-B / 2-C；转移得分按 9.3.3.2 的一次抽样规则更新，
 * 加严检验累计 5 批不接收时按 9.4 暂停抽样检验。
 */
import {
  AQL_COLS, PER100_MAX_D_PER_UNIT, TABLE_BY_STATE, aqlPlanByState, codeLetterGB,
  normalPlanOneStepTighter, producerRiskPct, rqlForResult,
  resolveAqlRegime,
  type AqlMasterTable, type AqlRegime, type InspectionLevel, type InspectionState, type SamplingPlan,
} from './aql';

export type InspState = InspectionState;
export type BatchResult = 'A' | 'R';
export type LotDecision = 'accepted' | 'rejected';
export type NonconformingDisposition = 'none' | 'unrecorded' | 'pending' | 'reworked' | 'replaced' | 'scrapped' | 'concession';

export const AQL_TRACE_LIMITS = {
  batchId: 120,
  inspector: 80,
  inspectedAt: 64,
  note: 500,
  sequenceId: 120,
} as const;

/**
 * 单项目责任账本上限。达到上限时拒绝继续写入，要求先导出归档并新建项目；
 * 绝不为腾空间而静默删除旧批次追溯记录。
 */
export const MAX_AQL_RECORDS = 1000;

export interface AqlBatchRecord {
  /** 批次记录不带 kind(v1.43 之前的账本全部如此);仅状态转移记录为 'transition'。 */
  kind?: undefined;
  id: string;
  /** 生成该记录的检验体系序列；参数变更后旧记录只保留在总账中。 */
  sequenceId: string;
  batchId: string;
  inspector: string;
  inspectedAt: string;
  originalInspection: boolean;
  lot: number;
  level: InspectionLevel;
  aql: number;
  /** 质量表示方式必须随责任记录固化；旧记录缺失时按 v1.38 历史默认迁移。 */
  regime: AqlRegime;
  stateBefore: InspState;
  stateAfter: InspState;
  sourceTable: AqlMasterTable;
  initialCode: string;
  finalCode: string;
  sampleSize: number;
  acceptanceNumber: number;
  rejectionNumber: number;
  fullInspection: boolean;
  nonconforming: number;
  nonconformingDisposition: NonconformingDisposition;
  result: BatchResult;
  decision: LotDecision;
  switchingScoreAfter: number;
  note: string;
}

/**
 * 人工管理条件引起的正式检验状态转移(S-2):
 * · conditions-met:正常 → 放宽(得分≥30 且「生产稳定」「负责部门同意」同时勾选);
 * · conditions-withdrawn:放宽 → 正常(任一管理条件被取消);
 * · restore-normal:放宽 → 正常(负责部门因其他条件决定恢复);
 * · resume-tightened:加严检验暂停 → 以加严检验重新开始(第 9.4 条,供方纠正且负责部门确认有效;
 *   前后状态都是加严,记录的是「解除暂停」这一人工决定)。
 * 批次登记引起的转移已由批次记录的 stateBefore/stateAfter 留痕,不重复写转移记录。
 */
export type AqlTransitionAction = 'conditions-met' | 'conditions-withdrawn' | 'restore-normal' | 'resume-tightened';

interface AqlTransitionFields {
  kind: 'transition';
  id: string;
  sequenceId: string;
  action: AqlTransitionAction;
  /** 操作人(沿用 AQL 页「检验人」字段)。 */
  inspector: string;
  /** 操作时间。 */
  inspectedAt: string;
  stateBefore: InspState;
  stateAfter: InspState;
  switchingScoreBefore: number;
  switchingScoreAfter: number;
  /** 转移发生后的管理条件快照。 */
  productionSteady: boolean;
  reducedApproved: boolean;
  note: string;
}

type BatchOnlyKey = Exclude<keyof AqlBatchRecord, keyof AqlTransitionFields>;
/**
 * 状态转移账本记录。批次专属字段在运行时恒不存在(normalizeAqlTransitionRecord 按白名单
 * 拒绝);类型上声明为可选,只为让按批次记录展开/改写 records[i] 的既有调用方仍可编译,
 * 读取方一律先按 kind(isAqlBatchRecord / isAqlTransitionRecord)区分。
 */
export type AqlTransitionRecord = AqlTransitionFields & { [K in BatchOnlyKey]?: AqlBatchRecord[K] };
/** 责任账本条目:批次检验记录或人工状态转移记录,按发生顺序共用同一账本与 1000 条上限。 */
export type AqlLedgerRecord = AqlBatchRecord | AqlTransitionRecord;

export function isAqlTransitionRecord(record: AqlLedgerRecord): record is AqlTransitionRecord {
  return record.kind === 'transition';
}

export function isAqlBatchRecord(record: AqlLedgerRecord): record is AqlBatchRecord {
  return record.kind !== 'transition';
}

const TRANSITION_ACTION_LABEL: Record<AqlTransitionAction, string> = {
  'conditions-met': '管理条件齐备 → 转放宽检验',
  'conditions-withdrawn': '管理条件取消 → 恢复正常检验',
  'restore-normal': '因其他条件恢复正常检验',
  'resume-tightened': '纠正措施确认有效 → 解除暂停，恢复加严检验',
};

/** 转移动作的中文说明(AQL 页与专项报告共用)。 */
export function aqlTransitionActionLabel(action: AqlTransitionAction): string {
  return TRANSITION_ACTION_LABEL[action];
}

/** 转移后管理条件快照的中文说明。 */
export function aqlTransitionConditionText(record: Pick<AqlTransitionRecord, 'productionSteady' | 'reducedApproved'>): string {
  return `生产稳定=${record.productionSteady ? '是' : '否'}，负责部门同意=${record.reducedApproved ? '是' : '否'}`;
}

/** 人工状态转移时的操作人与时间;UI 以「检验人」字段作为操作人。 */
export interface AqlTransitionMeta {
  operator?: string;
  at?: string;
}

export interface SwitchStatus {
  /** 当前检验体系序列，避免旧参数记录冒充当前序列最新批。 */
  sequenceId: string;
  state: InspState;
  history: BatchResult[]; // 当前检验体系内的初次检验批显示时间线
  sinceSwitch: BatchResult[];
  note: string;
  switchingScore: number;
  tightenedRejections: number;
  productionSteady: boolean;
  reducedApproved: boolean;
  suspended: boolean;
  records: AqlLedgerRecord[]; // 含初次检验、复验批与人工状态转移的可追溯记录(按发生顺序)
}

export const SWITCH_INIT: SwitchStatus = {
  sequenceId: 'sequence-initial',
  state: 'normal',
  history: [],
  sinceSwitch: [],
  note: '初始为正常检验；转移得分从 0 开始',
  switchingScore: 0,
  tightenedRejections: 0,
  productionSteady: false,
  reducedApproved: false,
  suspended: false,
  records: [],
};

const INSPECTION_LEVELS = new Set<InspectionLevel>(['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III']);
const INSPECTION_STATES = new Set<InspState>(['normal', 'tightened', 'reduced']);
// S 只在加严表 2-B 的 0.025 列出现(aql.ts 表数据实际含 S/3150);白名单缺 S 会让这类批次记录被静默丢弃
const SAMPLE_CODES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S']);
const DISPOSITIONS = new Set<NonconformingDisposition>(['none', 'unrecorded', 'pending', 'reworked', 'replaced', 'scrapped', 'concession']);
const MAX_STATUS_HISTORY = 200;

const results = (value: unknown): BatchResult[] => Array.isArray(value)
  ? value.filter((x): x is BatchResult => x === 'A' || x === 'R')
  : [];

/** 单条账本记录允许的状态变化；依赖更早批次的窗口条件由状态账本承担。 */
function recordTransitionIsPossible(record: AqlBatchRecord): boolean {
  const { stateBefore, stateAfter, decision, originalInspection, switchingScoreAfter } = record;
  if (!originalInspection) {
    if (stateAfter !== stateBefore) return false;
    if (stateBefore === 'tightened') return switchingScoreAfter === 0;
    if (stateBefore === 'reduced') return switchingScoreAfter >= 30;
    return true;
  }
  if (stateBefore === 'normal') {
    if (decision === 'rejected') {
      return stateAfter !== 'reduced' && switchingScoreAfter === 0;
    }
    if (stateAfter === 'tightened') return switchingScoreAfter === 0;
    if (stateAfter === 'reduced') return switchingScoreAfter >= 30;
    return true;
  }
  if (stateBefore === 'tightened') {
    return stateAfter !== 'reduced'
      && switchingScoreAfter === 0
      && (stateAfter !== 'normal' || decision === 'accepted');
  }
  // 放宽检验：接收批继续放宽；不接收批必须恢复正常且得分清零。
  return decision === 'accepted'
    ? stateAfter === 'reduced' && switchingScoreAfter >= 30
    : stateAfter === 'normal' && switchingScoreAfter === 0;
}

/**
 * 外来项目/localStorage 的责任记录必须先通过完整字段与交叉字段校验。注意这只保证单条记录自洽；
 * 记录链与状态字段的一致性由 auditAqlLedger 重放核对。二者都只是「可追溯」而非「防篡改」：
 * 账本没有签名/完整性锚，取证级要求须另行对导出文件做签名归档。
 */
function normalizeAqlBatchRecord(value: unknown, fallbackSequenceId: string): AqlBatchRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = value as Partial<AqlBatchRecord>;
  // 批次记录从不带 kind;未知类型不得被当作批次记录放行。
  if ((value as { kind?: unknown }).kind !== undefined) return null;
  const decisionOk = x.decision === 'accepted' || x.decision === 'rejected';
  const resultOk = x.result === 'A' || x.result === 'R';
  const stateOk = INSPECTION_STATES.has(x.stateBefore as InspState)
    && INSPECTION_STATES.has(x.stateAfter as InspState);
  // d 的上限按记录中固化的质量表示分流：percent 为 d≤n；per100 为计点制，d 可大于 n。
  const aqlOk = typeof x.aql === 'number' && AQL_COLS.includes(x.aql);
  let regime: AqlRegime;
  try {
    regime = resolveAqlRegime(x.aql as number, x.regime);
  } catch {
    return null;
  }
  const dMax = aqlOk && Number.isSafeInteger(x.sampleSize)
    ? (regime === 'per100' ? x.sampleSize! * PER100_MAX_D_PER_UNIT : x.sampleSize!)
    : 0;
  const integerOk = Number.isSafeInteger(x.lot) && x.lot! >= 2
    && Number.isSafeInteger(x.sampleSize) && x.sampleSize! >= 1 && x.sampleSize! <= x.lot!
    && Number.isSafeInteger(x.acceptanceNumber) && x.acceptanceNumber! >= 0
    && Number.isSafeInteger(x.rejectionNumber) && x.rejectionNumber === x.acceptanceNumber! + 1
    && Number.isSafeInteger(x.nonconforming) && x.nonconforming! >= 0 && x.nonconforming! <= dMax
    && Number.isSafeInteger(x.switchingScoreAfter) && x.switchingScoreAfter! >= 0;
  if (!decisionOk || !resultOk || !stateOk || !integerOk || !aqlOk) return null;
  if (typeof x.id !== 'string' || !x.id.trim()
    || x.id.length > AQL_TRACE_LIMITS.inspectedAt + AQL_TRACE_LIMITS.batchId
    || typeof x.batchId !== 'string' || !x.batchId.trim() || x.batchId.length > AQL_TRACE_LIMITS.batchId
    || typeof x.inspector !== 'string' || !x.inspector.trim() || x.inspector.length > AQL_TRACE_LIMITS.inspector
    || typeof x.inspectedAt !== 'string' || !x.inspectedAt.trim() || x.inspectedAt.length > AQL_TRACE_LIMITS.inspectedAt
    || typeof x.note !== 'string' || x.note.length > AQL_TRACE_LIMITS.note
    || typeof x.originalInspection !== 'boolean'
    || typeof x.fullInspection !== 'boolean'
    || !INSPECTION_LEVELS.has(x.level as InspectionLevel)
    || !AQL_COLS.includes(x.aql as number)
    || !SAMPLE_CODES.has(x.initialCode ?? '')
    || !SAMPLE_CODES.has(x.finalCode ?? '')
    || x.sourceTable !== TABLE_BY_STATE[x.stateBefore as InspState]
    || (x.fullInspection && x.sampleSize !== x.lot)
    || (x.result === 'A') !== (x.decision === 'accepted')
    || (x.decision === 'accepted' && x.nonconforming! > x.acceptanceNumber!)
    || (x.decision === 'rejected' && x.nonconforming! < x.rejectionNumber!)) return null;
  if (x.sequenceId !== undefined && (typeof x.sequenceId !== 'string'
    || !x.sequenceId.trim() || x.sequenceId.trim().length > AQL_TRACE_LIMITS.sequenceId)) return null;
  const sequenceId = typeof x.sequenceId === 'string' && x.sequenceId.trim()
    && x.sequenceId.trim().length <= AQL_TRACE_LIMITS.sequenceId
    ? x.sequenceId.trim()
    : fallbackSequenceId;
  const nonconformingDisposition: NonconformingDisposition = DISPOSITIONS.has(x.nonconformingDisposition as NonconformingDisposition)
    ? x.nonconformingDisposition as NonconformingDisposition
    : x.nonconforming === 0 ? 'none' : 'unrecorded';
  if ((x.nonconforming === 0) !== (nonconformingDisposition === 'none')) return null;
  let expectedPlan: SamplingPlan;
  try {
    expectedPlan = aqlPlanByState(
      x.lot!, x.level as InspectionLevel, x.aql!, x.stateBefore as InspState,
    );
  } catch {
    return null;
  }
  const expectedDecision: LotDecision = x.nonconforming! <= expectedPlan.ac ? 'accepted' : 'rejected';
  if (x.initialCode !== codeLetterGB(x.lot!, x.level as InspectionLevel)
    || x.finalCode !== expectedPlan.code
    || x.sampleSize !== expectedPlan.n
    || x.acceptanceNumber !== expectedPlan.ac
    || x.rejectionNumber !== expectedPlan.re
    || x.fullInspection !== (expectedPlan.fullInspect === true)
    || x.decision !== expectedDecision
    || x.result !== (expectedDecision === 'accepted' ? 'A' : 'R')
    || (x.fullInspection && x.nonconforming! > 0
      && (nonconformingDisposition === 'none' || nonconformingDisposition === 'unrecorded'))) return null;
  const record = { ...(x as AqlBatchRecord), sequenceId, regime, nonconformingDisposition };
  return recordTransitionIsPossible(record) ? record : null;
}

const TRANSITION_KEYS: ReadonlySet<string> = new Set<keyof AqlTransitionFields>([
  'kind', 'id', 'sequenceId', 'action', 'inspector', 'inspectedAt', 'stateBefore', 'stateAfter',
  'switchingScoreBefore', 'switchingScoreAfter', 'productionSteady', 'reducedApproved', 'note',
]);

/** 单条转移记录的前后状态、得分与条件快照必须符合对应动作的正式规则。 */
function transitionIsPossible(x: AqlTransitionFields): boolean {
  const bothMet = x.productionSteady && x.reducedApproved;
  switch (x.action) {
    case 'conditions-met':
      return x.stateBefore === 'normal' && x.stateAfter === 'reduced' && bothMet
        && x.switchingScoreBefore >= 30 && x.switchingScoreAfter === x.switchingScoreBefore;
    case 'conditions-withdrawn':
      return x.stateBefore === 'reduced' && x.stateAfter === 'normal' && !bothMet
        && x.switchingScoreBefore >= 30 && x.switchingScoreAfter === 0;
    case 'restore-normal':
      return x.stateBefore === 'reduced' && x.stateAfter === 'normal' && bothMet
        && x.switchingScoreBefore >= 30 && x.switchingScoreAfter === 0;
    case 'resume-tightened':
      // 暂停只发生在加严检验中,加严期间转移得分恒为 0;解除暂停后仍是加严检验。
      return x.stateBefore === 'tightened' && x.stateAfter === 'tightened'
        && x.switchingScoreBefore === 0 && x.switchingScoreAfter === 0;
    default:
      return false;
  }
}

/** 状态转移记录是 v1.43 新增类型:字段白名单 + 交叉校验,任何篡改/缺失都整条拒绝。 */
function normalizeAqlTransitionRecord(value: unknown): AqlTransitionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !TRANSITION_KEYS.has(key))) return null;
  const x = value as Partial<AqlTransitionFields>;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (x.kind !== 'transition'
    || !text(x.id, AQL_TRACE_LIMITS.inspectedAt + AQL_TRACE_LIMITS.batchId)
    || !text(x.sequenceId, AQL_TRACE_LIMITS.sequenceId) || x.sequenceId !== x.sequenceId.trim()
    || (x.action !== 'conditions-met' && x.action !== 'conditions-withdrawn' && x.action !== 'restore-normal'
      && x.action !== 'resume-tightened')
    || !text(x.inspector, AQL_TRACE_LIMITS.inspector)
    || !text(x.inspectedAt, AQL_TRACE_LIMITS.inspectedAt)
    || typeof x.note !== 'string' || x.note.length > AQL_TRACE_LIMITS.note
    || !INSPECTION_STATES.has(x.stateBefore as InspState) || !INSPECTION_STATES.has(x.stateAfter as InspState)
    || !Number.isSafeInteger(x.switchingScoreBefore) || x.switchingScoreBefore! < 0
    || !Number.isSafeInteger(x.switchingScoreAfter) || x.switchingScoreAfter! < 0
    || typeof x.productionSteady !== 'boolean' || typeof x.reducedApproved !== 'boolean') return null;
  const record: AqlTransitionFields = {
    kind: 'transition',
    id: x.id,
    sequenceId: x.sequenceId,
    action: x.action,
    inspector: x.inspector,
    inspectedAt: x.inspectedAt,
    stateBefore: x.stateBefore!,
    stateAfter: x.stateAfter!,
    switchingScoreBefore: x.switchingScoreBefore!,
    switchingScoreAfter: x.switchingScoreAfter!,
    productionSteady: x.productionSteady,
    reducedApproved: x.reducedApproved,
    note: x.note,
  };
  return transitionIsPossible(record) ? record : null;
}

function normalizeAqlLedgerRecord(value: unknown, fallbackSequenceId: string): AqlLedgerRecord | null {
  if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'transition') {
    return normalizeAqlTransitionRecord(value);
  }
  return normalizeAqlBatchRecord(value, fallbackSequenceId);
}

/**
 * v1.34 之前的状态载荷没有检验序列号，归一化时统一迁入该序列。v1.32/v1.33 在改变检验水平/AQL
 * 时只重置状态而不分序列，所以该序列内的记录链可能跨越多次不留痕的重置(见 auditAqlLedger)。
 */
export const AQL_LEGACY_SEQUENCE_ID = 'sequence-legacy-v2';

/** 兼容旧项目/旧 localStorage 中只有 state/history/sinceSwitch/note 的记录。 */
export function normalizeSwitchStatus(value?: Partial<SwitchStatus> | null): SwitchStatus {
  const sequenceId = typeof value?.sequenceId === 'string' && value.sequenceId.trim()
    && value.sequenceId.trim().length <= AQL_TRACE_LIMITS.sequenceId
    ? value.sequenceId.trim()
    : AQL_LEGACY_SEQUENCE_ID;
  const requestedState: InspState = value?.state === 'tightened' || value?.state === 'reduced' ? value.state : 'normal';
  const records = Array.isArray(value?.records)
    ? value.records
      .map((record) => normalizeAqlLedgerRecord(record, sequenceId))
      .filter((record): record is AqlLedgerRecord => record !== null)
    : [];
  const switchingScore = Number.isFinite(value?.switchingScore)
    ? Math.max(0, Math.trunc(value!.switchingScore!))
    : 0;
  const rawTightenedRejections = Number.isFinite(value?.tightenedRejections)
    ? Math.max(0, Math.trunc(value!.tightenedRejections!))
    : 0;
  const productionSteady = value?.productionSteady === true;
  const reducedApproved = value?.reducedApproved === true;
  const requestedSuspension = value?.suspended === true;
  // §9.4 的累计门槛是强制暂停条件，不能让矛盾的 suspended=false 载荷绕过一批。
  const thresholdSuspension = rawTightenedRejections >= 5;
  const mustSuspend = requestedSuspension || thresholdSuspension;
  // 安全优先：损坏载荷中的 suspended=true 不能因 state 字段不一致而被静默洗掉。
  const invalidReduced = requestedState === 'reduced'
    && !(switchingScore >= 30 && productionSteady && reducedApproved);
  const state: InspState = mustSuspend ? 'tightened' : invalidReduced ? 'normal' : requestedState;
  const suspended = mustSuspend;
  const tightenedRejections = state === 'tightened'
    ? suspended ? Math.max(5, rawTightenedRejections) : rawTightenedRejections
    : 0;
  const normalizedScore = invalidReduced || state === 'tightened' ? 0 : switchingScore;
  const originalNote = typeof value?.note === 'string'
    ? value.note.slice(0, AQL_TRACE_LIMITS.note)
    : SWITCH_INIT.note;
  const note = mustSuspend && (!requestedSuspension || requestedState !== 'tightened')
    ? '检测到加严累计或暂停字段不一致；已按安全原则恢复为加严检验暂停态'
    : invalidReduced
      ? '放宽检验准入条件不完整；已按安全原则恢复正常检验'
      : originalNote;
  return {
    sequenceId,
    state,
    history: results(value?.history).slice(-MAX_STATUS_HISTORY),
    sinceSwitch: results(value?.sinceSwitch).slice(-5),
    note,
    switchingScore: normalizedScore,
    tightenedRejections,
    productionSteady,
    reducedApproved,
    suspended,
    records,
  };
}

export function freshSwitchStatus(): SwitchStatus {
  return normalizeSwitchStatus(SWITCH_INIT);
}

/** 三种状态均只走正式表，不接受二项或位移近似参数。 */
export function plansByState(
  lot: number, level: InspectionLevel, aql: number,
): Record<InspState, SamplingPlan> {
  return {
    normal: aqlPlanByState(lot, level, aql, 'normal'),
    tightened: aqlPlanByState(lot, level, aql, 'tightened'),
    reduced: aqlPlanByState(lot, level, aql, 'reduced'),
  };
}

/** per100 体系录入 d 的工程上限:d ≤ n × PER100_MAX_D_PER_UNIT(计点体系 d 可大于 n)。 */
export function maxNonconforming(plan: SamplingPlan, regime: AqlRegime): number {
  return regime === 'per100' ? plan.n * PER100_MAX_D_PER_UNIT : plan.n;
}

/**
 * 批判定。K2 起按体系分流录入上限:
 * · percent(AQL≤10,不合格品数):d 是样本中的不合格品件数,必然 ≤ n;
 * · per100(AQL≥15,每百单位不合格数):d 是样本中的不合格(缺陷)总数,一件产品可有
 *   多个不合格,故 d 允许大于 n,只设远超实际的工程上限(见 PER100_MAX_D_PER_UNIT)。
 */
export function decideLot(plan: SamplingPlan, nonconforming: number, regime: AqlRegime = 'percent'): LotDecision {
  const dMax = maxNonconforming(plan, regime);
  if (!Number.isSafeInteger(nonconforming) || nonconforming < 0 || nonconforming > dMax) {
    throw new RangeError(regime === 'per100'
      ? `不合格数必须是 0–${dMax} 的整数(每百单位体系允许大于样本量 ${plan.n})`
      : `不合格数必须是 0–${plan.n} 的整数`);
  }
  return nonconforming <= plan.ac ? 'accepted' : 'rejected';
}

export interface RecordInspectionInput {
  lot: number;
  level: InspectionLevel;
  aql: number;
  /** 新调用方必须显式传入；缺失仅用于旧 API/测试兼容并按历史默认解析。 */
  regime?: AqlRegime;
  nonconforming: number;
  batchId?: string;
  inspector?: string;
  inspectedAt?: string;
  /** 复验批仍留痕，但 GB/T 2828.1 9.3 的转移规则只统计初次检验。 */
  originalInspection?: boolean;
  /** 100% 全检发现不合格品时必须明确其隔离/返工/替换/报废/让步处置。 */
  nonconformingDisposition?: Exclude<NonconformingDisposition, 'none' | 'unrecorded'>;
}

type TighterAqlAssessment = 'accepted' | 'rejected' | 'not-comparable';

/**
 * 严一档评估(9.3.3.2 转移得分)。跨体系口径(K2):AQL=15 的严一档是 10,
 * 恰好跨过 per100/percent 边界。此处只做“本批计数 d 与严一档 Ac 的数值比较”,
 * 且要求严一档样本量与本批相同才可比;d 在两体系下都是同一份样本的计数
 * (percent=不合格品件数、per100=不合格总数),机械比较成立,语义差异见帮助。
 */
function acceptedAtOneStepTighter(
  initialCode: string, aql: number, executedSampleSize: number, nonconforming: number,
): { assessment: TighterAqlAssessment; plan: SamplingPlan } {
  const plan = normalPlanOneStepTighter(initialCode, aql);
  if (!plan) throw new RangeError(`无法取得 AQL ${aql} 的严一档正常检验方案`);
  if (plan.n !== executedSampleSize) return { assessment: 'not-comparable', plan };
  return { assessment: nonconforming <= plan.ac ? 'accepted' : 'rejected', plan };
}

function trailingAcceptedCount(history: BatchResult[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === 'A'; i--) count += 1;
  return count;
}

/** 账本满时 fail-closed:拒绝一切新写入(批次与状态转移),绝不为腾空间静默删除旧记录。 */
function assertLedgerHasRoom(s: SwitchStatus): void {
  if (s.records.length >= MAX_AQL_RECORDS) {
    throw new RangeError(`本项目 AQL 责任账本已达到 ${MAX_AQL_RECORDS} 条上限；请先导出项目/专项报告完成归档，再新建项目继续记录。旧记录不会被自动删除`);
  }
}

export function recordInspection(status: SwitchStatus, input: RecordInspectionInput): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (s.suspended) throw new Error('抽样检验已暂停；须确认纠正措施有效后恢复加严检验');
  assertLedgerHasRoom(s);
  if (!Number.isSafeInteger(input.lot) || input.lot < 2) throw new RangeError('批量必须是大于等于 2 的安全整数');
  if (!AQL_COLS.includes(input.aql)) throw new RangeError(`仅支持正式主表 AQL：${AQL_COLS.join('、')}`);
  const regime = resolveAqlRegime(input.aql, input.regime);

  const originalInspection = input.originalInspection !== false;
  const stateBefore = s.state;
  const plan = plansByState(input.lot, input.level, input.aql)[stateBefore];
  // K2:per100 体系(AQL≥15)允许 d > n,decideLot 按体系分流录入上限。
  const decision = decideLot(plan, input.nonconforming, regime);
  const requestedDisposition = input.nonconformingDisposition as NonconformingDisposition | undefined;
  if (plan.fullInspect && input.nonconforming > 0
    && (!requestedDisposition || requestedDisposition === 'none' || requestedDisposition === 'unrecorded'
      || !DISPOSITIONS.has(requestedDisposition))) {
    throw new Error('100% 全检发现不合格品时，必须记录隔离或后续处置状态');
  }
  const nonconformingDisposition: NonconformingDisposition = input.nonconforming === 0
    ? 'none'
    : input.nonconformingDisposition ?? 'unrecorded';
  const result: BatchResult = decision === 'accepted' ? 'A' : 'R';
  const history = originalInspection ? [...s.history, result] : [...s.history];
  const since = originalInspection ? [...s.sinceSwitch, result] : [...s.sinceSwitch];

  let state = stateBefore;
  let sinceSwitch = since;
  let switchingScore = s.switchingScore;
  let tightenedRejections = s.tightenedRejections;
  let suspended = false;
  let note: string;

  if (!originalInspection) {
    note = `复验批${decision === 'accepted' ? '接收' : '不接收'}；按 9.3 不计入转移规则`;
  } else if (stateBefore === 'normal') {
    if (decision === 'rejected') {
      switchingScore = 0;
      note = '本批不接收，正常检验转移得分清零';
    } else if (plan.ac >= 2) {
      const tighter = acceptedAtOneStepTighter(
        codeLetterGB(input.lot, input.level), input.aql, plan.n, input.nonconforming,
      );
      if (tighter.assessment === 'accepted') {
        switchingScore += 3;
        note = `本批在严一档 AQL 下仍可接收，转移得分 +3 = ${switchingScore}`;
      } else if (tighter.assessment === 'rejected') {
        switchingScore = 0;
        note = '本批按当前 AQL 接收，但严一档 AQL 下不能接收，转移得分清零';
      } else {
        switchingScore = 0;
        note = `严一档 AQL 所需样本量 n=${tighter.plan.n}，与本批样本量 n=${plan.n} 不同，不能用本批不合格数证明仍可接收；按保守原则转移得分清零`;
      }
    } else {
      switchingScore += 2;
      note = `Ac=${plan.ac} 且本批接收，转移得分 +2 = ${switchingScore}`;
    }

    if (since.slice(-5).filter((x) => x === 'R').length >= 2) {
      state = 'tightened';
      switchingScore = 0;
      tightenedRejections = 0;
      sinceSwitch = [];
      note = '连续 5 批或少于 5 批中有 2 批不接收 → 转加严检验（表 2-B）';
    } else if (switchingScore >= 30 && s.productionSteady && s.reducedApproved) {
      state = 'reduced';
      sinceSwitch = [];
      note = '转移得分 ≥30、生产稳定且负责部门同意 → 转放宽检验（表 2-C）';
    }
  } else if (stateBefore === 'tightened') {
    if (decision === 'rejected') tightenedRejections += 1;
    if (since.slice(-5).length === 5 && since.slice(-5).every((x) => x === 'A')) {
      state = 'normal';
      switchingScore = 0;
      tightenedRejections = 0;
      sinceSwitch = [];
      note = '加严检验连续 5 批接收 → 恢复正常检验（表 2-A）';
    } else if (tightenedRejections >= 5) {
      suspended = true;
      note = '加严检验累计 5 批不接收 → 暂停抽样检验，等待供方纠正及负责部门确认';
    } else {
      note = decision === 'accepted'
        ? `加严检验本批接收；连续接收 ${trailingAcceptedCount(since)} 批`
        : `加严检验本批不接收；当前累计 ${tightenedRejections}/5 批`;
    }
  } else {
    if (decision === 'rejected') {
      state = 'normal';
      switchingScore = 0;
      sinceSwitch = [];
      note = '放宽检验出现不接收批 → 恢复正常检验（表 2-A）';
    } else {
      note = '放宽检验本批接收，继续放宽检验';
    }
  }

  const inspectedAt = input.inspectedAt?.trim() || new Date().toISOString();
  const batchId = input.batchId?.trim() || `批次-${String(s.records.filter(isAqlBatchRecord).length + 1).padStart(4, '0')}`;
  const inspector = input.inspector?.trim() || '未填写';
  if (batchId.length > AQL_TRACE_LIMITS.batchId) throw new RangeError(`批次号不能超过 ${AQL_TRACE_LIMITS.batchId} 个字符`);
  if (inspector.length > AQL_TRACE_LIMITS.inspector) throw new RangeError(`检验人不能超过 ${AQL_TRACE_LIMITS.inspector} 个字符`);
  if (inspectedAt.length > AQL_TRACE_LIMITS.inspectedAt) throw new RangeError('检验时间字段过长');
  const record: AqlBatchRecord = {
    id: `${inspectedAt}-${s.records.length + 1}`,
    sequenceId: s.sequenceId,
    batchId,
    inspector,
    inspectedAt,
    originalInspection,
    lot: input.lot,
    level: input.level,
    aql: input.aql,
    regime,
    stateBefore,
    stateAfter: state,
    sourceTable: TABLE_BY_STATE[stateBefore],
    initialCode: codeLetterGB(input.lot, input.level),
    finalCode: plan.code,
    sampleSize: plan.n,
    acceptanceNumber: plan.ac,
    rejectionNumber: plan.re,
    fullInspection: plan.fullInspect === true,
    nonconforming: input.nonconforming,
    nonconformingDisposition,
    result,
    decision,
    switchingScoreAfter: switchingScore,
    note,
  };

  return {
    ...s,
    state,
    history: history.slice(-MAX_STATUS_HISTORY),
    sinceSwitch: sinceSwitch.slice(-5),
    note,
    switchingScore,
    tightenedRejections,
    suspended,
    records: [...s.records, record],
  };
}

/**
 * 勾选/取消管理条件后会发生的正式状态转移(唯一评估器:AQL 页的「进入放宽」确认与
 * setSwitchConditions 共用,避免 UI 预判与实际写账本两套口径)。
 */
export function switchConditionsTransition(
  status: SwitchStatus,
  patch: Partial<Pick<SwitchStatus, 'productionSteady' | 'reducedApproved'>>,
): 'conditions-met' | 'conditions-withdrawn' | null {
  const s = normalizeSwitchStatus(status);
  const productionSteady = patch.productionSteady ?? s.productionSteady;
  const reducedApproved = patch.reducedApproved ?? s.reducedApproved;
  if (s.state === 'reduced' && (!productionSteady || !reducedApproved)) return 'conditions-withdrawn';
  if (s.state === 'normal' && s.switchingScore >= 30 && productionSteady && reducedApproved) return 'conditions-met';
  return null;
}

function transitionRecord(
  s: SwitchStatus,
  next: Pick<SwitchStatus, 'state' | 'switchingScore' | 'productionSteady' | 'reducedApproved' | 'note'>,
  action: AqlTransitionAction,
  meta: AqlTransitionMeta | undefined,
): AqlTransitionRecord {
  const inspectedAt = meta?.at?.trim() || new Date().toISOString();
  const inspector = meta?.operator?.trim() || '未填写';
  if (inspector.length > AQL_TRACE_LIMITS.inspector) throw new RangeError(`操作人不能超过 ${AQL_TRACE_LIMITS.inspector} 个字符`);
  if (inspectedAt.length > AQL_TRACE_LIMITS.inspectedAt) throw new RangeError('操作时间字段过长');
  return {
    kind: 'transition',
    id: `${inspectedAt}-T${s.records.length + 1}`,
    sequenceId: s.sequenceId,
    action,
    inspector,
    inspectedAt,
    stateBefore: s.state,
    stateAfter: next.state,
    switchingScoreBefore: s.switchingScore,
    switchingScoreAfter: next.switchingScore,
    productionSteady: next.productionSteady,
    reducedApproved: next.reducedApproved,
    note: next.note.slice(0, AQL_TRACE_LIMITS.note),
  };
}

/**
 * 设置正常→放宽所需两个管理条件；条件补齐时立即按当前得分判定是否转放宽。
 * 发生正式状态转移时向责任账本追加一条 kind:'transition' 记录(账本满则 fail-closed 拒绝)。
 */
export function setSwitchConditions(
  status: SwitchStatus,
  patch: Partial<Pick<SwitchStatus, 'productionSteady' | 'reducedApproved'>>,
  meta?: AqlTransitionMeta,
): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  const next = { ...s, ...patch };
  const action = switchConditionsTransition(s, patch);
  if (action === 'conditions-withdrawn') {
    assertLedgerHasRoom(s);
    const moved = {
      ...next, state: 'normal' as const, switchingScore: 0, sinceSwitch: [],
      note: '生产稳定/负责部门同意条件不再满足 → 恢复正常检验',
    };
    return { ...moved, records: [...s.records, transitionRecord(s, moved, action, meta)] };
  }
  if (action === 'conditions-met') {
    assertLedgerHasRoom(s);
    const moved = {
      ...next, state: 'reduced' as const, sinceSwitch: [],
      note: '转移得分 ≥30、生产稳定且负责部门同意 → 转放宽检验（表 2-C）',
    };
    return { ...moved, records: [...s.records, transitionRecord(s, moved, action, meta)] };
  }
  return next;
}

/** 放宽检验中因“其他条件”由负责人决定恢复正常检验；转移同样写入责任账本。 */
export function restoreNormalInspection(
  status: SwitchStatus,
  reason = '其他条件要求恢复正常检验',
  meta?: AqlTransitionMeta,
): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (s.suspended) throw new Error('暂停检验只能在确认纠正措施有效后恢复加严检验');
  if (s.state !== 'reduced') throw new Error('只有放宽检验可因其他条件恢复正常检验');
  assertLedgerHasRoom(s);
  const moved = {
    ...s,
    state: 'normal' as const,
    switchingScore: 0,
    tightenedRejections: 0,
    suspended: false,
    sinceSwitch: [],
    note: reason.slice(0, AQL_TRACE_LIMITS.note),
  };
  return { ...moved, records: [...s.records, transitionRecord(s, moved, 'restore-normal', meta)] };
}

/**
 * 9.4：供方完成纠正且负责部门确认有效后，以加严检验重新开始。解除暂停是人工责任决定，
 * 与其他人工转移一样向责任账本追加一条 kind:'transition'(action='resume-tightened')记录
 * (账本满则 fail-closed 拒绝，不裁剪旧记录)。未暂停时原样返回，不写记录。
 */
export function resumeTightenedInspection(status: SwitchStatus, meta?: AqlTransitionMeta): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (!s.suspended) return s;
  assertLedgerHasRoom(s);
  const moved = {
    ...s,
    state: 'tightened' as const,
    suspended: false,
    tightenedRejections: 0,
    sinceSwitch: [],
    note: '纠正措施已确认有效 → 恢复加严检验（表 2-B）',
  };
  return { ...moved, records: [...s.records, transitionRecord(s, moved, 'resume-tightened', meta)] };
}

/* ------------------------------------------------------------------------------------------
 * CORE-06:责任账本记录链 ↔ 状态级字段的交叉核对(重放审计)
 *
 * 单条记录的自洽校验(normalizeAqlBatchRecord / normalizeAqlTransitionRecord)挡不住「记录原样
 * 保留、只改 state/switchingScore/tightenedRejections/sinceSwitch」或「删掉中间拒收记录」这类
 * 篡改。本审计从当前检验序列的初始态出发，用与录入完全相同的生产函数(recordInspection /
 * setSwitchConditions / restoreNormalInspection / resumeTightenedInspection)逐条重放记录链，
 * 要求每条记录的检验后状态/转移得分与重放一致，且顶层状态字段等于重放终态。
 *
 * 边界：这是「可追溯记录与摘要字段一致」的核对，不是防篡改签名——账本本身没有完整性锚，
 * 整条伪造但自洽的记录链无法被识别；取证级要求需另行对导出的账本做签名/哈希归档。
 *
 * 旧账本兼容策略(明确、只放宽到 UI 本来就允许的范围)：
 * · v1.43 之前人工转移(管理条件齐备转放宽 / 条件取消或其他条件恢复正常)从不写转移记录。账本中
 *   第一条 kind:'transition' 记录之前(全账本没有转移记录时也包括终态)，按正式规则推定这类人工
 *   转移：正常→放宽须重放得分 ≥30；放宽→正常得分清零。结果标记为 legacy「历史账本未含转移
 *   记录」。出现第一条转移记录之后，任何未留痕的人工转移都按不一致拒绝。
 * · 暂停后「确认纠正措施有效 → 恢复加严」:本版起写 resume-tightened 转移记录并按记录重放；
 *   更早的账本从不写这条记录，重放时仍按正式规则推定(仍是加严，任何账本都允许)。
 * · v1.34 之前建立的 legacy 序列(AQL_LEGACY_SEQUENCE_ID)：初始计数未知，且 v1.32/33 改检验水平/
 *   AQL(哪怕随后改回)会在任何状态下不留痕地重置为初始正常检验，因此从第一个可确定的状态转移点
 *   (换表记录/转移记录)起严格重放、之前只做状态连续与逐对得分核对，并在第一条转移记录之前按
 *   「重置为初始正常检验」推定无法解释的断点——此类推定逐处计数写入 notes 供审核方复核。
 *   没有任何记录的 legacy 状态只拒绝「凭空的正常检验转移得分」。
 * ---------------------------------------------------------------------------------------- */

export type AqlLedgerAuditStatus = 'verified' | 'legacy' | 'mismatch';

export interface AqlLedgerAudit {
  /** verified=记录链完整重放一致；legacy=按旧账本兼容规则接受(见 notes)；mismatch=不一致，须按损坏拒绝。 */
  status: AqlLedgerAuditStatus;
  /** mismatch 时第一处不一致的中文说明；其余为空串。 */
  detail: string;
  /** legacy 时的兼容标记(供专项报告/页面提示)。 */
  notes: string[];
}

const STATE_LABEL: Record<InspState, string> = { normal: '正常', tightened: '加严', reduced: '放宽' };

/** 重放用的状态：只承载转移规则需要的字段，records 恒为空，避免 O(n²) 归一化。 */
function replaySeed(sequenceId: string, patch: Partial<SwitchStatus> = {}): SwitchStatus {
  return { ...SWITCH_INIT, sequenceId, history: [], sinceSwitch: [], records: [], ...patch };
}

/** 状态值在管理条件下的重放种子：放宽态必须带齐条件，否则会被归一化降级。 */
function replaySeedAt(sequenceId: string, state: InspState, switchingScore: number): SwitchStatus {
  return replaySeed(sequenceId, {
    state,
    switchingScore: state === 'tightened' ? 0 : switchingScore,
    productionSteady: state === 'reduced',
    reducedApproved: state === 'reduced',
  });
}

const withoutRecords = (status: SwitchStatus): SwitchStatus => ({ ...status, records: [] });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ledgerLabel(record: AqlLedgerRecord): string {
  return isAqlTransitionRecord(record)
    ? `状态转移记录「${aqlTransitionActionLabel(record.action)}」(${record.inspectedAt})`
    : `批次「${record.batchId}」`;
}

/** 用 recordInspection 本身重放一条批次记录；返回重放后的状态或不一致说明。 */
function replayBatchRecord(current: SwitchStatus, record: AqlBatchRecord): SwitchStatus | string {
  // 放宽态必须带齐管理条件才不会被归一化降级；正常态只在记录声称自动转放宽时给出条件，
  // 让「得分 ≥30 但未勾选条件而留在正常」与「条件齐备而转放宽」两种合法路径都按同一规则重放。
  const conditions = current.state === 'reduced'
    || (current.state === 'normal' && record.stateAfter === 'reduced');
  let next: SwitchStatus;
  try {
    next = recordInspection({ ...current, productionSteady: conditions, reducedApproved: conditions, records: [] }, {
      lot: record.lot,
      level: record.level,
      aql: record.aql,
      regime: record.regime,
      nonconforming: record.nonconforming,
      batchId: record.batchId,
      inspector: record.inspector,
      inspectedAt: record.inspectedAt,
      originalInspection: record.originalInspection,
      nonconformingDisposition: record.nonconformingDisposition === 'none' || record.nonconformingDisposition === 'unrecorded'
        ? undefined
        : record.nonconformingDisposition,
    });
  } catch (error) {
    return `${ledgerLabel(record)}无法按正式转移规则重放：${errorText(error)}`;
  }
  if (next.state !== record.stateAfter || next.switchingScore !== record.switchingScoreAfter) {
    return `${ledgerLabel(record)}记录的检验后状态/转移得分为${STATE_LABEL[record.stateAfter]}/${record.switchingScoreAfter}，`
      + `按记录链重放应为${STATE_LABEL[next.state]}/${next.switchingScore}`;
  }
  return withoutRecords(next);
}

/** 用 setSwitchConditions / restoreNormalInspection / resumeTightenedInspection 本身重放一条人工状态转移记录。 */
function replayTransitionRecord(current: SwitchStatus, record: AqlTransitionRecord): SwitchStatus | string {
  if (current.state !== record.stateBefore || current.switchingScore !== record.switchingScoreBefore) {
    return `${ledgerLabel(record)}的转移前状态/得分为${STATE_LABEL[record.stateBefore]}/${record.switchingScoreBefore}，`
      + `按记录链重放应为${STATE_LABEL[current.state]}/${current.switchingScore}`;
  }
  // 解除暂停只能发生在暂停期间；未暂停时 resumeTightenedInspection 是无操作，不能让它「重放一致」。
  if (record.action === 'resume-tightened' && !current.suspended) {
    return `${ledgerLabel(record)}发生在抽样检验未暂停时，按记录链重放不应存在`;
  }
  let next: SwitchStatus;
  try {
    if (record.action === 'resume-tightened') {
      next = resumeTightenedInspection(current);
    } else if (record.action === 'conditions-met') {
      next = setSwitchConditions(
        { ...current, productionSteady: false, reducedApproved: false },
        { productionSteady: true, reducedApproved: true },
      );
    } else if (record.action === 'conditions-withdrawn') {
      next = setSwitchConditions(
        { ...current, productionSteady: true, reducedApproved: true },
        { productionSteady: record.productionSteady, reducedApproved: record.reducedApproved },
      );
    } else {
      next = restoreNormalInspection({ ...current, productionSteady: true, reducedApproved: true });
    }
  } catch (error) {
    return `${ledgerLabel(record)}无法按正式转移规则重放：${errorText(error)}`;
  }
  if (next.state !== record.stateAfter || next.switchingScore !== record.switchingScoreAfter) {
    return `${ledgerLabel(record)}记录的转移后状态/得分与按记录链重放结果不符`;
  }
  return withoutRecords(next);
}

/** 未留痕的人工转移(仅旧账本允许)：只接受 UI 本来就能做到的两类，且条件按正式规则核对。 */
function implicitManualTransition(current: SwitchStatus, target: InspState): SwitchStatus | null {
  if (current.suspended) return null;
  if (current.state === 'normal' && target === 'reduced' && current.switchingScore >= 30) {
    return withoutRecords(setSwitchConditions(
      { ...current, productionSteady: false, reducedApproved: false },
      { productionSteady: true, reducedApproved: true },
    ));
  }
  if (current.state === 'reduced' && target === 'normal') {
    return withoutRecords(setSwitchConditions(
      { ...current, productionSteady: true, reducedApproved: true },
      { productionSteady: false },
    ));
  }
  return null;
}

/** 旧账本：正常(得分 ≥30)→ 放宽 → 正常 两次不留痕的人工转移，净效果为正常检验、得分与窗口清零。 */
function implicitNormalRoundTrip(current: SwitchStatus): SwitchStatus | null {
  if (current.state !== 'normal') return null;
  const reduced = implicitManualTransition(current, 'reduced');
  return reduced ? implicitManualTransition(reduced, 'normal') : null;
}

const sameResults = (a: readonly BatchResult[], b: readonly BatchResult[]) => (
  a.length === b.length && a.every((item, index) => item === b[index])
);

interface ReplayCandidate {
  status: SwitchStatus;
  /** 推定的未留痕人工转移次数(旧账本)。 */
  implicit: number;
  /** 推定的 v1.32/33 参数变更重置次数(legacy 序列)。 */
  resets: number;
}

const candidateCost = (candidate: ReplayCandidate) => candidate.implicit + candidate.resets;

/**
 * 一个已知状态在下一条记录(或终态)之前可能经历的不留痕变化：暂停后恢复加严(任何账本)；
 * 旧账本的人工转移/正常→放宽→正常往返；legacy 序列的参数变更重置。重放按候选集合推进，
 * 因为这类变化有时不改变状态外观(例如往返后仍是正常检验)，只能由后续记录判定是否发生过。
 */
function expandCandidates(
  candidate: ReplayCandidate,
  gapAllowed: boolean,
  legacyReset: SwitchStatus | null,
): ReplayCandidate[] {
  const expanded = [candidate];
  const s = candidate.status;
  if (s.suspended) expanded.push({ ...candidate, status: withoutRecords(resumeTightenedInspection(s)) });
  if (gapAllowed) {
    const target: InspState | null = s.state === 'normal' ? 'reduced' : s.state === 'reduced' ? 'normal' : null;
    const moved = target ? implicitManualTransition(s, target) : null;
    if (moved) expanded.push({ ...candidate, status: moved, implicit: candidate.implicit + 1 });
    const roundTrip = implicitNormalRoundTrip(s);
    if (roundTrip) expanded.push({ ...candidate, status: roundTrip, implicit: candidate.implicit + 2 });
  }
  if (legacyReset) expanded.push({ ...candidate, status: legacyReset, resets: candidate.resets + 1 });
  return expanded;
}

/** 按转移规则相关字段去重，同一状态保留推定次数最少的路径。 */
function dedupeCandidates(candidates: ReplayCandidate[]): ReplayCandidate[] {
  const byKey = new Map<string, ReplayCandidate>();
  for (const candidate of candidates) {
    const s = candidate.status;
    const key = [s.state, s.suspended, s.switchingScore, s.tightenedRejections, s.sinceSwitch.slice(-5).join('')].join('|');
    const existing = byKey.get(key);
    if (!existing || candidateCost(candidate) < candidateCost(existing)) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

/** 顶层状态级字段与某个重放终态逐项比对；返回第一处差异说明，一致时返回 null。 */
function statusFieldDifference(actual: SwitchStatus, expected: SwitchStatus, compareHistory: boolean): string | null {
  if (actual.state !== expected.state) return `检验状态为${STATE_LABEL[actual.state]}，按记录链重放应为${STATE_LABEL[expected.state]}`;
  if (actual.suspended !== expected.suspended) {
    return `暂停标记为${actual.suspended ? '已暂停' : '未暂停'}，按记录链重放应为${expected.suspended ? '已暂停' : '未暂停'}`;
  }
  if (actual.switchingScore !== expected.switchingScore) {
    return `转移得分为 ${actual.switchingScore}，按记录链重放应为 ${expected.switchingScore}`;
  }
  if (actual.tightenedRejections !== expected.tightenedRejections) {
    return `加严累计不接收为 ${actual.tightenedRejections} 批，按记录链重放应为 ${expected.tightenedRejections} 批`;
  }
  const expectedWindow = expected.sinceSwitch.slice(-5);
  if (!sameResults(actual.sinceSwitch, expectedWindow)) {
    return `转移窗口为 [${actual.sinceSwitch.join('')}]，按记录链重放应为 [${expectedWindow.join('')}]`;
  }
  if (compareHistory && !sameResults(actual.history, expected.history.slice(-MAX_STATUS_HISTORY))) {
    return '当前体系批结果时间线与记录链不一致';
  }
  return null;
}

/**
 * 从当前检验序列的记录链重放状态，并与顶层 state/suspended/switchingScore/tightenedRejections/
 * sinceSwitch(严格序列另含 history)交叉核对。project.ts 在所有外来入口(localStorage、.qproj、
 * 跨窗口写入)对 mismatch fail-closed 拒绝并保留原文；专项报告据 status/notes 标记旧账本。
 */
export function auditAqlLedger(value: Partial<SwitchStatus> | null | undefined): AqlLedgerAudit {
  const status = normalizeSwitchStatus(value);
  const ledger = status.records;
  const mismatch = (detail: string): AqlLedgerAudit => ({ status: 'mismatch', detail, notes: [] });
  const notes: string[] = [];
  let implicitCount = 0;
  let legacyResetCount = 0;

  // 人工转移留痕从第一条 transition 记录起生效；其之前(含紧邻它的那一处)的缺口属于 v1.43 之前。
  const firstTransition = ledger.findIndex(isAqlTransitionRecord);
  const gapAllowedBefore = (index: number) => firstTransition === -1 || index <= firstTransition;
  const finalGapAllowed = firstTransition === -1;

  // 1) 序列在账本中必须连续；legacy 序列只能最早出现；当前序列只能在末尾。
  const order: string[] = [];
  const lastIndexOf = new Map<string, number>();
  ledger.forEach((record, index) => {
    if (order[order.length - 1] !== record.sequenceId) order.push(record.sequenceId);
    lastIndexOf.set(record.sequenceId, index);
  });
  if (new Set(order).size !== order.length) return mismatch('同一检验序列的记录在账本中不连续，记录顺序被改动');
  if (order.includes(AQL_LEGACY_SEQUENCE_ID) && order[0] !== AQL_LEGACY_SEQUENCE_ID) {
    return mismatch('旧版(无序列号)记录出现在新检验序列之后，记录顺序被改动');
  }
  if (order.includes(status.sequenceId) && order[order.length - 1] !== status.sequenceId) {
    return mismatch('当前检验序列之后仍有其他序列的记录，记录顺序或序列号被改动');
  }

  // 2) v1.34 起只有正常检验(未暂停)才能更改检验水平/AQL 开启新序列：每个已结束序列的末条记录
  //    必须停在正常检验(旧账本允许未留痕的放宽→正常)。legacy 序列末尾可能有 v1.32/33 的不留痕
  //    参数重置，无法核对，只作标记。
  for (const sequenceId of order) {
    if (sequenceId === status.sequenceId) continue;
    const endIndex = lastIndexOf.get(sequenceId)!;
    const endState = ledger[endIndex].stateAfter;
    if (endState === 'normal') continue;
    if (sequenceId === AQL_LEGACY_SEQUENCE_ID) {
      legacyResetCount += 1;
      continue;
    }
    if (endState === 'reduced' && gapAllowedBefore(endIndex + 1)) {
      implicitCount += 1;
      continue;
    }
    return mismatch(`检验序列 ${sequenceId} 在${STATE_LABEL[endState]}检验中结束，正式流程只允许在正常检验时更改检验水平/AQL`);
  }

  const start = ledger.findIndex((record) => record.sequenceId === status.sequenceId);
  const current = start === -1 ? [] : ledger.slice(start);
  const legacySequence = status.sequenceId === AQL_LEGACY_SEQUENCE_ID;
  const fresh = () => replaySeed(status.sequenceId);

  // 3) 重放当前序列。known=null 表示 legacy 序列尚未到达第一个可确定的转移点(计数未知)。
  const seed = (start: SwitchStatus): ReplayCandidate[] => [{ status: start, implicit: 0, resets: 0 }];
  let known: ReplayCandidate[] | null = legacySequence ? null : seed(fresh());
  let previousState: InspState | null = null;
  let previousScore: number | null = null;
  const unknownOriginalResults: BatchResult[] = [];

  for (let offset = 0; offset < current.length; offset += 1) {
    const record = current[offset];
    const gapAllowed = gapAllowedBefore(start + offset);
    // v1.32/33 的 legacy 序列：改检验水平/AQL(哪怕随后改回)会不留痕地重置为初始正常检验。
    const legacyResetAllowed = legacySequence && gapAllowed && record.stateBefore === 'normal';

    if (!known) {
      // legacy 未知段：只核对状态连续与逐对得分，遇到第一个可确定的转移点后转入严格重放。
      if (previousState !== null && record.stateBefore !== previousState) {
        const moved = gapAllowed
          ? implicitManualTransition(replaySeedAt(status.sequenceId, previousState, previousScore ?? 0), record.stateBefore)
          : null;
        if (moved) {
          implicitCount += 1;
          known = seed(moved);
        } else if (legacyResetAllowed) {
          legacyResetCount += 1;
          known = seed(fresh());
        } else {
          return mismatch(`记录链在${STATE_LABEL[previousState]}→${STATE_LABEL[record.stateBefore]}之间断开，`
            + '不是正式规则允许的人工转移或缺少状态转移记录');
        }
      } else if (isAqlTransitionRecord(record)) {
        if (previousScore !== null && record.switchingScoreBefore !== previousScore) {
          return mismatch(`${ledgerLabel(record)}的转移前得分 ${record.switchingScoreBefore} 与上一条记录的得分 ${previousScore} 不连续`);
        }
        known = seed(record.action === 'resume-tightened'
          // 解除暂停记录本身说明此前处于加严暂停态(暂停门槛为累计 5 批不接收)。
          ? replaySeed(status.sequenceId, { state: 'tightened', suspended: true, tightenedRejections: 5 })
          : replaySeedAt(status.sequenceId, record.stateBefore, record.switchingScoreBefore));
      } else {
        // 逐对得分核对：以上一条记录的得分(或人工往返/参数重置清零后的 0)为起点单批重放。
        // 换入/换出加严取决于跨批窗口(未知段无从得知)，其得分已由单条校验固定为 0。
        const windowDependent = (record.stateBefore === 'normal' && record.stateAfter === 'tightened')
          || (record.stateBefore === 'tightened' && record.stateAfter === 'normal');
        const bases = previousScore === null || windowDependent ? [] : [...new Set([previousScore, 0])];
        const replays = bases.map((base) => replayBatchRecord(replaySeedAt(status.sequenceId, record.stateBefore, base), record));
        if (replays.length > 0 && replays.every((result) => typeof result === 'string')) {
          return mismatch(`${replays[0] as string}(与上一条记录的得分不连续)`);
        }
        previousState = record.stateAfter;
        previousScore = record.switchingScoreAfter;
        if (record.stateBefore !== record.stateAfter) {
          // 换表记录之后计数全部确定：得分取记录值(已逐对核对)，窗口与加严累计清零。
          known = seed(replaySeedAt(status.sequenceId, record.stateAfter, record.switchingScoreAfter));
        } else if (record.originalInspection) {
          unknownOriginalResults.push(record.result);
        }
        continue;
      }
    }

    // 严格重放(计数已知)：候选集合逐条推进，任何候选都无法解释该记录即不一致。
    const expanded = known.flatMap((candidate) => expandCandidates(
      candidate, gapAllowed, legacySequence && gapAllowed ? fresh() : null,
    ));
    const survivors: ReplayCandidate[] = [];
    let failure: string | null = null;
    for (const candidate of expanded) {
      const base = candidate.status;
      let next: SwitchStatus | string;
      if (base.suspended && !(isAqlTransitionRecord(record) && record.action === 'resume-tightened')) {
        next = `${ledgerLabel(record)}发生在抽样检验暂停期间，正式流程不允许`;
      } else if (base.state !== record.stateBefore) {
        next = `${ledgerLabel(record)}的检验前状态为${STATE_LABEL[record.stateBefore]}，`
          + `按记录链重放应为${STATE_LABEL[base.state]}${gapAllowed ? '' : '(缺少状态转移记录)'}`;
      } else {
        next = isAqlBatchRecord(record) ? replayBatchRecord(base, record) : replayTransitionRecord(base, record);
      }
      if (typeof next === 'string') failure ??= next;
      else survivors.push({ ...candidate, status: next });
    }
    if (survivors.length === 0) return mismatch(failure ?? `${ledgerLabel(record)}无法按正式转移规则重放`);
    known = dedupeCandidates(survivors);
    previousState = record.stateAfter;
    previousScore = record.switchingScoreAfter;
  }

  // 4) 顶层状态级字段与重放终态交叉核对。
  if (known) {
    const finals = known.flatMap((candidate) => expandCandidates(
      candidate, finalGapAllowed, legacySequence && finalGapAllowed ? fresh() : null,
    ));
    const matches = finals
      .filter((candidate) => statusFieldDifference(status, candidate.status, !legacySequence) === null)
      .sort((x, y) => candidateCost(x) - candidateCost(y));
    if (matches.length === 0) {
      return mismatch(`AQL 状态字段与责任账本记录链不一致：${statusFieldDifference(status, finals[0].status, !legacySequence)}`);
    }
    implicitCount += matches[0].implicit;
    legacyResetCount += matches[0].resets;
  } else if (current.length === 0) {
    // 没有任何当前序列记录的 legacy 状态(v1.31 近似版迁入)：状态本身无从重放，
    // 但正常检验转移得分只能由批次记录累积，凭空的得分按不一致拒绝。
    if (status.state === 'normal' && status.switchingScore > 0) {
      return mismatch(`历史账本没有任何批次记录，却声称正常检验转移得分 ${status.switchingScore}`);
    }
    if (status.state !== 'normal' || status.suspended) notes.push('历史账本未含批次记录，当前检验状态无法由记录链重放核对');
  } else {
    // legacy 序列全程没有可确定的转移点：只能核对终态、得分与转移窗口末尾。
    const endState = previousState!;
    const endScore = previousScore!;
    const options: Array<{ state: InspState; score: number; windowCleared: boolean; implicit: boolean }> = [
      { state: endState, score: endScore, windowCleared: false, implicit: false },
    ];
    // 暂停后恢复加严不留痕(窗口清零)；人工转移与参数重置仅旧账本推定。
    if (endState === 'tightened') options.push({ state: 'tightened', score: 0, windowCleared: true, implicit: false });
    if (finalGapAllowed) {
      if (endState === 'normal' && endScore >= 30) options.push({ state: 'reduced', score: endScore, windowCleared: true, implicit: true });
      options.push({ state: 'normal', score: 0, windowCleared: true, implicit: true });
    }
    // 窗口前缀未知，且恢复加严/参数重置可在任意位置清空窗口：只要求两者重叠的末尾一致。
    const observed = unknownOriginalResults.slice(-5);
    const overlap = Math.min(status.sinceSwitch.length, observed.length);
    const windowTailAgrees = sameResults(
      status.sinceSwitch.slice(status.sinceSwitch.length - overlap), observed.slice(observed.length - overlap),
    );
    const match = options.find((option) => option.state === status.state && option.score === status.switchingScore
      && (option.windowCleared ? status.sinceSwitch.length === 0 || windowTailAgrees : windowTailAgrees));
    if (!match) {
      return mismatch(`AQL 状态字段与责任账本记录链不一致：末条记录为${STATE_LABEL[endState]}检验/得分 ${endScore}，`
        + `状态字段为${STATE_LABEL[status.state]}检验/得分 ${status.switchingScore}，转移窗口为 [${status.sinceSwitch.join('')}]`);
    }
    if (match.implicit) implicitCount += 1;
  }

  if (legacySequence) {
    notes.push('历史账本(v1.34 之前建立的检验序列)没有序列号，只能从首个可确定的状态转移点起重放核对');
  }
  if (legacyResetCount > 0) {
    notes.push(`历史账本含 ${legacyResetCount} 处按 v1.32/33「更改检验水平/AQL 即重置」推定的不留痕重置`);
  }
  if (implicitCount > 0) {
    notes.push(`历史账本未含转移记录：${implicitCount} 处人工状态转移(管理条件/恢复正常)按正式规则推定`);
  }
  return notes.length > 0
    ? { status: 'legacy', detail: '', notes }
    : { status: 'verified', detail: '', notes: [] };
}

export interface AqlReportData {
  standard: 'GB/T 2828.1-2012 / ISO 2859-1:1999';
  samplingType: '一次抽样';
  state: InspState;
  stateLabel: string;
  sourceTable: AqlMasterTable;
  lot: number;
  level: InspectionLevel;
  aql: number;
  /** AQL 体系:percent=百分不合格品(二项);per100=每百单位不合格数(泊松,d 可大于 n)。 */
  regime: AqlRegime;
  initialCode: string;
  plan: SamplingPlan;
  producerRiskPct: number | null;
  /** RQL(百分不合格品,%)。per100 体系单位不同,恒为 null,改用 rqlPer100。 */
  rqlPct: number | null;
  /** RQL(每百单位不合格数 λ)。percent 体系恒为 null。 */
  rqlPer100: number | null;
  switchingScore: number;
  productionSteady: boolean;
  reducedApproved: boolean;
  suspended: boolean;
  latestRecord: AqlBatchRecord | null;
  records: AqlLedgerRecord[];
  /** CORE-06:记录链重放审计结果；legacy 时 notes 须随报告提示「历史账本未含转移记录」等。 */
  ledgerAudit: AqlLedgerAudit;
}

/** 专项报告/导出层可直接消费的结构化 AQL 数据，不依赖 React 或统一报告模块。 */
export function buildAqlReportData(
  lot: number, level: InspectionLevel, aql: number, status: SwitchStatus, requestedRegime?: AqlRegime,
): AqlReportData {
  const s = normalizeSwitchStatus(status);
  const plan = plansByState(lot, level, aql)[s.state];
  const regime = resolveAqlRegime(aql, requestedRegime);
  const rql = rqlForResult(plan, 0.1, undefined, regime);
  // 参数切换后保留全部历史追溯，但不得把旧方案的批结果冒充当前方案最新批。
  const latestRecord = [...s.records].reverse().filter(isAqlBatchRecord).find((record) => (
    record.sequenceId === s.sequenceId
    && record.lot === lot && record.level === level && record.aql === aql && record.regime === regime
  ));
  return {
    standard: 'GB/T 2828.1-2012 / ISO 2859-1:1999',
    samplingType: '一次抽样',
    state: s.state,
    stateLabel: s.state === 'tightened' ? '加严检验' : s.state === 'reduced' ? '放宽检验' : '正常检验',
    sourceTable: TABLE_BY_STATE[s.state],
    lot,
    level,
    aql,
    regime,
    initialCode: codeLetterGB(lot, level),
    plan: { ...plan },
    producerRiskPct: plan.fullInspect ? null : producerRiskPct(plan, aql, regime),
    // 两体系 RQL 单位不同(%批不良率 vs 每百单位不合格数),各自独立成字段,绝不混用。
    rqlPct: regime === 'percent' && rql.status === 'found' ? rql.p * 100 : null,
    rqlPer100: regime === 'per100' && rql.status === 'found' ? rql.p : null,
    switchingScore: s.switchingScore,
    productionSteady: s.productionSteady,
    reducedApproved: s.reducedApproved,
    suspended: s.suspended,
    latestRecord: latestRecord ? { ...latestRecord } : null,
    records: s.records.map((x) => ({ ...x })),
    ledgerAudit: auditAqlLedger(s),
  };
}
