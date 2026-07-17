/**
 * GB/T 2828.1-2012 / ISO 2859-1:1999 正常、加严、放宽检验及正式转移规则。
 *
 * 方案分别来自表 2-A / 2-B / 2-C；转移得分按 9.3.3.2 的一次抽样规则更新，
 * 加严检验累计 5 批不接收时按 9.4 暂停抽样检验。
 */
import {
  AQL_COLS, PER100_MAX_D_PER_UNIT, TABLE_BY_STATE, aqlPlanByState, aqlRegime, codeLetterGB,
  normalPlanOneStepTighter, producerRiskPct, rqlForResult,
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
  records: AqlBatchRecord[]; // 含初次检验与复验批的可追溯记录
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

const INSPECTION_LEVELS = new Set<InspectionLevel>(['I', 'II', 'III']);
const INSPECTION_STATES = new Set<InspState>(['normal', 'tightened', 'reduced']);
const SAMPLE_CODES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R']);
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

/** 外来项目/localStorage 的责任记录必须先通过完整字段与交叉字段校验。 */
function normalizeAqlBatchRecord(value: unknown, fallbackSequenceId: string): AqlBatchRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = value as Partial<AqlBatchRecord>;
  const decisionOk = x.decision === 'accepted' || x.decision === 'rejected';
  const resultOk = x.result === 'A' || x.result === 'R';
  const stateOk = INSPECTION_STATES.has(x.stateBefore as InspState)
    && INSPECTION_STATES.has(x.stateAfter as InspState);
  // K2:d 的上限按体系分流——percent 体系 d ≤ n;per100 体系(AQL≥15,计点)d 可大于 n,
  // 只设工程上限 n×PER100_MAX_D_PER_UNIT。体系由记录自身的 aql 判定(先验证其为正式档位)。
  const aqlOk = typeof x.aql === 'number' && AQL_COLS.includes(x.aql);
  const dMax = aqlOk && Number.isSafeInteger(x.sampleSize)
    ? (aqlRegime(x.aql as number) === 'per100' ? x.sampleSize! * PER100_MAX_D_PER_UNIT : x.sampleSize!)
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
  const record = { ...(x as AqlBatchRecord), sequenceId, nonconformingDisposition };
  return recordTransitionIsPossible(record) ? record : null;
}

/** 兼容旧项目/旧 localStorage 中只有 state/history/sinceSwitch/note 的记录。 */
export function normalizeSwitchStatus(value?: Partial<SwitchStatus> | null): SwitchStatus {
  const sequenceId = typeof value?.sequenceId === 'string' && value.sequenceId.trim()
    && value.sequenceId.trim().length <= AQL_TRACE_LIMITS.sequenceId
    ? value.sequenceId.trim()
    : 'sequence-legacy-v2';
  const requestedState: InspState = value?.state === 'tightened' || value?.state === 'reduced' ? value.state : 'normal';
  const records = Array.isArray(value?.records)
    ? value.records
      .map((record) => normalizeAqlBatchRecord(record, sequenceId))
      .filter((record): record is AqlBatchRecord => record !== null)
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

export function recordInspection(status: SwitchStatus, input: RecordInspectionInput): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (s.suspended) throw new Error('抽样检验已暂停；须确认纠正措施有效后恢复加严检验');
  if (s.records.length >= MAX_AQL_RECORDS) {
    throw new RangeError(`本项目 AQL 责任账本已达到 ${MAX_AQL_RECORDS} 条上限；请先导出项目/专项报告完成归档，再新建项目继续记录。旧记录不会被自动删除`);
  }
  if (!Number.isSafeInteger(input.lot) || input.lot < 2) throw new RangeError('批量必须是大于等于 2 的安全整数');
  if (!AQL_COLS.includes(input.aql)) throw new RangeError(`仅支持正式主表 AQL：${AQL_COLS.join('、')}`);

  const originalInspection = input.originalInspection !== false;
  const stateBefore = s.state;
  const plan = plansByState(input.lot, input.level, input.aql)[stateBefore];
  // K2:per100 体系(AQL≥15)允许 d > n,decideLot 按体系分流录入上限。
  const decision = decideLot(plan, input.nonconforming, aqlRegime(input.aql));
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
  const batchId = input.batchId?.trim() || `批次-${String(s.records.length + 1).padStart(4, '0')}`;
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

/** 设置正常→放宽所需两个管理条件；条件补齐时立即按当前得分判定是否转放宽。 */
export function setSwitchConditions(
  status: SwitchStatus,
  patch: Partial<Pick<SwitchStatus, 'productionSteady' | 'reducedApproved'>>,
): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  const next = { ...s, ...patch };
  if (s.state === 'reduced' && (!next.productionSteady || !next.reducedApproved)) {
    return {
      ...next, state: 'normal', switchingScore: 0, sinceSwitch: [],
      note: '生产稳定/负责部门同意条件不再满足 → 恢复正常检验',
    };
  }
  if (s.state === 'normal' && next.switchingScore >= 30 && next.productionSteady && next.reducedApproved) {
    return {
      ...next, state: 'reduced', sinceSwitch: [],
      note: '转移得分 ≥30、生产稳定且负责部门同意 → 转放宽检验（表 2-C）',
    };
  }
  return next;
}

