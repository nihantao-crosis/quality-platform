import type { VarModel } from './model';
import type { GageObservation } from './gage';

export interface GageTextColumn {
  name: string;
  values: string[];
}

/** 操作员角色哨兵：显式声明「单操作员研究，不选操作员列」（Minitab 允许操作员留空）。 */
export const GAGE_SINGLE_OPERATOR = '__single_operator__';

export interface GageStudySelection {
  valueColumn: string | null;
  partColumn: string | null;
  /** 列名 / GAGE_SINGLE_OPERATOR（单操作员，无列） / null（用推荐或位置默认） */
  operatorColumn: string | null;
  pendingCells?: Array<{ row: number; col: number }>;
}

export interface PreparedGageStudy {
  observations: GageObservation[];
  valueName: string;
  partName: string;
  /** 单操作员且未选列时为 null。 */
  operatorName: string | null;
  partLabels: string[];
  operatorLabels: string[];
  repeats: number;
}

export interface GageCategoryColumn {
  name: string;
  source: 'numeric' | 'text';
}

/**
 * 工作表列显示精度（小数位）。
 * 按「列」量级自适应 3–6 位——混合量纲数据（如 过盈量 0.0675 与 压入力 1350 同表）
 * 不能用全局 σ，否则小量纲列被压到 3 位显示成 0.068，造成“数据被改”的误解。
 * 全整数列（部件/操作员等 ID 列，含常数列）返回 0，显示 1/2/3 而非 1.000，
 * 与 Minitab 一致；悬停提示仍显示全精度原值，不影响存储。
 */
export function columnDisplayDp(values: number[]): number {
  if (values.length === 0) return 3;
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let allInt = true;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += Math.abs(v);
    if (allInt && !Number.isInteger(v)) allInt = false;
  }
  if (allInt) return 0;
  const scale = Math.max(hi - lo, (sum / values.length) * 0.01, 1e-9); // 列内变差，退化时用量级的 1%
  return Math.max(3, Math.min(6, 2 - Math.floor(Math.log10(scale))));
}

/** 众数胞观测次数：缺胞报错时以“其余胞”的典型重复次数说明缺了几次。 */
function modalCellCount(counts: number[]): number {
  const freq = new Map<number, number>();
  for (const count of counts) freq.set(count, (freq.get(count) ?? 0) + 1);
  let best = 2;
  let bestFreq = -1;
  for (const [count, f] of freq) {
    if (f > bestFreq || (f === bestFreq && count > best)) {
      best = count;
      bestFreq = f;
    }
  }
  return best;
}

interface ResolvedGageCategoryColumn extends GageCategoryColumn {
  values: string[];
  numericIndex: number | null;
}

/**
 * 部件/操作员是“类别角色”，不是“文本类型”。数字 ID 列也必须能被
 * 显式选为类别，但当前测量列不能同时充当类别角色。文本列排在前面，
 * 保持历史“1 测量列 + 2 文本分组列”的默认选择。
 */
function resolvedGageCategoryColumns(
  model: VarModel,
  textCols: GageTextColumn[],
  valueColumn: string | null,
): ResolvedGageCategoryColumn[] {
  const requestedValueIndex = valueColumn ? model.colNames.indexOf(valueColumn) : -1;
  // 尚未选测量列时不能偷偷把第一数值列从类别候选中排除。
  // 这个“位置默认”会让全小整数/ID 表看起来像已选了测量列。
  const valueIndex = requestedValueIndex >= 0 ? requestedValueIndex : -1;
  const text: ResolvedGageCategoryColumn[] = textCols.map((column) => ({
    name: column.name,
    source: 'text',
    values: column.values.map((value) => value.trim()),
    numericIndex: null,
  }));
  const numeric: ResolvedGageCategoryColumn[] = model.colNames.flatMap((name, index) => index === valueIndex ? [] : [{
    name,
    source: 'numeric' as const,
    values: model.subs.map((row) => Object.is(row.vals[index], -0) ? '0' : String(row.vals[index])),
    numericIndex: index,
  }]);
  return [...text, ...numeric];
}

