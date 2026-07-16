import type { VarModel } from './model';
import type { GageObservation } from './gage';

export interface GageTextColumn {
  name: string;
  values: string[];
}

export interface GageStudySelection {
  valueColumn: string | null;
  partColumn: string | null;
  operatorColumn: string | null;
  pendingCells?: Array<{ row: number; col: number }>;
}

export interface PreparedGageStudy {
  observations: GageObservation[];
  valueName: string;
  partName: string;
  operatorName: string;
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
  const valueIndex = requestedValueIndex >= 0 ? requestedValueIndex : 0;
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

/**
 * 把活动工作表解析为完整、平衡的交叉 Gage R&R 研究。
 * 页面、保存摘要和专项导出共用此入口，避免各自猜列或把占位 0 当实测值。
 */
export function prepareGageStudy(
  model: VarModel,
  textCols: GageTextColumn[],
  selection: GageStudySelection,
): { ok: true; study: PreparedGageStudy } | { ok: false; reason: string } {
  if (model.colNames.length < 1) {
    return { ok: false, reason: '真实 Gage R&R 需要至少 1 个数值测量列' };
  }
  const namedValue = selection.valueColumn ? model.colNames.indexOf(selection.valueColumn) : -1;
  if (selection.valueColumn && namedValue < 0) {
    return { ok: false, reason: `已选测量列“${selection.valueColumn}”已不存在` };
  }
  const valueIndex = namedValue >= 0 ? namedValue : 0;
  const categories = resolvedGageCategoryColumns(model, textCols, model.colNames[valueIndex]);
  if (categories.length < 2) {
    return { ok: false, reason: '真实 Gage R&R 除测量列外还需要 2 个类别列（部件、操作员）；类别可以是数字 ID 或文本' };
  }
  const resolveCategory = (requested: string | null, fallback: number) => {
    if (!requested) return categories[fallback] ?? null;
    const found = categories.find((column) => column.name === requested) ?? null;
    if (!found && requested === model.colNames[valueIndex]) return null;
    return found;
  };
  const partColumn = resolveCategory(selection.partColumn, 0);
  const operatorColumn = resolveCategory(selection.operatorColumn, 1);
  if (!partColumn || !operatorColumn) {
    const role = !partColumn ? '部件' : '操作员';
    const requested = !partColumn ? selection.partColumn : selection.operatorColumn;
    return { ok: false, reason: requested === model.colNames[valueIndex]
      ? `测量列不能同时作为${role}列`
      : `已选${role}列“${requested ?? ''}”已不存在` };
  }
  if (partColumn.name === operatorColumn.name) return { ok: false, reason: '部件列与操作员列不能相同' };

  const selectedNumericIndices = new Set([
    valueIndex,
    partColumn.numericIndex,
    operatorColumn.numericIndex,
  ].filter((index): index is number => index != null));
  const pending = (selection.pendingCells ?? []).filter((cell) =>
    cell.row >= 0 && cell.row < model.k && selectedNumericIndices.has(cell.col)).length;
  if (pending > 0) return { ok: false, reason: `所选 Gage 角色列还有 ${pending} 个待录入单元格` };

  const parts = partColumn.values;
  const operators = operatorColumn.values;
  if (parts.length !== model.k || operators.length !== model.k) {
    return { ok: false, reason: '部件/操作员列的行数必须与测量列一致' };
  }
  const partValues = parts.map((value) => value.trim());
  const operatorValues = operators.map((value) => value.trim());
  if (partValues.some((value) => !value) || operatorValues.some((value) => !value)) {
    return { ok: false, reason: '部件/操作员列不能包含空白标签' };
  }
  const partLabels = [...new Set(partValues)];
  const operatorLabels = [...new Set(operatorValues)];
  if (operatorLabels.length < 2) {
    return { ok: false, reason: `仅检测到 1 个操作员(${operatorLabels[0]}):交叉 Gage R&R 需 ≥2 名操作员对同批部件重复测量;请补充其他操作员数据` };
  }
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
      operatorName: operatorColumn.name,
      partLabels,
      operatorLabels,
      repeats,
    },
  };
}
