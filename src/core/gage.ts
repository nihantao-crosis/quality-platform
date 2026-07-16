/**
 * Gage R&R — 交叉设计 ANOVA 法（AIAG）。
 * 补齐交接文档 core-skeleton/statistics.ts §6 的签名。
 */

import { fCdf } from './basicMath';

export interface GageObservation {
  part: number; // 0-based
  operator: number; // 0-based
  trial: number; // 0-based
  value: number;
}

export interface GageComponent {
  source: string;
  variance: number;
  pctContribution: number; // 方差占比
  pctStudyVar: number; // 6σ 占比
  /** 只有给出双侧规格公差宽度时才能计算。 */
  pctTolerance: number | null; // 6σ / 公差
}

export interface GageResult {
  totalGageRR: number; // %研究变异
  components: GageComponent[]; // 合计GRR / 重复性 / 再现性 / 部件间 / 合计变异
  verdict: 'acceptable' | 'marginal' | 'unacceptable'; // <10 / 10–30 / >30 (AIAG)
  /** 交互项检验及最终模型选择。默认删除阈值与 Minitab 交叉 Gage R&R 一致为 0.05。 */
  interaction: {
    alpha: number;
    fStat: number;
    pValue: number;
    retained: boolean;
  };
}

interface ValidatedGageStudy {
  data: GageObservation[];
  partCount: number;
  operatorCount: number;
  trialCount: number;
}

/**
 * ANOVA 法要求每个“部件 × 操作员”单元都包含同一组重复试验，且每个
 * “部件 × 操作员 × 试验”组合恰好出现一次。GageObservation 的编号契约
 * 为 0-based，因此三类编号也必须连续，不能靠最大编号静默补出空水平。
 */
function validateGageStudy(data: GageObservation[], tolerance: number | null): ValidatedGageStudy {
  if (tolerance != null && (!Number.isFinite(tolerance) || tolerance <= 0)) {
    throw new RangeError('量具 R&R 公差必须是大于 0 的有限数值');
  }
  if (!Array.isArray(data)) throw new TypeError('量具 R&R 数据必须是观测数组');

  for (const observation of data) {
    if (observation == null || !Number.isFinite(observation.value)) {
      throw new TypeError('量具 R&R 测量值必须全部为有限数值');
    }
    if (
      !Number.isFinite(observation.part)
      || !Number.isFinite(observation.operator)
      || !Number.isFinite(observation.trial)
    ) {
      throw new TypeError('部件、操作员和重复试验编号必须全部为有限数值');
    }
    if (
      !Number.isSafeInteger(observation.part)
      || !Number.isSafeInteger(observation.operator)
      || !Number.isSafeInteger(observation.trial)
      || observation.part < 0
      || observation.operator < 0
      || observation.trial < 0
    ) {
      throw new RangeError('部件、操作员和重复试验编号必须是非负安全整数');
    }
  }

  const partIds = [...new Set(data.map((observation) => observation.part))].sort((a, b) => a - b);
  const operatorIds = [...new Set(data.map((observation) => observation.operator))].sort((a, b) => a - b);
  const trialIds = [...new Set(data.map((observation) => observation.trial))].sort((a, b) => a - b);
  if (partIds.length < 2 || operatorIds.length < 2 || trialIds.length < 2) {
    throw new Error('交叉量具 R&R 至少需要 2 个部件、2 名操作员和 2 次重复试验');
  }
  const requireContiguousIds = (ids: number[], label: string) => {
    if (ids.some((id, index) => id !== index)) {
      throw new RangeError(`${label}编号必须从 0 开始连续，不能缺号`);
    }
  };
  requireContiguousIds(partIds, '部件');
  requireContiguousIds(operatorIds, '操作员');
  requireContiguousIds(trialIds, '重复试验');

  const observed = new Set<string>();
  for (const observation of data) {
    const key = `${observation.part}:${observation.operator}:${observation.trial}`;
    if (observed.has(key)) {
      throw new Error('同一部件、操作员与重复试验组合不能重复');
    }
    observed.add(key);
  }
  for (let part = 0; part < partIds.length; part++) {
    for (let operator = 0; operator < operatorIds.length; operator++) {
      for (let trial = 0; trial < trialIds.length; trial++) {
        if (!observed.has(`${part}:${operator}:${trial}`)) {
          throw new Error('量具 R&R 必须采用完整且等重复的部件 × 操作员交叉平衡设计，重复试验不能缺失');
        }
      }
    }
  }

  return {
    data,
    partCount: partIds.length,
    operatorCount: operatorIds.length,
    trialCount: trialIds.length,
  };
}

/**
 * 交叉 Gage R&R ANOVA 法。
 *
 * 当部件×操作员交互项 p >= 0.05 时，按标准缩减模型将交互项
 * SS/df 合并到重复性误差；显著时则保留交互方差分量。未给出双侧规格
 * 宽度时传 null，仍计算研究变异，但 %Tolerance 明确返回 null。
 */
