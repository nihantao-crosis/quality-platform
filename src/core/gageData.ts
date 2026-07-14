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

/**
 * 把活动工作表解析为完整、平衡的交叉 Gage R&R 研究。
 * 页面、保存摘要和专项导出共用此入口，避免各自猜列或把占位 0 当实测值。
 */
export function prepareGageStudy(
  model: VarModel,
  textCols: GageTextColumn[],
  selection: GageStudySelection,
): { ok: true; study: PreparedGageStudy } | { ok: false; reason: string } {
  if (model.colNames.length < 1 || textCols.length < 2) {
    return { ok: false, reason: '真实 Gage R&R 需要至少 1 个数值测量列和 2 个文本列（部件、操作员）' };
  }
  const namedValue = selection.valueColumn ? model.colNames.indexOf(selection.valueColumn) : -1;
  const valueIndex = namedValue >= 0 ? namedValue : 0;
  const namedPart = selection.partColumn ? textCols.findIndex((column) => column.name === selection.partColumn) : -1;
  const namedOperator = selection.operatorColumn ? textCols.findIndex((column) => column.name === selection.operatorColumn) : -1;
  const partIndex = namedPart >= 0 ? namedPart : 0;
  const operatorIndex = namedOperator >= 0 ? namedOperator : 1;
  if (partIndex === operatorIndex) return { ok: false, reason: '部件列与操作员列不能相同' };

  const pending = (selection.pendingCells ?? []).filter((cell) =>
    cell.row >= 0 && cell.row < model.k && cell.col === valueIndex).length;
  if (pending > 0) return { ok: false, reason: `测量列还有 ${pending} 个待录入单元格` };

  const parts = textCols[partIndex]?.values;
  const operators = textCols[operatorIndex]?.values;
  if (!parts || !operators || parts.length !== model.k || operators.length !== model.k) {
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
      partName: textCols[partIndex].name,
      operatorName: textCols[operatorIndex].name,
      partLabels,
      operatorLabels,
      repeats,
    },
  };
}