export function listGageCategoryColumns(
  model: VarModel,
  textCols: GageTextColumn[],
  valueColumn: string | null,
): GageCategoryColumn[] {
  return resolvedGageCategoryColumns(model, textCols, valueColumn).map(({ name, source }) => ({ name, source }));
}

// ---------- 批次716-R3 P1-2:MSA 默认角色推荐(可解释打分) ----------

export interface GageRoleRecommendation {
  value: string | null;
  part: string | null;
  operator: string | null;
  /** 兼容旧调用点的安全兜底。多个有效测量候选并列时必须为 null，要求用户明确选择；
   * 绝不能再按位置落到第一数值列。 */
  valueFallback: string | null;
  /** 推荐依据(给 UI 小字展示):每个已推荐角色一条,外加交叉结构一条 */
  reasons: string[];
}

/** 列名关键词(命中即强加分)。全部按小写匹配,中文原样匹配。 */
const VALUE_KEYWORDS = ['测量', '值', '实测', '读数', '高度', '直径', '长度', '宽度', '厚度', '重量', '尺寸', '深度', '硬度', '温度', '压力', '扭矩', '粗糙度', 'value', 'meas', 'height', 'dia', 'length', 'width', 'thickness', 'weight', 'hardness', 'size'];
const PART_KEYWORDS = ['部件', '零件', '工件', '样品', '样件', '试样', 'part', 'piece', 'sample', 'item', 'unit'];
const OPERATOR_KEYWORDS = ['操作员', '操作者', '测试人', '检验员', '作业员', '测量员', '检测员', '评价人', 'operator', 'tester', 'inspector', 'appraiser', 'technician'];

const hitKeyword = (name: string, keywords: string[]) => {
  const lower = name.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
};

interface RoleCandidate {
  name: string;
  kind: 'numeric' | 'text';
  labels: string[]; // 行级标签(数值列为字符串化的值)
  unique: number;
  balanced: boolean; // 每个水平出现次数相等
  allInt: boolean; // 数值列专用;文本列恒 false
  hasDecimals: boolean;
}

function candidateOf(name: string, kind: 'numeric' | 'text', labels: string[], numericValues: number[] | null): RoleCandidate {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let lo = Infinity;
  let hi = -Infinity;
  for (const count of counts.values()) {
    if (count < lo) lo = count;
    if (count > hi) hi = count;
  }
  const allInt = numericValues != null && numericValues.length > 0 && numericValues.every((v) => Number.isInteger(v));
  return {
    name,
    kind,
    labels,
    unique: counts.size,
    balanced: counts.size > 0 && lo === hi,
    allInt,
    hasDecimals: numericValues != null && !allInt,
  };
}

/** 测量角色打分:列名关键词 > 数值连续性(含小数、唯一值多);小整数 ID 形态倒扣。 */
function valueScore(col: RoleCandidate, n: number): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  if (hitKeyword(col.name, VALUE_KEYWORDS)) { score += 6; why.push('列名含测量特征词'); }
  if (col.hasDecimals) { score += 3; why.push('含小数'); }
  if (n > 0 && col.unique / n >= 0.5) { score += 2; why.push('唯一值多'); }
  if (col.allInt && col.unique < n / 2) { score -= 3; } // 小整数重复形态更像 ID,不像连续测量
  return { score, why };
}

/** 部件/操作员共用的类别形态分:小数连续列不适合当类别;水平重复均衡加分。 */
function categoryBaseScore(col: RoleCandidate, n: number): { score: number; why: string[] } {
  const why: string[] = [];
  let score = col.kind === 'text' ? 1 : 0;
  if (col.kind === 'numeric') score += col.hasDecimals ? -4 : 1;
  if (col.unique >= 2 && col.unique <= n / 2 && col.balanced) {
    score += 2;
    why.push(`${col.unique} 个水平重复均衡`);
  }
  if (col.unique === 1) score -= 1; // 单水平可当角色占位,但结构证据弱
  if (col.unique > n / 2 && n >= 4) score -= 3; // 几乎逐行不同,当不了类别
  return { score, why };
}

