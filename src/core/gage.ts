/**
 * Gage R&R — 交叉设计 ANOVA 法（AIAG / Minitab 口径）。
 * 补齐交接文档 core-skeleton/statistics.ts §6 的签名。
 *
 * v1.40（MSA 工厂案例验收批次）：
 * - 支持单操作员研究（操作员数=1 退化为单因子随机效应 ANOVA，GRR=重复性，无再现性分量）；
 * - 组件表增加 SD / 研究变异(6×SD) 字段与「操作员」「部件×操作员」分行，行结构与 Minitab 会话窗口同构；
 * - 新增可区分的类别数 ndc = floor(√(2σ²部件/σ²GRR))（下限 1）；
 * - 公差升级为 {mode, value}：双侧宽度 %Tol=6·SD/宽度；单侧限 %Tol=3·SD/|限值−总均值|
 *   （与 Minitab 单边规格公式一致），总均值已达/越过限值时拒绝计算并给出说明。
 */

import { fCdf, mean } from './basicMath';

export interface GageObservation {
  part: number; // 0-based
  operator: number; // 0-based
  trial: number; // 0-based
  value: number;
}

/** 过程公差口径：双侧宽度 / 仅上限 / 仅下限。 */
export type GageToleranceMode = 'width' | 'upper' | 'lower';
export interface GageToleranceSpec {
  mode: GageToleranceMode;
  /** width 模式为公差宽度(>0)；upper/lower 模式为规格限位置(有限数)。 */
  value: number;
}

export type GageComponentKey =
  | 'grr' | 'repeatability' | 'reproducibility' | 'operator' | 'interaction' | 'part' | 'total';

export interface GageComponent {
  key: GageComponentKey;
  /** 带缩进的会话窗口显示名；operator 行的实际列名由消费方按 key 替换。 */
  source: string;
  /** 缩进层级：0=合计/部件间/合计变异,1=重复性/再现性,2=操作员/交互 */
  depth: 0 | 1 | 2;
  variance: number;
  sd: number;
  /** 研究变异 = 6×SD */
  studyVar: number;
  pctContribution: number; // 方差占比
  pctStudyVar: number; // σ 占比
  /** 未给公差、或单侧公差被守卫拒绝时为 null。 */
  pctTolerance: number | null;
}

export interface GageResult {
  totalGageRR: number; // %研究变异
  components: GageComponent[];
  verdict: 'acceptable' | 'marginal' | 'unacceptable'; // AIAG <10 / 10–30 / >30（%SV）
  /** 交互项检验及最终模型选择；单操作员研究无交互项，为 null。删除阈值与 Minitab 一致为 0.05。 */
  interaction: {
    alpha: number;
    fStat: number;
    pValue: number;
    retained: boolean;
  } | null;
  /** 可区分的类别数 floor(√(2σ²部件/σ²GRR))，下限 1；σ²GRR=0 时为 Infinity。 */
  ndc: number;
  /** 全部观测的总均值（原始单位；单侧 %公差的分母基准）。 */
  grandMean: number;
  partCount: number;
  operatorCount: number;
  trialCount: number;
  /** 实际使用的公差口径（回显给报告层）。 */
  tolerance: GageToleranceSpec | null;
  /** 单侧公差守卫说明；正常时为 null。 */
  toleranceNote: string | null;
}

interface ValidatedGageStudy {
  data: GageObservation[];
  partCount: number;
  operatorCount: number;
  trialCount: number;
}

function validateTolerance(tolerance: GageToleranceSpec | null): void {
  if (tolerance == null) return;
  if (tolerance.mode !== 'width' && tolerance.mode !== 'upper' && tolerance.mode !== 'lower') {
    throw new RangeError('量具 R&R 公差口径必须是 width / upper / lower');
  }
  if (!Number.isFinite(tolerance.value)) {
    throw new RangeError('量具 R&R 公差必须是有限数值');
  }
  if (tolerance.mode === 'width' && tolerance.value <= 0) {
    throw new RangeError('量具 R&R 双侧公差宽度必须大于 0');
  }
}

/**
 * ANOVA 法要求每个“部件 × 操作员”单元都包含同一组重复试验，且每个
 * “部件 × 操作员 × 试验”组合恰好出现一次。GageObservation 的编号契约
 * 为 0-based，因此三类编号也必须连续，不能靠最大编号静默补出空水平。
 * 操作员数允许为 1（单操作员研究）；部件与重复试验仍须 ≥2。
 */
