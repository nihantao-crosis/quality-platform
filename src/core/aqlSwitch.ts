/**
 * GB/T 2828.1-2012 / ISO 2859-1:1999 正常、加严、放宽检验及正式转移规则。
 *
 * 方案分别来自表 2-A / 2-B / 2-C；转移得分按 9.3.3.2 的一次抽样规则更新，
 * 加严检验累计 5 批不接收时按 9.4 暂停抽样检验。
 */
import {
  AQL_COLS, TABLE_BY_STATE, aqlPlanByState, codeLetterGB,
  normalPlanOneStepTighter, producerRiskPct, rqlForResult,
  type AqlMasterTable, type InspectionLevel, type InspectionState, type SamplingPlan,
} from './aql';

export type InspState = InspectionState;
export type BatchResult = 'A' | 'R';
export type LotDecision = 'accepted' | 'rejected';

export interface AqlBatchRecord {
  id: string;
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
  result: BatchResult;
  decision: LotDecision;
  switchingScoreAfter: number;
  note: string;
}

export interface SwitchStatus {
  state: InspState;
  history: BatchResult[]; // 只含初次检验批，供正式转移规则使用
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

const results = (value: unknown): BatchResult[] => Array.isArray(value)
  ? value.filter((x): x is BatchResult => x === 'A' || x === 'R')
  : [];

/** 兼容旧项目/旧 localStorage 中只有 state/history/sinceSwitch/note 的记录。 */
export function normalizeSwitchStatus(value?: Partial<SwitchStatus> | null): SwitchStatus {
  const state: InspState = value?.state === 'tightened' || value?.state === 'reduced' ? value.state : 'normal';
  const records = Array.isArray(value?.records)
    ? value.records.filter((x): x is AqlBatchRecord => Boolean(x && typeof x === 'object')).map((x) => ({ ...x }))
    : [];
  const switchingScore = Number.isFinite(value?.switchingScore)
    ? Math.max(0, Math.trunc(value!.switchingScore!))
    : 0;
  const tightenedRejections = Number.isFinite(value?.tightenedRejections)
    ? Math.max(0, Math.trunc(value!.tightenedRejections!))
    : 0;
  return {
    state,
    history: results(value?.history),
    sinceSwitch: results(value?.sinceSwitch),
    note: typeof value?.note === 'string' ? value.note : SWITCH_INIT.note,
    switchingScore,
    tightenedRejections,
    productionSteady: value?.productionSteady === true,
    reducedApproved: value?.reducedApproved === true,
    suspended: state === 'tightened' && value?.suspended === true,
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

export function decideLot(plan: SamplingPlan, nonconforming: number): LotDecision {
  if (!Number.isSafeInteger(nonconforming) || nonconforming < 0 || nonconforming > plan.n) {
    throw new RangeError(`不合格数必须是 0–${plan.n} 的整数`);
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
}

function acceptedAtOneStepTighter(initialCode: string, aql: number, nonconforming: number): boolean {
  const plan = normalPlanOneStepTighter(initialCode, aql);
  if (!plan) throw new RangeError(`无法取得 AQL ${aql} 的严一档正常检验方案`);
  return nonconforming <= plan.ac;
}

function trailingAcceptedCount(history: BatchResult[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === 'A'; i--) count += 1;
  return count;
}

export function recordInspection(status: SwitchStatus, input: RecordInspectionInput): SwitchStatus {
  const s = normalizeSwitchStatus(status);
  if (s.suspended) throw new Error('抽样检验已暂停；须确认纠正措施有效后恢复加严检验');
  if (!Number.isSafeInteger(input.lot) || input.lot < 2) throw new RangeError('批量必须是大于等于 2 的安全整数');
  if (!AQL_COLS.includes(input.aql)) throw new RangeError(`仅支持正式主表 AQL：${AQL_COLS.join('、')}`);

  const originalInspection = input.originalInspection !== false;
  const stateBefore = s.state;
  const plan = plansByState(input.lot, input.level, input.aql)[stateBefore];
  const decision = decideLot(plan, input.nonconforming);
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
      if (acceptedAtOneStepTighter(codeLetterGB(input.lot, input.level), input.aql, input.nonconforming)) {
        switchingScore += 3;
        note = `本批在严一档 AQL 下仍可接收，转移得分 +3 = ${switchingScore}`;
      } else {
        switchingScore = 0;
        note = '本批按当前 AQL 接收，但严一档 AQL 下不能接收，转移得分清零';
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
  const record: AqlBatchRecord = {
    id: `${inspectedAt}-${s.records.length + 1}`,
    batchId,
    inspector: input.inspector?.trim() || '未填写',
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
    result,
    decision,
    switchingScoreAfter: switchingScore,
    note,
  };

  return {
    ...s,
    state,
    history,
    sinceSwitch,
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
  return { ...s, state: 'normal', switchingScore: 0, sinceSwitch: [], note: reason };
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
  initialCode: string;
  plan: SamplingPlan;
  producerRiskPct: number | null;
  rqlPct: number | null;
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
  const rql = rqlForResult(plan);
  // 参数切换后保留全部历史追溯，但不得把旧方案的批结果冒充当前方案最新批。
  const latestRecord = [...s.records].reverse().find((record) => (
    record.lot === lot && record.level === level && record.aql === aql
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
    initialCode: codeLetterGB(lot, level),
    plan: { ...plan },
    producerRiskPct: plan.fullInspect ? null : producerRiskPct(plan, aql),
    rqlPct: rql.status === 'found' ? rql.p * 100 : null,
    switchingScore: s.switchingScore,
    productionSteady: s.productionSteady,
    reducedApproved: s.reducedApproved,
    suspended: s.suspended,
    latestRecord: latestRecord ? { ...latestRecord } : null,
    records: s.records.map((x) => ({ ...x })),
  };
}