function partScore(col: RoleCandidate, n: number): { score: number; why: string[] } {
  const base = categoryBaseScore(col, n);
  const why = [...base.why];
  let score = base.score;
  if (hitKeyword(col.name, PART_KEYWORDS)) { score += 6; why.unshift('列名含部件特征词'); }
  if (col.unique >= 4) score += 1; // MSA 常规:部件水平数多于操作员
  return { score, why };
}

function operatorScore(col: RoleCandidate, n: number): { score: number; why: string[] } {
  const base = categoryBaseScore(col, n);
  const why = [...base.why];
  let score = base.score;
  if (hitKeyword(col.name, OPERATOR_KEYWORDS)) { score += 6; why.unshift('列名含操作员特征词'); }
  if (col.unique >= 2 && col.unique <= 4) score += 1; // 操作员通常 2–4 人
  return { score, why };
}

/** (part,operator) 交叉结构:每胞行数相等且 ≥1(平衡交叉设计)加分。 */
function crossBalance(part: RoleCandidate, operator: RoleCandidate): number | null {
  const cells = new Map<string, number>();
  for (let row = 0; row < part.labels.length; row++) {
    const key = `${part.labels[row]}\u0000${operator.labels[row]}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  if (cells.size !== part.unique * operator.unique) return null;
  let repeats = -1;
  for (const count of cells.values()) {
    if (repeats < 0) repeats = count;
    else if (count !== repeats) return null;
  }
  return repeats >= 1 ? repeats : null;
}

/**
 * MSA 默认角色推荐:对「测量/部件/操作员」三个角色做可解释打分,返回推荐列名与依据。
 * 只做预填——UI 仍以用户手动选择优先;信号不足或并列时对应角色明确返回 null,不瞎猜。
 * 背景:工厂列序「部件、测试人、螺钉高度」曾被列序默认(第一数值列当测量)推荐反(716-R3 P1-2)。
 */
export function recommendGageRoles(model: VarModel, textCols: GageTextColumn[]): GageRoleRecommendation {
  const n = model.k;
  const numeric: RoleCandidate[] = model.colNames.map((name, index) => {
    const values = model.subs.map((row) => row.vals[index]);
    return candidateOf(name, 'numeric', values.map((v) => Object.is(v, -0) ? '0' : String(v)), values);
  });
  const text: RoleCandidate[] = textCols.map((column) =>
    candidateOf(column.name, 'text', column.values.map((value) => value.trim()), null));
  const all = [...text, ...numeric]; // 与 resolvedGageCategoryColumns 一致:文本列在前
  if (numeric.length === 0 || n === 0) return { value: null, part: null, operator: null, valueFallback: null, reasons: [] };

  // 数值列也可能是部件/操作员/ID。除非列名明确给出测量语义，
  // “小整数 + 少量重复水平”不参与自动测量列选择。用户仍可以显式选它作离散测量。
  const categoryShaped = (col: RoleCandidate) => {
    const valueNamed = hitKeyword(col.name, VALUE_KEYWORDS);
    if (valueNamed) return false;
    if (hitKeyword(col.name, PART_KEYWORDS) || hitKeyword(col.name, OPERATOR_KEYWORDS)) return true;
    return col.allInt && col.unique <= Math.max(2, n / 2);
  };

  // 1) 测量列:数值列中独立打分;最高分并列则不猜。
  // 唯一数值列也只在它不呈类别/ID 形态时自动锁定。
  const valueScored = numeric.map((col) => ({ col, ...valueScore(col, n) }));
  const valueEligible = valueScored.filter((entry) => !categoryShaped(entry.col));
  let valuePick: { col: RoleCandidate; score: number; why: string[] } | null = null;
  if (numeric.length === 1 && valueEligible.length === 1) {
    valuePick = { ...valueEligible[0], why: ['唯一数值列（非 ID 形态）', ...valueEligible[0].why] };
  } else if (valueEligible.length > 0) {
    const best = Math.max(...valueEligible.map((s) => s.score));
    const top = valueEligible.filter((s) => s.score === best);
    if (top.length === 1 && best > 0) valuePick = top[0];
  }

  // 1b) 不再提供“取第一个有效列”的位置兜底。若多个测量候选并列，保持 null；
  // 这是批量工作表的正常引导态，而不是让系统替用户决定量纲。
  const valueFallback: string | null = valuePick ? valuePick.col.name : null;

  // 2) 部件/操作员:在测量列之外的候选里按角色独立打分,再用交叉结构定夺方向
  const effectiveValueCol = valuePick?.col ?? numeric.find((col) => col.name === valueFallback) ?? null;
  const categories = all.filter((col) => !effectiveValueCol || col !== effectiveValueCol);
  const partScored = categories.map((col) => ({ col, ...partScore(col, n) }));
  const operScored = categories.map((col) => ({ col, ...operatorScore(col, n) }));
  let bestPair: { part: typeof partScored[number]; oper: typeof operScored[number]; total: number; repeats: number | null } | null = null;
  for (const p of partScored) {
    if (p.score <= 0) continue;
    for (const o of operScored) {
      if (o.score <= 0 || o.col === p.col) continue;
      const repeats = crossBalance(p.col, o.col);
      const total = p.score + o.score + (repeats != null ? 3 : 0);
      if (!bestPair || total > bestPair.total) bestPair = { part: p, oper: o, total, repeats };
    }
  }
  // 并列不猜:存在得分相同但列分配不同的组合时,部件/操作员都返回 null
  if (bestPair) {
    const b = bestPair;
    const tied = partScored.some((p) => p.score > 0 && operScored.some((o) => {
      if (o.score <= 0 || o.col === p.col) return false;
      if (p.col === b.part.col && o.col === b.oper.col) return false; // 跳过最优组合本身
      return p.score + o.score + (crossBalance(p.col, o.col) != null ? 3 : 0) === b.total;
    }));
    if (tied) bestPair = null;
  }

  const reasons: string[] = [];
  if (valuePick) reasons.push(`测量=「${valuePick.col.name}」(${valuePick.why.join('、')})`);
  else if (valueEligible.length > 0) reasons.push('未自动选择测量列(多个有效测量候选并列,请手动选择)');
  else reasons.push('未自动选择测量列(所有数值列均呈小整数/类别 ID 形态,请手动选择)');
  if (bestPair) {
    reasons.push(`部件=「${bestPair.part.col.name}」(${bestPair.part.why.join('、') || '类别形态'})`);
    reasons.push(`操作员=「${bestPair.oper.col.name}」(${bestPair.oper.why.join('、') || '类别形态'})`);
    if (bestPair.repeats != null) reasons.push(`部件×操作员交叉平衡(每胞 ${bestPair.repeats} 次)`);
  }
  return {
    value: valuePick ? valuePick.col.name : null,
    part: bestPair ? bestPair.part.col.name : null,
    operator: bestPair ? bestPair.oper.col.name : null,
    valueFallback,
    reasons,
  };
}

/**
 * 把活动工作表解析为完整、平衡的交叉 Gage R&R 研究。
 * 页面、保存摘要和专项导出共用此入口，避免各自猜列或把占位 0 当实测值。
 */
/** 「生效 Gage 角色」单一来源(批次716-R3 收口):store 手选优先,否则用可解释推荐
 * (推荐与生效测量列撞车时作废；测量候选并列时保持未选，禁止退回第一数值列)。
 * MSA 页、壳层状态栏、保存记录与专项报告都必须经此函数,否则用户未手选时
 * 页面按推荐算、其他路径按列序算,同一数据两种角色口径。 */
export function effectiveGageSelection(
  model: VarModel,
  textCols: GageTextColumn[],
  stored: { value: string | null; part: string | null; operator: string | null },
): { valueColumn: string | null; partColumn: string | null; operatorColumn: string | null } {
  const rec = recommendGageRoles(model, textCols);
  const valueColumn = stored.value ?? rec.value ?? rec.valueFallback;
  const namedValueIndex = valueColumn ? model.colNames.indexOf(valueColumn) : -1;
  const selectedValueName = namedValueIndex >= 0 ? model.colNames[namedValueIndex] : null;
  const recPart = rec.part !== selectedValueName ? rec.part : null;
  const recOperator = rec.operator !== selectedValueName ? rec.operator : null;
  return {
    valueColumn,
    partColumn: stored.part ?? recPart,
    operatorColumn: stored.operator ?? recOperator,
  };
}

export function prepareGageStudy(
  model: VarModel,
  textCols: GageTextColumn[],
  selection: GageStudySelection,
): { ok: true; study: PreparedGageStudy } | { ok: false; reason: string } {
  if (model.colNames.length < 1) {
    return { ok: false, reason: '真实 Gage R&R 需要至少 1 个数值测量列' };
  }
  const recommended = selection.valueColumn == null ? recommendGageRoles(model, textCols) : null;
  const resolvedValueName = selection.valueColumn ?? recommended?.value ?? recommended?.valueFallback ?? null;
  if (!resolvedValueName) {
    const tied = recommended?.reasons.some((reason) => reason.includes('多个有效测量候选并列'));
    return { ok: false, reason: tied
      ? '请选择测量列：当前有多个有效测量候选并列，系统无法可靠判断量纲，不会默认使用第一列'
      : '请选择测量列：当前数值列均呈小整数/类别 ID 形态，系统不会默认把第一列当作测量值' };
  }
  const namedValue = model.colNames.indexOf(resolvedValueName);
  if (namedValue < 0) {
    return { ok: false, reason: `已选测量列“${resolvedValueName}”已不存在` };
  }
  const valueIndex = namedValue;
  const singleOperator = selection.operatorColumn === GAGE_SINGLE_OPERATOR;
  const categories = resolvedGageCategoryColumns(model, textCols, model.colNames[valueIndex]);
  if (categories.length < (singleOperator ? 1 : 2)) {
    return { ok: false, reason: singleOperator
      ? '真实 Gage R&R 除测量列外还需要 1 个部件类别列；类别可以是数字 ID 或文本'
      : '真实 Gage R&R 除测量列外还需要 2 个类别列（部件、操作员）；类别可以是数字 ID 或文本，单操作员研究可将操作员选为「无（单操作员）」' };
  }
  const resolveCategory = (requested: string | null, fallback: number) => {
    if (!requested) return categories[fallback] ?? null;
    const found = categories.find((column) => column.name === requested) ?? null;
    if (!found && requested === model.colNames[valueIndex]) return null;
    return found;
  };
  const partColumn = resolveCategory(selection.partColumn, 0);
  const operatorColumn = singleOperator ? null : resolveCategory(selection.operatorColumn, 1);
  if (!partColumn || (!singleOperator && !operatorColumn)) {
    const role = !partColumn ? '部件' : '操作员';
    const requested = !partColumn ? selection.partColumn : selection.operatorColumn;
    return { ok: false, reason: requested === model.colNames[valueIndex]
      ? `测量列不能同时作为${role}列`
      : `已选${role}列“${requested ?? ''}”已不存在` };
  }
  if (operatorColumn && partColumn.name === operatorColumn.name) return { ok: false, reason: '部件列与操作员列不能相同' };

  const selectedNumericIndices = new Set([
    valueIndex,
    partColumn.numericIndex,
    operatorColumn?.numericIndex ?? null,
  ].filter((index): index is number => index != null));
  const pending = (selection.pendingCells ?? []).filter((cell) =>
    cell.row >= 0 && cell.row < model.k && selectedNumericIndices.has(cell.col)).length;
  if (pending > 0) return { ok: false, reason: `所选 Gage 角色列还有 ${pending} 个待录入单元格` };

  const parts = partColumn.values;
  const operators = operatorColumn ? operatorColumn.values : new Array<string>(model.k).fill('单操作员');
  if (parts.length !== model.k || operators.length !== model.k) {
    return { ok: false, reason: '部件/操作员列的行数必须与测量列一致' };
  }
  const partValues = parts.map((value) => value.trim());
  const operatorValues = operators.map((value) => value.trim());
  if (partValues.some((value) => !value) || operatorValues.some((value) => !value)) {
    return { ok: false, reason: '部件/操作员列不能包含空白标签' };
  }
  // 部件/操作员水平排序与 Minitab 一致:数值型按数值升序,文本按中文拼音
  // (工厂案例的控制图分段与交互图例即按 谷春莉<韦小星<邹德玉 拼音序,不是数据出现序)。
  const sortRoleLabels = (labels: string[]): string[] => {
    const numeric = labels.every((label) => label !== '' && !Number.isNaN(Number(label)));
    if (numeric) return [...labels].sort((a, b) => Number(a) - Number(b));
    return [...labels].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN-u-co-pinyin'));
  };
  const partLabels = sortRoleLabels([...new Set(partValues)]);
  // 单操作员研究合法(操作员列为常数或显式选「无」):退化为单因子模型,GRR=重复性,不估计再现性。
  const operatorLabels = sortRoleLabels([...new Set(operatorValues)]);
  if (partLabels.length < 2) {
    return { ok: false, reason: `仅检测到 1 个部件(${partLabels[0]}):交叉 Gage R&R 需 ≥2 个部件供各操作员重复测量;请补充其他部件数据` };
  }

  const cellRows = new Map<string, number[]>();
  for (let row = 0; row < model.k; row++) {
    const key = `${partValues[row]}\u0000${operatorValues[row]}`;
    const rows = cellRows.get(key) ?? [];
    rows.push(row);
    cellRows.set(key, rows);
  }
  const expectedCells = partLabels.length * operatorLabels.length;
  const counts = [...cellRows.values()].map((rows) => rows.length);
  if (cellRows.size !== expectedCells) {
    // 指名缺失的具体胞:工厂拿到「计算错误」必须能定位到该补哪个部件×操作员
    const modal = modalCellCount(counts);
    const missing: string[] = [];
    for (const part of partLabels) {
      for (const operator of operatorLabels) {
        if (!cellRows.has(`${part}\u0000${operator}`)) {
          missing.push(`部件「${part}」×操作员「${operator}」缺 ${modal} 次测量`);
        }
      }
    }
    const head = missing.slice(0, 3).join('、');
    const tail = missing.length > 3 ? `等共 ${missing.length} 个组合缺测` : '';
    const uniform = counts.every((count) => count === modal);
    return { ok: false, reason: `交叉设计不完整:${head}${tail}(其余胞${uniform ? '均' : '多'}为 ${modal} 次)` };
  }
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  if (minCount !== maxCount) {
    // 不等重复:列出最少/最多的具体胞,而不是笼统一句「必须相同」
    const describeCellWithCount = (target: number) => {
      for (const part of partLabels) {
        for (const operator of operatorLabels) {
          if (cellRows.get(`${part}\u0000${operator}`)!.length === target) {
            return `部件「${part}」×操作员「${operator}」(${target} 次)`;
          }
        }
      }
      return `(${target} 次)`;
    };
    return { ok: false, reason: `各胞重复测量次数不一致:最少为${describeCellWithCount(minCount)},最多为${describeCellWithCount(maxCount)};交叉 Gage R&R 要求所有部件×操作员组合重复次数相同且 ≥2` };
  }
  const repeats = minCount;
  if (repeats < 2) {
    return { ok: false, reason: `每个部件×操作员组合仅有 ${repeats} 次测量:交叉 Gage R&R 需每胞 ≥2 次重复测量;请对每个部件×操作员组合补测` };
  }

  const observations: GageObservation[] = [];
  for (let part = 0; part < partLabels.length; part++) {
    for (let operator = 0; operator < operatorLabels.length; operator++) {
      const rows = cellRows.get(`${partLabels[part]}\u0000${operatorLabels[operator]}`)!;
      rows.forEach((row, trial) => observations.push({
        part,
        operator,
        trial,
        value: model.subs[row].vals[valueIndex],
      }));
    }
  }
  return {
    ok: true,
    study: {
      observations,
      valueName: model.colNames[valueIndex],
      partName: partColumn.name,
      operatorName: operatorColumn ? operatorColumn.name : null,
      partLabels,
      operatorLabels,
      repeats,
    },
  };
}