function validateGageStudy(data: GageObservation[], tolerance: GageToleranceSpec | null): ValidatedGageStudy {
  validateTolerance(tolerance);
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
  if (partIds.length < 2 || operatorIds.length < 1 || trialIds.length < 2) {
    throw new Error('量具 R&R 至少需要 2 个部件、1 名操作员（单操作员研究）和 2 次重复试验');
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
 * 量具 R&R ANOVA 法（交叉设计；操作员数=1 时退化为单因子随机效应模型）。
 *
 * 多操作员：部件×操作员交互项 p >= 0.05 时按标准缩减模型将交互项 SS/df 合并到
 * 重复性误差；显著时保留交互方差分量。单操作员：GRR=重复性，无再现性。
 * 公差为 null 时仍计算研究变异，%Tolerance 明确返回 null。
 */
export function computeGageRR(data: GageObservation[], tolerance: GageToleranceSpec | null): GageResult {
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
  // 主 ANOVA 的归一化方差路径保持原口径；仅对外展示/单侧公差共用稳定总均值。
  const grand = normalized.reduce((sum, value) => sum + value, 0) / N;
  const grandMean = mean(observations.map((observation) => observation.value));

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
  const msPart = ssPart / (p - 1);
  const varianceScale = scale * scale;
  const restoreVariance = (value: number) => value === 0 ? 0 : value * varianceScale;

  let vRepeat: number;
  let vOper: number;
  let vInter: number;
  let vPart: number;
  let interaction: GageResult['interaction'];

  if (o === 1) {
    // 单操作员：部件为唯一因子的单因子随机效应 ANOVA（Minitab 允许操作员留空并使用 ANOVA 法）。
    const ssError = observations.reduce((sum, observation, index) => (
      sum + (normalized[index] - partMean[observation.part]) ** 2
    ), 0);
    const dfError = p * (r - 1);
    const msError = ssError / dfError;
    vRepeat = restoreVariance(Math.max(0, msError));
    vOper = 0;
    vInter = 0;
    vPart = restoreVariance(Math.max(0, (msPart - msError) / r));
    interaction = null;
  } else {
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
    vRepeat = restoreVariance(Math.max(0, modelErrorMs));
    vInter = retainInteraction
      ? restoreVariance(Math.max(0, (msInter - msError) / r))
      : 0;
    vOper = restoreVariance(Math.max(0, (msOper - modelDenominatorMs) / (p * r)));
    vPart = restoreVariance(Math.max(0, (msPart - modelDenominatorMs) / (o * r)));
    interaction = {
      alpha: interactionAlpha,
      fStat: interactionF,
      pValue: interactionP,
      retained: retainInteraction,
    };
  }

  const vReprod = vOper + vInter;
  const vGRR = vRepeat + vReprod;
  const vTotal = vGRR + vPart;
  if (!Number.isFinite(vTotal)) throw new Error('量具 R&R 无法得到有限的合计变异');
  if (vTotal <= 0) throw new Error('量具 R&R 合计变异为 0，无法计算变异占比');

  // 公差分母：双侧为宽度(系数 6)；单侧为限值到总均值的距离(系数 3,Minitab 单边公式)。
  // 守卫：总均值已达到或越过单侧限时距离非正，%公差无意义，明确拒绝而不是输出负值/无穷。
  let tolDenominator: number | null = null;
  let tolFactor = 6;
  let toleranceNote: string | null = null;
  if (tolerance != null) {
    if (tolerance.mode === 'width') {
      tolDenominator = tolerance.value;
    } else {
      const distance = tolerance.mode === 'upper' ? tolerance.value - grandMean : grandMean - tolerance.value;
      const limitLabel = tolerance.mode === 'upper' ? '上限' : '下限';
      // 守卫阈值必须是纯相对量:带绝对下限(如 1)会按量纲误伤大基值(GHz 级)与小基值(nF/ppb 级)
      // 的真实可测距离;这里只拦真实为 0/负的距离和双精度抵消噪声(≈32 ulp)。
      const noise = 32 * Number.EPSILON * Math.max(Math.abs(tolerance.value), Math.abs(grandMean));
      if (!(distance > noise)) {
        toleranceNote = distance > 0
          ? `公差${limitLabel} ${tolerance.value} 与数据总均值 ${grandMean} 的距离已在浮点噪声量级，单侧 %公差无意义，未计算`
          : `数据总均值 ${grandMean} 已达到或越过公差${limitLabel} ${tolerance.value}，单侧 %公差无意义，未计算`;
      } else {
        tolDenominator = distance;
        tolFactor = 3;
      }
    }
  }

  const sTotal = Math.sqrt(vTotal);
  const mk = (key: GageComponentKey, source: string, depth: 0 | 1 | 2, v: number): GageComponent => {
    const sd = Math.sqrt(v);
    return {
      key,
      source,
      depth,
      variance: v,
      sd,
      studyVar: 6 * sd,
      pctContribution: (v / vTotal) * 100,
      pctStudyVar: (sd / sTotal) * 100,
      pctTolerance: tolDenominator == null ? null : ((tolFactor * sd) / tolDenominator) * 100,
    };
  };

  const components: GageComponent[] = [
    mk('grr', '合计量具 R&R', 0, vGRR),
    mk('repeatability', '  重复性', 1, vRepeat),
    ...(o > 1 ? [
      mk('reproducibility', '  再现性', 1, vReprod),
      mk('operator', '    操作员', 2, vOper),
      ...(interaction?.retained ? [mk('interaction', '    部件×操作员', 2, vInter)] : []),
    ] : []),
    mk('part', '部件间', 0, vPart),
    mk('total', '合计变异', 0, vTotal),
  ];

  const totalGageRR = (Math.sqrt(vGRR) / sTotal) * 100;
  const ndc = vGRR > 0 ? Math.max(1, Math.floor(Math.sqrt((2 * vPart) / vGRR))) : Infinity;
  return {
    totalGageRR,
    components,
    verdict: totalGageRR < 10 ? 'acceptable' : totalGageRR <= 30 ? 'marginal' : 'unacceptable',
    interaction,
    ndc,
    grandMean,
    partCount: p,
    operatorCount: o,
    trialCount: r,
    tolerance: tolerance == null ? null : { ...tolerance },
    toleranceNote,
  };
}

// ---------- 判定标准（计算与判定分离；引擎 verdict 保持 AIAG 兼容） ----------

/** 判定标准：factory=工厂口径(≤10 理想/≤20 可接受,对 %SV 与 %Tol 双指标取较差)；aiag=AIAG(<10/10–30/>30,对 %SV)。 */
export type GageStandard = 'factory' | 'aiag';
export type GageGrade = 'good' | 'warn' | 'bad';

export interface GageAssessment {
  standard: GageStandard;
  grade: GageGrade;
  /** 主结论短语：理想/可接受/不可接受(工厂) 或 可接受/临界/不可接受(AIAG) */
  label: string;
  /** 判定依据一句话（含所用指标与阈值） */
  detail: string;
  /** 工厂口径下是否纳入了 %公差次要指标（无公差时 false 并在 detail 注明） */
  judgedOnTolerance: boolean;
  /** 规格状态异常（单侧公差被守卫拒绝）导致双指标判定无法完成：红色阻断,不给绿色结论。 */
  blocked?: boolean;
}

const FACTORY_LABELS: Record<GageGrade, string> = { good: '理想', warn: '可接受', bad: '不可接受' };

function factoryBand(pct: number): GageGrade {
  return pct <= 10 ? 'good' : pct <= 20 ? 'warn' : 'bad';
}

const GRADE_ORDER: Record<GageGrade, number> = { good: 0, warn: 1, bad: 2 };

export function assessGage(result: GageResult, standard: GageStandard): GageAssessment {
  const grr = result.components.find((component) => component.key === 'grr');
  const pctSv = result.totalGageRR;
  const pctTol = grr?.pctTolerance ?? null;
  if (standard === 'factory') {
    if (pctTol == null && result.tolerance != null && result.toleranceNote != null) {
      // P0(Codex 复审):均值已达/越过单侧限时,%公差无法计算,工厂双指标判定不能完成——
      // 必须红色阻断,不能退化成「仅按 %研究变异」给出绿色「理想」。
      return {
        standard,
        grade: 'bad',
        label: '不能判定',
        detail: `规格状态异常：${result.toleranceNote}。工厂标准要求主要(%研究变异)与次要(%公差)双指标，次要指标无法计算，判定不能完成；请检查单侧规格限设置或改用双侧宽度。主要结果 %研究变异=${pctSv.toFixed(2)}% 仅供参考。`,
        judgedOnTolerance: false,
        blocked: true,
      };
    }
    const svBand = factoryBand(pctSv);
    const tolBand = pctTol == null ? null : factoryBand(pctTol);
    const grade = tolBand == null ? svBand
      : GRADE_ORDER[tolBand] > GRADE_ORDER[svBand] ? tolBand : svBand;
    const svText = `主要结果 %研究变异=${pctSv.toFixed(2)}%`;
    // pctTol 为 null 有两个来源:根本没给公差 vs 单侧守卫拒绝——不能都说成「未提供」
    const tolText = pctTol != null
      ? `次要结果 %公差=${pctTol.toFixed(2)}%`
      : result.toleranceNote != null
        ? '次要结果（%公差）未计算：单侧公差与总均值的距离无效（见公差说明），判定仅依据主要结果'
        : '次要结果（%公差）未计算：未提供过程公差';
    return {
      standard,
      grade,
      label: FACTORY_LABELS[grade],
      detail: `${svText}；${tolText}（工厂标准：≤10% 理想，≤20% 可接受，取两项较差）`,
      judgedOnTolerance: pctTol != null,
    };
  }
  const grade: GageGrade = pctSv < 10 ? 'good' : pctSv <= 30 ? 'warn' : 'bad';
  return {
    standard,
    grade,
    label: grade === 'good' ? '可接受' : grade === 'warn' ? '临界' : '不可接受',
    detail: `合计量具 R&R %研究变异=${pctSv.toFixed(2)}%（AIAG：<10% 可接受，10–30% 临界，>30% 不可接受）`,
    judgedOnTolerance: false,
  };
}

// ---------- 图形面板数据（页面与专项报告共用的纯计算） ----------

export interface GagePanelData {
  partCount: number;
  operatorCount: number;
  trialCount: number;
  /** cellMeans[operator][part]、cellRanges[operator][part]（按操作员分组的绘图序） */
  cellMeans: number[][];
  cellRanges: number[][];
  partMeans: number[];
  operatorMeans: number[];
  /** 按(操作员,部件,试验序)排列的原始观测值 values[operator][part][trial] */
  values: number[][][];
  grandMean: number;
  rBar: number;
  /** R 图控制限（D3/D4·R̄，n=trialCount）；常数表不覆盖时为 null */
  rLimits: { cl: number; ucl: number; lcl: number } | null;
  /** Xbar 图控制限（X̄̄ ± A2·R̄） */
  xbarLimits: { cl: number; ucl: number; lcl: number } | null;
}

/** 供 4/6 联图使用的胞均值/极差与 R̄/A2/D3/D4 控制限。constants 传 CONTROL_CONSTANTS[trialCount]。 */
export function computeGagePanelData(
  data: GageObservation[],
  constants: { A2: number; D3: number; D4: number } | null,
): GagePanelData {
  const validated = validateGageStudy(data, null);
  const p = validated.partCount;
  const o = validated.operatorCount;
  const r = validated.trialCount;
  const values: number[][][] = Array.from({ length: o }, () =>
    Array.from({ length: p }, () => new Array<number>(r).fill(NaN)));
  for (const observation of validated.data) {
    values[observation.operator][observation.part][observation.trial] = observation.value;
  }
  const cellMeans = values.map((byPart) => byPart.map((trials) => mean(trials)));
  // 不用 Math.max(...展开):重复次数极大时展开会栈溢出(本库既有教训),循环求极差
  const cellRanges = values.map((byPart) => byPart.map((trials) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const value of trials) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    return hi - lo;
  }));
  const partMeans = Array.from({ length: p }, (_, part) => mean(cellMeans.map((byPart) => byPart[part])));
  const operatorMeans = cellMeans.map((byPart) => mean(byPart));
  const grandMean = mean(validated.data.map((observation) => observation.value));
  const rBar = mean(cellRanges.flat());
  const rLimits = constants ? { cl: rBar, ucl: constants.D4 * rBar, lcl: constants.D3 * rBar } : null;
  const xbarLimits = constants
    ? { cl: grandMean, ucl: grandMean + constants.A2 * rBar, lcl: grandMean - constants.A2 * rBar }
    : null;
  return {
    partCount: p,
    operatorCount: o,
    trialCount: r,
    cellMeans,
    cellRanges,
    partMeans,
    operatorMeans,
    values,
    grandMean,
    rBar,
    rLimits,
    xbarLimits,
  };
}