export function computeGageRR(data: GageObservation[], tolerance: number | null): GageResult {
  const validated = validateGageStudy(data, tolerance);
  const observations = validated.data;
  const p = validated.partCount;
  const o = validated.operatorCount;
  const r = validated.trialCount;
  const N = observations.length;
  if (observations.every((observation) => observation.value === observations[0].value)) {
    throw new Error('量具 R&R 合计变异为 0，无法计算变异占比');
  }
  // ANOVA 只依赖差值。先平移并按数据自身尺度归一化，避免大基值
  // 测量的平方和严重抵消，同时保持 F/p 对单位缩放不变。
  const origin = observations[0].value;
  const centered = observations.map((observation) => observation.value - origin);
  const scale = centered.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (!Number.isFinite(scale)) throw new Error('量具 R&R 测量值范围过大，无法得到有限的方差');
  const normalized = scale === 0 ? centered : centered.map((value) => value / scale);
  const grand = normalized.reduce((sum, value) => sum + value, 0) / N;

  const partMean = new Array(p).fill(0);
  const operMean = new Array(o).fill(0);
  const cellMean: number[][] = Array.from({ length: p }, () => new Array(o).fill(0));
  observations.forEach((d, index) => {
    const value = normalized[index];
    partMean[d.part] += value / (o * r);
    operMean[d.operator] += value / (p * r);
    cellMean[d.part][d.operator] += value / r;
  });

  const ssPart = o * r * partMean.reduce((a, m) => a + (m - grand) ** 2, 0);
  const ssOper = p * r * operMean.reduce((a, m) => a + (m - grand) ** 2, 0);
  let ssInter = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < o; j++) {
      ssInter += r * (cellMean[i][j] - partMean[i] - operMean[j] + grand) ** 2;
    }
  }
  const ssError = observations.reduce((sum, observation, index) => (
    sum + (normalized[index] - cellMean[observation.part][observation.operator]) ** 2
  ), 0);

  const msPart = ssPart / (p - 1);
  const msOper = ssOper / (o - 1);
  const dfInter = (p - 1) * (o - 1);
  const dfError = p * o * (r - 1);
  const msInter = ssInter / dfInter;
  const msError = ssError / dfError;

  let interactionF: number;
  let interactionP: number;
  if (msError === 0) {
    interactionF = msInter === 0 ? 0 : Infinity;
    interactionP = msInter === 0 ? 1 : 0;
  } else {
    interactionF = msInter / msError;
    interactionP = interactionF === Infinity
      ? 0
      : Math.max(0, Math.min(1, 1 - fCdf(interactionF, dfInter, dfError)));
  }
  const interactionAlpha = 0.05;
  const retainInteraction = interactionP < interactionAlpha;

  // 不显著交互不能继续作为分母：把它的 SS/df 合并到重复性误差后
  // 用缩减模型估计操作员与部件分量。最后恢复原始单位的方差。
  const reducedErrorMs = (ssInter + ssError) / (dfInter + dfError);
  const modelErrorMs = retainInteraction ? msError : reducedErrorMs;
  const modelDenominatorMs = retainInteraction ? msInter : reducedErrorMs;
  const varianceScale = scale * scale;
  const restoreVariance = (value: number) => value === 0 ? 0 : value * varianceScale;
  const vRepeat = restoreVariance(Math.max(0, modelErrorMs));
  const vInter = retainInteraction
    ? restoreVariance(Math.max(0, (msInter - msError) / r))
    : 0;
  const vOper = restoreVariance(Math.max(0, (msOper - modelDenominatorMs) / (p * r)));
  const vPart = restoreVariance(Math.max(0, (msPart - modelDenominatorMs) / (o * r)));
  const vReprod = vOper + vInter;
  const vGRR = vRepeat + vReprod;
  const vTotal = vGRR + vPart;
  if (!Number.isFinite(vTotal)) throw new Error('量具 R&R 无法得到有限的合计变异');
  if (vTotal <= 0) throw new Error('量具 R&R 合计变异为 0，无法计算变异占比');

  const sTotal = Math.sqrt(vTotal);
  const mk = (source: string, v: number): GageComponent => ({
    source,
    variance: v,
    pctContribution: (v / vTotal) * 100,
    pctStudyVar: (Math.sqrt(v) / sTotal) * 100,
    pctTolerance: tolerance == null ? null : ((6 * Math.sqrt(v)) / tolerance) * 100,
  });

  const totalGageRR = (Math.sqrt(vGRR) / sTotal) * 100;
  return {
    totalGageRR,
    components: [
      mk('合计 Gage R&R', vGRR),
      mk('  重复性', vRepeat),
      mk('  再现性', vReprod),
      mk('部件间', vPart),
      mk('合计变异', vTotal),
    ],
    verdict: totalGageRR < 10 ? 'acceptable' : totalGageRR <= 30 ? 'marginal' : 'unacceptable',
    interaction: {
      alpha: interactionAlpha,
      fStat: interactionF,
      pValue: interactionP,
      retained: retainInteraction,
    },
  };
}
