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
  if (partLabels.length < 2 || operatorLabels.length < 2) {
    return { ok: false, reason: '交叉研究至少需要 2 个部件和 2 个操作员' };
  }

  const cellRows = new Map<string, number[]>();
  for (let row = 0; row < model.k; row++) {
    const key = `${partValues[row]}\u0000${operatorValues[row]}`;
    const rows = cellRows.get(key) ?? [];
    rows.push(row);
    cellRows.set(key, rows);
  }
  const expectedCells = partLabels.length * operatorLabels.length;
  if (cellRows.size !== expectedCells) return { ok: false, reason: '部件×操作员组合不完整，必须是完整交叉设计' };
  const counts = [...cellRows.values()].map((rows) => rows.length);
  const repeats = counts[0] ?? 0;
  if (repeats < 2 || counts.some((count) => count !== repeats)) {
    return { ok: false, reason: '每个部件×操作员组合必须有相同且不少于 2 次的重复测量' };
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
