/**
 * Gage R&R — 交叉设计 ANOVA 法（AIAG）。
 * 补齐交接文档 core-skeleton/statistics.ts §6 的签名。
 */

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
  pctTolerance: number; // 6σ / 公差
}

export interface GageResult {
  totalGageRR: number; // %研究变异
  components: GageComponent[]; // 合计GRR / 重复性 / 再现性 / 部件间 / 合计变异
  verdict: 'acceptable' | 'marginal' | 'unacceptable'; // <10 / 10–30 / >30 (AIAG)
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
function validateGageStudy(data: GageObservation[], tolerance: number): ValidatedGageStudy {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
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

export function computeGageRR(data: GageObservation[], tolerance: number): GageResult {
  const validated = validateGageStudy(data, tolerance);
  const observations = validated.data;
  const p = validated.partCount;
  const o = validated.operatorCount;
  const r = validated.trialCount;
  const N = observations.length;
  if (observations.every((observation) => observation.value === observations[0].value)) {
    throw new Error('量具 R&R 合计变异为 0，无法计算变异占比');
  }
  const grand = observations.reduce((a, d) => a + d.value, 0) / N;
  if (!Number.isFinite(grand)) throw new Error('量具 R&R 测量值范围过大，无法得到有限的均值');

  const partMean = new Array(p).fill(0);
  const operMean = new Array(o).fill(0);
  const cellMean: number[][] = Array.from({ length: p }, () => new Array(o).fill(0));
  observations.forEach((d) => {
    partMean[d.part] += d.value / (o * r);
    operMean[d.operator] += d.value / (p * r);
    cellMean[d.part][d.operator] += d.value / r;
  });

  const ssTotal = observations.reduce((a, d) => a + (d.value - grand) ** 2, 0);
  if (!Number.isFinite(ssTotal)) throw new Error('量具 R&R 测量值范围过大，无法得到有限的方差');
  const ssPart = o * r * partMean.reduce((a, m) => a + (m - grand) ** 2, 0);
  const ssOper = p * r * operMean.reduce((a, m) => a + (m - grand) ** 2, 0);
  let ssCell = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < o; j++) ssCell += r * (cellMean[i][j] - grand) ** 2;
  const ssInter = ssCell - ssPart - ssOper;
  const ssError = ssTotal - ssCell;

  const msPart = ssPart / (p - 1);
  const msOper = ssOper / (o - 1);
  const msInter = ssInter / ((p - 1) * (o - 1));
  const msError = ssError / (p * o * (r - 1));

  // 方差分量（负值截 0）
  const nonnegativeMsError = Math.max(0, msError);
  const nonnegativeMsInter = Math.max(0, msInter);
  const vRepeat = nonnegativeMsError;
  const vInter = Math.max(0, (nonnegativeMsInter - nonnegativeMsError) / r);
  const vOper = Math.max(0, (msOper - nonnegativeMsInter) / (p * r));
  const vPart = Math.max(0, (msPart - nonnegativeMsInter) / (o * r));
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
    pctTolerance: ((6 * Math.sqrt(v)) / tolerance) * 100,
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
  };
}