/** 放宽检验中因“其他条件”由负责人决定恢复正常检验。 */
export function restoreNormalInspection(status: SwitchStatus, reason = '其他条件要求恢复正常检验'): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (s.suspended) throw new Error('暂停检验只能在确认纠正措施有效后恢复加严检验');
  if (s.state !== 'reduced') throw new Error('只有放宽检验可因其他条件恢复正常检验');
  return {
    ...s,
    state: 'normal',
    switchingScore: 0,
    tightenedRejections: 0,
    suspended: false,
    sinceSwitch: [],
    note: reason,
  };
}

/** 9.4：供方完成纠正且负责部门确认有效后，以加严检验重新开始。 */
export function resumeTightenedInspection(status: SwitchStatus): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (!s.suspended) return s;
  return {
    ...s,
    state: 'tightened',
    suspended: false,
    tightenedRejections: 0,
    sinceSwitch: [],
    note: '纠正措施已确认有效 → 恢复加严检验（表 2-B）',
  };
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
  records: AqlBatchRecord[];
}

/** 专项报告/导出层可直接消费的结构化 AQL 数据，不依赖 React 或统一报告模块。 */
export function buildAqlReportData(
  lot: number, level: InspectionLevel, aql: number, status: SwitchStatus,
): AqlReportData {
  const s = normalizeSwitchStatus(status);
  const plan = plansByState(lot, level, aql)[s.state];
  const regime = aqlRegime(aql);
  const rql = rqlForResult(plan, 0.1, undefined, regime);
  // 参数切换后保留全部历史追溯，但不得把旧方案的批结果冒充当前方案最新批。
  const latestRecord = [...s.records].reverse().find((record) => (
    record.sequenceId === s.sequenceId
    && record.lot === lot && record.level === level && record.aql === aql
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
    producerRiskPct: plan.fullInspect ? null : producerRiskPct(plan, aql),
    // 两体系 RQL 单位不同(%批不良率 vs 每百单位不合格数),各自独立成字段,绝不混用。
    rqlPct: regime === 'percent' && rql.status === 'found' ? rql.p * 100 : null,
    rqlPer100: regime === 'per100' && rql.status === 'found' ? rql.p : null,
    switchingScore: s.switchingScore,
    productionSteady: s.productionSteady,
    reducedApproved: s.reducedApproved,
    suspended: s.suspended,
    latestRecord: latestRecord ? { ...latestRecord } : null,
    records: s.records.map((x) => ({ ...x })),
  };
}
