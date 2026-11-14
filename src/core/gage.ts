/**
 * Gage R&R — 交叉设计 ANOVA 法（AIAG / Minitab 口径）。
 * 补齐交接文档 core-skeleton/statistics.ts §6 的签名。
 *
 * v1.40（MSA 工厂案例验收批次）：
 * - 支持单操作员研究（操作员数=1 退化为单因子随机效应 ANOVA，GRR=重复性，无再现性分量）；
 * - 组件表增加 SD / 研究变异(6×SD) 字段与「操作员」「部件×操作员」分行，行结构与 Minitab 会话窗口同构；
 * - 新增可区分的类别数 ndc = floor(1.41×σ部件/σGRR(AIAG 常数))（下限 1）；
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
  /** 可区分的类别数 floor(1.41×σ部件/σGRR(AIAG 常数))，下限 1；σ²GRR=0 时为 Infinity。 */
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
  // ndc=∞ 是结构结论：同一部件在所有操作员/重复下的原始读数相同。
  // 不能用 uGRR/uTotal 的 epsilon 阈值推测，因为大部件跨度会让真实的
  // 重复/交互方差比例落到 epsilon 附近。
  const partReference = new Array<number>(p);
  const structurallyZeroGrr = observations.every((observation) => {
    const reference = partReference[observation.part];
    if (reference === undefined) {
      partReference[observation.part] = observation.value;
      return true;
    }
    return observation.value === reference;
  });
  // ANOVA 只依赖差值。必须先在全局坐标上缩放，再中心化：直接构造
  // value-origin 会让 [-MAX, +MAX] 这类端点全部有限的研究先产生 Infinity，
  // 从而丢失本来完全可计算的 F/p、%SV、%Contribution 和 ndc。坐标尺度取
  // 2 的整次幂，指数缩放不会平白丢掉大基值旁的有效尾数。
  const rawCoordinateScale = observations.reduce(
    (maximum, observation) => Math.max(maximum, Math.abs(observation.value)),
    0,
  );
  const coordinateScale = rawCoordinateScale === 0
    ? 1
    : 2 ** Math.min(1023, Math.floor(Math.log2(rawCoordinateScale)));
  const coordinates = observations.map((observation) => observation.value / coordinateScale);
  const origin = coordinates[0];
  const centered = coordinates.map((value) => value - origin);
  const localScale = centered.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (!(localScale > 0) || !Number.isFinite(localScale)) {
    throw new Error('量具 R&R 合计变异为 0，无法计算变异占比');
  }
  const normalized = centered.map((value) => value / localScale);
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
  // 量纲量只用于展示；无量纲判定始终使用上面的 u 分量。真实 SD/方差
  // 超过 Number 值域时饱和到最大有限数，不让 Infinity 污染会话表/导出。
  const finiteMagnitudeProduct = (left: number, right: number): number => {
    if (left === 0 || right === 0) return 0;
    const product = left * right;
    return Number.isFinite(product) ? product : Number.MAX_VALUE;
  };
  const restoreMagnitude = (value: number): number => finiteMagnitudeProduct(
    finiteMagnitudeProduct(value, localScale),
    coordinateScale,
  );
  const restoreVariance = (value: number): number => {
    if (value === 0) return 0;
    const sd = restoreMagnitude(Math.sqrt(value));
    return sd <= Math.sqrt(Number.MAX_VALUE) ? sd * sd : Number.MAX_VALUE;
  };

  let uRepeat: number;
  let uOper: number;
  let uInter: number;
  let uPart: number;
  let interaction: GageResult['interaction'];

  if (o === 1) {
    // 单操作员：部件为唯一因子的单因子随机效应 ANOVA（Minitab 允许操作员留空并使用 ANOVA 法）。
    const ssError = observations.reduce((sum, observation, index) => (
      sum + (normalized[index] - partMean[observation.part]) ** 2
    ), 0);
    const dfError = p * (r - 1);
    const msError = ssError / dfError;
    uRepeat = Math.max(0, msError);
    uOper = 0;
    uInter = 0;
    uPart = Math.max(0, (msPart - msError) / r);
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
    // 复审 P2:精确零判定拦不住浮点残渣——完全无测量变异的数据里 ssError/ssInter
    // 都是 1e-31 量级而非精确 0,于是判出「显著的部件×操作员交互」(F=33.33,p=0)。
    // 两者都必须按「相对于本研究的均方量级」判定。注意此处均方是**归一化后**的
    // (normalized = (全局缩放后坐标-原点)/localScale,见上方),量纲已被除掉,故 max(..., 1) 的兜底
    // 不影响单位不变性——与下方 ndc 判据所处的量纲不同,不要照搬。
    // 蜂群 P2-06:近零判断必须用**每个统计量自身的**浮点误差界,不能用「全体 MS 的最大值」——
    // 部件间效应通常比误差大 4~6 个数量级,用它当尺度会把真实的微小交互与误差一起抹成零
    // (复现:理论 F=20000、p≈3.4e-12 的显著交互被判成 F=0、p=1、retained=false、ndc=∞)。
    // 均值坐标误差是 O(N·epsilon)，但 SS/MS 累加的是**平方后**的离差，
    // 因而 SS 残渣界必须是 O(N·(N·epsilon)²)。直接用 N·epsilon 会吞掉
    // 相对 4e4 部件量程仅 1e-3 的真实交互以及 4e-4 的重复效应。
    const coordinateRoundoff = Number.EPSILON * N * 16;
    const ssNoiseBound = N * coordinateRoundoff * coordinateRoundoff;
    const errorNegligible = msError <= ssNoiseBound / Math.max(1, dfError);
    const interNegligible = msInter <= ssNoiseBound / Math.max(1, dfInter);
    if (structurallyZeroGrr) {
      interactionF = 0;
      interactionP = 1;
    } else if (errorNegligible) {
      interactionF = interNegligible ? 0 : Infinity;
      interactionP = interNegligible ? 1 : 0;
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
    uRepeat = Math.max(0, modelErrorMs);
    uInter = retainInteraction
      ? Math.max(0, (msInter - msError) / r)
      : 0;
    uOper = Math.max(0, (msOper - modelDenominatorMs) / (p * r));
    uPart = Math.max(0, (msPart - modelDenominatorMs) / (o * r));
    interaction = {
      alpha: interactionAlpha,
      fStat: interactionF,
      pValue: interactionP,
      retained: retainInteraction,
    };
  }

  // 原始单元格已证明 GRR 结构为零时，求均/相减留下的 1e-31 级均方
  // 只是浮点残渣。精确归零让组件表、交互检验与 ndc 表达同一结论。
  if (structurallyZeroGrr) {
    uRepeat = 0;
    uOper = 0;
    uInter = 0;
  }

  const uReprod = uOper + uInter;
  const uGRR = uRepeat + uReprod;
  const uTotal = uGRR + uPart;
  if (!Number.isFinite(uTotal)) throw new Error('量具 R&R 无法得到有限的合计变异');
  if (uTotal <= 0) throw new Error('量具 R&R 合计变异为 0，无法计算变异占比');
  const sTotalNormalized = Math.sqrt(uTotal);

  // 公差分母：双侧为宽度(系数 6)；单侧为限值到总均值的距离(系数 3,Minitab 单边公式)。
  // 守卫：总均值已达到或越过单侧限时距离非正，%公差无意义，明确拒绝而不是输出负值/无穷。
  // 公差分母也换算到与 ANOVA 相同的无量纲坐标，%Tolerance 因而不依赖
  // 可能上/下溢的原量纲 SD。
  const differenceOverScale = (a: number, b: number): number => (
    (a / coordinateScale - b / coordinateScale) / localScale
  );
  const magnitudeOverScale = (value: number): number => {
    const candidates = [
      (value / coordinateScale) / localScale,
      (value / localScale) / coordinateScale,
    ];
    return candidates.find((candidate) => Number.isFinite(candidate) && candidate > 0)
      ?? candidates.find((candidate) => candidate > 0)
      ?? 0;
  };
  let tolDenominatorNormalized: number | null = null;
  let tolFactor = 6;
  let toleranceNote: string | null = null;
  if (tolerance != null) {
    if (tolerance.mode === 'width') {
      const widthNormalized = magnitudeOverScale(tolerance.value);
      if (!(widthNormalized > 0)) {
        toleranceNote = `公差宽度 ${tolerance.value} 相对当前测量量程过小，换算后下溢为 0，% 公差无意义，未计算`;
      } else {
        tolDenominatorNormalized = widthNormalized;
      }
    } else {
      const distanceNormalized = tolerance.mode === 'upper'
        ? tolerance.value / coordinateScale - grandMean / coordinateScale
        : grandMean / coordinateScale - tolerance.value / coordinateScale;
      const limitLabel = tolerance.mode === 'upper' ? '上限' : '下限';
      // 守卫阈值必须是纯相对量:带绝对下限(如 1)会按量纲误伤大基值(GHz 级)与小基值(nF/ppb 级)
      // 的真实可测距离;这里只拦真实为 0/负的距离和双精度抵消噪声(≈32 ulp)。
      const noise = 32 * Number.EPSILON * Math.max(
        Math.abs(tolerance.value / coordinateScale),
        Math.abs(grandMean / coordinateScale),
      );
      if (!(distanceNormalized > noise)) {
        toleranceNote = distanceNormalized > 0
          ? `公差${limitLabel} ${tolerance.value} 与数据总均值 ${grandMean} 的距离已在浮点噪声量级，单侧 %公差无意义，未计算`
          : `数据总均值 ${grandMean} 已达到或越过公差${limitLabel} ${tolerance.value}，单侧 %公差无意义，未计算`;
      } else {
        tolDenominatorNormalized = tolerance.mode === 'upper'
          ? differenceOverScale(tolerance.value, grandMean)
          : differenceOverScale(grandMean, tolerance.value);
        tolFactor = 3;
      }
    }
  }

  // 公差本身是有限正数仍不足以保证百分比可表示：
  // Number.MIN_VALUE 之类宽度可使真实 %Tol 超出 Number 值域。工程上这不是
  // 可供判级的有限结果，因此整个 %Tol 列 fail-closed 为 null，而不输出 Infinity/NaN。
  if (tolDenominatorNormalized != null) {
    const maximumPctTolerance = (sTotalNormalized / tolDenominatorNormalized) * tolFactor * 100;
    if (!Number.isFinite(maximumPctTolerance)) {
      const toleranceLabel = tolerance?.mode === 'width'
        ? `公差宽度 ${tolerance.value}`
        : `公差${tolerance?.mode === 'upper' ? '上限' : '下限'} ${tolerance?.value}`;
      toleranceNote = `${toleranceLabel} 相对测量变异过小，% 公差将超出有限数值范围，未计算`;
      tolDenominatorNormalized = null;
    }
  }

  const mk = (key: GageComponentKey, source: string, depth: 0 | 1 | 2, u: number): GageComponent => {
    const sdNormalized = Math.sqrt(u);
    const sd = restoreMagnitude(sdNormalized);
    return {
      key,
      source,
      depth,
      variance: restoreVariance(u),
      sd,
      studyVar: finiteMagnitudeProduct(6, sd),
      pctContribution: (u / uTotal) * 100,
      pctStudyVar: (sdNormalized / sTotalNormalized) * 100,
      pctTolerance: tolDenominatorNormalized == null
        ? null
        : sdNormalized === 0
          ? 0
          : ((tolFactor * sdNormalized) / tolDenominatorNormalized) * 100,
    };
  };

  const components: GageComponent[] = [
    mk('grr', '合计量具 R&R', 0, uGRR),
    mk('repeatability', '  重复性', 1, uRepeat),
    ...(o > 1 ? [
      mk('reproducibility', '  再现性', 1, uReprod),
      mk('operator', '    操作员', 2, uOper),
      ...(interaction?.retained ? [mk('interaction', '    部件×操作员', 2, uInter)] : []),
    ] : []),
    mk('part', '部件间', 0, uPart),
    mk('total', '合计变异', 0, uTotal),
  ];

  const totalGageRR = (Math.sqrt(uGRR) / sTotalNormalized) * 100;
  // AIAG/Minitab 公布口径用 1.41(而非精确 √2):验收线上的 ndc 取整可能因此差一档
  // 复审 P2:uGRR 的浮点残渣(1e-31 量级)会让「σGRR=0 → ∞」这条分支在真实数据上永不可达,
  // 转而向用户呈现 2.4e15 这样的 16 位整数。改按相对量级判定。
  // 自审 P2:判据必须是**纯相对**的，现在直接使用归一化的 uGRR/uTotal；
  // 加 Math.max(uTotal, 1) 兜底会退化成绝对阈值，量纲不变性丢失:
  // 同一份研究以「米」记录 ndc=∞、以「毫米」记录 ndc=22。上方已有 uTotal<=0 的 throw,
  // 不需要下限兜底;真零变异数据的残渣距该阈值有 15 个数量级余量。
  // 蜂群 P2-06:只有**被证明为零**的 GRR 才返回 ∞。相对阈值仍取 uTotal(量纲不变),
  // 但收紧到机器精度量级——1e-12 会把「极小但真实」的 GRR 也抹掉。
  if (!structurallyZeroGrr && !(uGRR > 0)) {
    throw new Error('量具 R&R 检测到非零的组内测量差异，但方差分量下溢为 0，请先缩放数据单位');
  }
  // ∞ 只能由原始单元格的结构零产生；对非零研究不再用 epsilon×合计变异阈值。
  const ndc = structurallyZeroGrr
    ? Infinity
    : Math.max(1, Math.floor(1.41 * Math.sqrt(uPart / uGRR)));
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

const GAGE_PANEL_EXTREME_THRESHOLD = Number.MAX_VALUE / 16;

function gagePanelCoordinateScale(data: readonly GageObservation[]): number {
  let maximum = 0;
  for (const observation of data) {
    const magnitude = Math.abs(observation.value);
    if (magnitude > maximum) maximum = magnitude;
  }
  if (maximum <= GAGE_PANEL_EXTREME_THRESHOLD) return 1;
  return 2 ** Math.min(1023, Math.floor(Math.log2(maximum)));
}

function restoreGagePanelCoordinate(value: number, scale: number): number {
  if (Number.isNaN(value)) return Number.NaN;
  if (value === 0) return value;
  const restored = value * scale;
  if (Number.isFinite(restored)) return restored;
  return value < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

function gagePanelRange(values: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return hi - lo;
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
  // 极差、R̄ 和控制限在同一缩放域内聚合：单个 [-MAX,+MAX]
  // 胞极差可饱和展示，但不能先饱和再与其他胞求平均。
  const coordinateScale = gagePanelCoordinateScale(validated.data);
  const coordinateValues = coordinateScale === 1
    ? values
    : values.map((byPart) => byPart.map((trials) => (
        trials.map((value) => value / coordinateScale)
      )));
  const cellMeansCoordinate = coordinateValues.map((byPart) => byPart.map((trials) => mean(trials)));
  // 不用 Math.max(...展开):重复次数极大时展开会栈溢出(本库既有教训),循环求极差
  const cellRangesCoordinate = coordinateValues.map((byPart) => byPart.map(gagePanelRange));
  const cellMeans = cellMeansCoordinate.map((byPart) => byPart.map((value) => (
    restoreGagePanelCoordinate(value, coordinateScale)
  )));
  const cellRanges = cellRangesCoordinate.map((byPart) => byPart.map((value) => (
    restoreGagePanelCoordinate(value, coordinateScale)
  )));
  const partMeansCoordinate = Array.from(
    { length: p },
    (_, part) => mean(cellMeansCoordinate.map((byPart) => byPart[part])),
  );
  const operatorMeansCoordinate = cellMeansCoordinate.map((byPart) => mean(byPart));
  const grandMeanCoordinate = mean(
    validated.data.map((observation) => observation.value / coordinateScale),
  );
  const rBarCoordinate = mean(cellRangesCoordinate.flat());
  const partMeans = partMeansCoordinate.map((value) => restoreGagePanelCoordinate(value, coordinateScale));
  const operatorMeans = operatorMeansCoordinate.map((value) => restoreGagePanelCoordinate(value, coordinateScale));
  const grandMean = restoreGagePanelCoordinate(grandMeanCoordinate, coordinateScale);
  const rBar = restoreGagePanelCoordinate(rBarCoordinate, coordinateScale);
  const rLimits = constants ? {
    cl: rBar,
    ucl: restoreGagePanelCoordinate(constants.D4 * rBarCoordinate, coordinateScale),
    lcl: restoreGagePanelCoordinate(constants.D3 * rBarCoordinate, coordinateScale),
  } : null;
  const xbarLimits = constants
    ? {
        cl: grandMean,
        ucl: restoreGagePanelCoordinate(grandMeanCoordinate + constants.A2 * rBarCoordinate, coordinateScale),
        lcl: restoreGagePanelCoordinate(grandMeanCoordinate - constants.A2 * rBarCoordinate, coordinateScale),
      }
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
