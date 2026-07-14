/**
 * SPC 数据角色解析。
 *
 * 工作表仍保留用户导入的原始形态；本模块只为控制图构造语义正确的分析矩阵：
 * - 行式子组：一行一个子组，数值型“子组/批次”列只作标签，不参与均值/极差；
 * - 堆叠格式：一列测量值 + 一列文本或数值子组 ID；
 * - 列式子组：一列一个子组，分析时转置为“子组 × 组内测量”；
 * - 单值列：只取明确选择的测量列，避免把其他数值字段静默展平。
 */
import { computeVarModel, type VarModel } from './model';
import type { TextColumn } from './csv';
import { isDoeAnalysisColumn, isDoeOutputColumn } from './doe';

export type SpcDataLayout = 'auto' | 'rows' | 'stacked' | 'columns' | 'individuals';

export interface SpcRoleSelection {
  layout: SpcDataLayout;
  /** 数值测量列名；用于堆叠/单值格式。 */
  valueColumn: string | null;
  /** `numeric:列名` 或 `text:列名`；用于子组 ID / 行标签。 */
  subgroupColumn: string | null;
  /** 原工作表中仍为占位值的单元格；只拦截当前角色实际使用的数值列。 */
  pendingCells?: Array<{ row: number; col: number }>;
}

export interface SpcPreparedData {
  model: VarModel | null;
  requestedLayout: SpcDataLayout;
  layout: Exclude<SpcDataLayout, 'auto'> | null;
  layoutLabel: string;
  variableName: string;
  valueColumn: string | null;
  subgroupColumn: string | null;
  subgroupLabels: string[];
  /** 已转换到“每个图点一行”后的文本列，可直接用于分阶段。 */
  textCols: TextColumn[];
  xAxisLabel: string;
  note: string;
  error?: string;
}

interface RoleColumn {
  ref: string;
  name: string;
  kind: 'numeric' | 'text';
  values: Array<number | string>;
  numericIndex?: number;
  textIndex?: number;
  strongId: boolean;
}

const ID_NAME_RE = /^((?:原列)?子组(?:id|编号|序号|号)?|批次(?:id|编号|序号|号)?|组别|组号|样本(?:id|编号|序号|号)?|测量(?:id|编号|序号|号)|观测(?:id|编号|序号|号)|序号|subgroup(?:\s*id)?|batch(?:\s*id)?|lot(?:\s*id)?|group(?:\s*id)?)$/i;

export const numericSpcRole = (name: string) => `numeric:${name}`;
export const textSpcRole = (name: string) => `text:${name}`;

/** 可作为过程测量值的业务数值列；DOE 元数据/存储输出绝不能反向污染 SPC 与能力。 */
export function spcMeasurementColumnNames(model: VarModel): string[] {
  return model.colNames.filter(isDoeAnalysisColumn);
}

export function spcRoleOptions(model: VarModel, textCols: TextColumn[]): Array<{ ref: string; name: string; kind: 'numeric' | 'text' }> {
  return [
    ...model.colNames.filter((name) => !isDoeOutputColumn(name)).map((name) => ({ ref: numericSpcRole(name), name, kind: 'numeric' as const })),
    ...textCols.filter((col) => !isDoeOutputColumn(col.name)).map((col) => ({ ref: textSpcRole(col.name), name: col.name, kind: 'text' as const })),
  ];
}

function roleColumns(model: VarModel, textCols: TextColumn[]): RoleColumn[] {
  const rows = model.subs.map((s) => s.vals);
  return [
    ...model.colNames.map((name, numericIndex) => ({
      ref: numericSpcRole(name), name, kind: 'numeric' as const,
      values: rows.map((r) => r[numericIndex]), numericIndex, strongId: ID_NAME_RE.test(name.trim()),
    })).filter((role) => !isDoeOutputColumn(role.name)),
    ...textCols.filter((c) => c.values.length === rows.length && !isDoeOutputColumn(c.name)).map((col, textIndex) => ({
      ref: textSpcRole(col.name), name: col.name, kind: 'text' as const,
      values: [...col.values], textIndex, strongId: ID_NAME_RE.test(col.name.trim()),
    })),
  ];
}

function resolveRole(roles: RoleColumn[], ref: string | null): RoleColumn | null {
  if (!ref) return null;
  return roles.find((r) => r.ref === ref) ?? null;
}

function labelOf(v: number | string): string {
  return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)))) : String(v).trim();
}

function grouping(values: Array<number | string>) {
  const order: string[] = [];
  const rows = new Map<string, number[]>();
  values.forEach((raw, i) => {
    const key = labelOf(raw);
    if (!rows.has(key)) { rows.set(key, []); order.push(key); }
    rows.get(key)!.push(i);
  });
  const sizes = order.map((key) => rows.get(key)!.length);
  return { order, rows, sizes };
}

function repeatedGroupShape(role: RoleColumn): { valid: boolean; repeated: boolean; reason?: string } {
  const g = grouping(role.values);
  const repeated = g.order.length < role.values.length;
  if (!repeated) return { valid: false, repeated: false };
  if (g.order.length < 2) return { valid: false, repeated: true, reason: `子组列「${role.name}」只有 1 个子组` };
  if (new Set(g.sizes).size !== 1) {
    return { valid: false, repeated: true, reason: `子组列「${role.name}」的组内样本量不一致（${g.sizes.join('、')}）；X̄-R/X̄-S 需等大小子组` };
  }
  const n = g.sizes[0];
  if (n < 2 || n > 10) {
    return { valid: false, repeated: true, reason: `子组列「${role.name}」对应的子组大小 n=${n}，X̄-R/X̄-S 支持 2–10` };
  }
  return { valid: true, repeated: true };
}

function measurementBase(name: string): string {
  const withoutIndex = name.trim().replace(/[\s_\-（(]*\d+[）)]?\s*$/i, '').trim();
  const withoutSuffix = withoutIndex.replace(/[\s_-]*测量$/i, '').trim();
  // “测量1/测量2”去掉序号后只剩“测量”，仍然是合法的同一特性重复列。
  return withoutSuffix || withoutIndex;
}

function looksLikeRepeatedMeasurements(names: string[]): boolean {
  if (names.length < 2) return names.length === 1;
  const cleaned = names.map(measurementBase);
  return !!cleaned[0] && cleaned.every((name) => name === cleaned[0]);
}

function commonVariableName(names: string[]): string {
  if (names.length === 0) return '测量值';
  const cleaned = names.map(measurementBase);
  if (cleaned.every((name) => name === cleaned[0]) && cleaned[0]) {
    return ID_NAME_RE.test(cleaned[0]) ? '测量值' : cleaned[0];
  }
  let prefix = cleaned[0] ?? '';
  for (const name of cleaned.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const common = prefix.trim();
  return common.length >= 2 && !ID_NAME_RE.test(common) ? common : '测量值';
}

function makeError(selection: SpcRoleSelection, error: string): SpcPreparedData {
  return {
    model: null, requestedLayout: selection.layout, layout: null, layoutLabel: '角色配置无效',
    variableName: '测量值', valueColumn: selection.valueColumn, subgroupColumn: selection.subgroupColumn,
    subgroupLabels: [], textCols: [], xAxisLabel: '点序', note: '', error,
  };
}

function rowTextColumns(textCols: TextColumn[], k: number): TextColumn[] {
  return textCols.filter((c) => c.values.length === k && !isDoeOutputColumn(c.name)).map((c) => ({ name: c.name, values: [...c.values] }));
}

function pendingCount(selection: SpcRoleSelection, rowCount: number, numericColumns: number[]): number {
  const relevant = new Set(numericColumns.filter((index) => index >= 0));
  return (selection.pendingCells ?? []).filter((cell) =>
    cell.row >= 0 && cell.row < rowCount && relevant.has(cell.col)).length;
}

function pendingError(selection: SpcRoleSelection, count: number): SpcPreparedData {
  return makeError(selection, `当前分析使用列中还有 ${count} 个待录入单元格；不能把占位值当作实测过程数据`);
}

function prepareRows(
  model: VarModel,
  textCols: TextColumn[],
  selection: SpcRoleSelection,
  labelRole: RoleColumn | null,
  numericIdRoles: RoleColumn[],
): SpcPreparedData {
  const rawRows = model.subs.map((s) => [...s.vals]);
  const excludedNumeric = new Map<number, RoleColumn>();
  numericIdRoles.forEach((role) => {
    if (role.numericIndex != null) excludedNumeric.set(role.numericIndex, role);
  });
  if (labelRole?.kind === 'numeric' && labelRole.numericIndex != null) {
    excludedNumeric.set(labelRole.numericIndex, labelRole);
  }
  const keep = model.colNames.map((name, i) => ({ name, i }))
    .filter(({ name, i }) => isDoeAnalysisColumn(name) && !excludedNumeric.has(i))
    .map(({ i }) => i);
  if (keep.length === 0) return makeError(selection, '除去子组 ID 后没有测量列，请重新选择数据角色。');
  if (keep.length > 10) {
    return makeError(selection, `行式子组包含 ${keep.length} 个测量列，超过 X̄-R/X̄-S 的组内样本量范围 2–10；若这些列代表不同子组，请改选「列式子组」。`);
  }
  const pending = pendingCount(selection, rawRows.length, [
    ...keep,
    ...(labelRole?.kind === 'numeric' && labelRole.numericIndex != null ? [labelRole.numericIndex] : []),
  ]);
  if (pending > 0) return pendingError(selection, pending);
  const colNames = keep.map((i) => model.colNames[i]);
  const rows = rawRows.map((r) => keep.map((i) => r[i]));
  const unchanged = keep.length === model.n && keep.every((v, i) => v === i);
  const out = unchanged ? model : computeVarModel(model.name, colNames, rows, { isDemo: model.isDemo });
  const subgroupLabels = labelRole ? labelRole.values.map(labelOf) : rows.map((_, i) => String(i + 1));
  const excludedNames = [...excludedNumeric.values()].map((role) => role.name);
  const labelText = labelRole
    ? `；「${labelRole.name}」仅作子组标签，未参与测量计算`
    : '';
  const idText = excludedNames.filter((name) => name !== labelRole?.name).length > 0
    ? `；数值 ID「${excludedNames.filter((name) => name !== labelRole?.name).join('、')}」未参与测量计算`
    : '';
  const pointText = rowTextColumns(textCols, rows.length)
    .filter((col) => labelRole?.kind !== 'text' || col.name !== labelRole.name);
  excludedNumeric.forEach((role) => {
    if (grouping(role.values).order.length < rows.length && !pointText.some((col) => col.name === role.name)) {
      pointText.push({ name: role.name, values: role.values.map(labelOf) });
    }
  });
  return {
    model: out, requestedLayout: selection.layout, layout: 'rows', layoutLabel: '行式子组（一行一个子组）',
    variableName: commonVariableName(colNames), valueColumn: null, subgroupColumn: labelRole?.ref ?? null,
    subgroupLabels, textCols: pointText,
    xAxisLabel: labelRole ? `子组（${labelRole.name}）` : '子组序号',
    note: `按 ${rows.length} 个子组 × ${keep.length} 次组内测量分析${labelText}${idText}`,
  };
}

function prepareStacked(
  model: VarModel, textCols: TextColumn[], selection: SpcRoleSelection, idRole: RoleColumn | null,
): SpcPreparedData {
  if (!idRole) return makeError(selection, '堆叠格式必须选择文本或数值“子组 ID”列。');
  const valueIndex = selection.valueColumn == null ? -1 : model.colNames.indexOf(selection.valueColumn);
  if (valueIndex < 0) return makeError(selection, '堆叠格式必须选择一个数值“测量值”列。');
  if (!isDoeAnalysisColumn(model.colNames[valueIndex])) {
    return makeError(selection, `「${model.colNames[valueIndex]}」是设计元数据或分析输出列，不能作为 SPC 测量值。`);
  }
  if (idRole.kind === 'numeric' && idRole.numericIndex === valueIndex) {
    return makeError(selection, '测量值列与子组 ID 列不能是同一列。');
  }
  const pending = pendingCount(selection, model.k, [
    valueIndex,
    ...(idRole.kind === 'numeric' && idRole.numericIndex != null ? [idRole.numericIndex] : []),
  ]);
  if (pending > 0) return pendingError(selection, pending);
  const shape = repeatedGroupShape(idRole);
  if (!shape.valid) return makeError(selection, shape.reason ?? `子组列「${idRole.name}」没有重复 ID，无法组成堆叠子组。`);
  const g = grouping(idRole.values);
  const rawRows = model.subs.map((s) => s.vals);
  const rows = g.order.map((key) => g.rows.get(key)!.map((i) => rawRows[i][valueIndex]));
  const n = rows[0].length;
  const out = computeVarModel(model.name, Array.from({ length: n }, (_, i) => `${selection.valueColumn} ${i + 1}`), rows, { isDemo: false });

  // 只有当一个原始文本列在每个子组内取值恒定时，才能安全提升为“每个图点一值”的阶段列。
  const groupedText: TextColumn[] = [];
  textCols.forEach((col) => {
    if (isDoeOutputColumn(col.name)) return;
    if (col.values.length !== rawRows.length || (idRole.kind === 'text' && col.name === idRole.name)) return;
    const values: string[] = [];
    let valid = true;
    for (const key of g.order) {
      const idx = g.rows.get(key)!;
      const first = col.values[idx[0]];
      if (idx.some((i) => col.values[i] !== first)) { valid = false; break; }
      values.push(first);
    }
    if (valid) groupedText.push({ name: col.name, values });
  });
  // 显式选定测量值后，其他数值元数据若在每个子组内恒定（如数值阶段/批次），
  // 安全提升为阶段候选；它们不参与测量计算。
  model.colNames.forEach((name, numericIndex) => {
    if (numericIndex === valueIndex || (idRole.kind === 'numeric' && numericIndex === idRole.numericIndex)) return;
    if (isDoeOutputColumn(name)) return;
    const values: string[] = [];
    let valid = true;
    for (const key of g.order) {
      const idx = g.rows.get(key)!;
      const first = rawRows[idx[0]][numericIndex];
      if (idx.some((i) => rawRows[i][numericIndex] !== first)) { valid = false; break; }
      values.push(labelOf(first));
    }
    if (valid && !groupedText.some((col) => col.name === name)) groupedText.push({ name, values });
  });

  return {
    model: out, requestedLayout: selection.layout, layout: 'stacked', layoutLabel: '堆叠格式（测量值 + 子组 ID）',
    variableName: selection.valueColumn!, valueColumn: selection.valueColumn, subgroupColumn: idRole.ref,
    subgroupLabels: g.order, textCols: groupedText, xAxisLabel: `子组（${idRole.name}）`,
    note: `「${selection.valueColumn}」作为测量值；「${idRole.name}」作为子组 ID，共 ${rows.length} 个子组 × ${n} 次测量`,
  };
}

function prepareColumns(model: VarModel, selection: SpcRoleSelection, roles: RoleColumn[]): SpcPreparedData {
  const rawRows = model.subs.map((s) => s.vals);
  if (rawRows.length < 2 || rawRows.length > 10) {
    return makeError(selection, `列式子组转置后的组内样本量为 ${rawRows.length}；X̄-R/X̄-S 支持 2–10 行测量。`);
  }
  // “测量序号/样本号”这类明确命名的 ID 列不是一个子组。ID 可能为
  // 10/20/40 或时间码，不得仅在“恰好连续”时才排除。
  const indexCols = new Set(roles
    .filter((r) => r.kind === 'numeric' && r.strongId && r.numericIndex != null)
    .map((r) => r.numericIndex!));
  const keep = model.colNames.map((name, i) => ({ name, i }))
    .filter(({ name, i }) => isDoeAnalysisColumn(name) && !indexCols.has(i))
    .map(({ i }) => i);
  if (keep.length < 2) return makeError(selection, '列式子组至少需要 2 个数值列（每列代表一个子组）。');
  const pending = pendingCount(selection, rawRows.length, keep);
  if (pending > 0) return pendingError(selection, pending);
  const rows = keep.map((j) => rawRows.map((r) => r[j]));
  const n = rawRows.length;
  const out = computeVarModel(model.name, Array.from({ length: n }, (_, i) => `测量 ${i + 1}`), rows, { isDemo: false });
  const subgroupLabels = keep.map((i) => model.colNames[i]);
  const excluded = indexCols.size ? `；已排除 ${indexCols.size} 个数值索引列` : '';
  return {
    model: out, requestedLayout: selection.layout, layout: 'columns', layoutLabel: '列式子组（一列一个子组，分析时转置）',
    variableName: commonVariableName(subgroupLabels), valueColumn: null, subgroupColumn: null,
    subgroupLabels, textCols: [], xAxisLabel: '子组（原工作表列名）',
    note: `已将 ${keep.length} 个子组列 × ${n} 行测量转换为控制图矩阵${excluded}`,
  };
}

function prepareIndividuals(
  model: VarModel, textCols: TextColumn[], selection: SpcRoleSelection, labelRole: RoleColumn | null,
): SpcPreparedData {
  const valueIndex = selection.valueColumn == null ? -1 : model.colNames.indexOf(selection.valueColumn);
  if (valueIndex < 0) return makeError(selection, '单值格式必须选择一个数值“测量值”列。');
  if (!isDoeAnalysisColumn(model.colNames[valueIndex])) {
    return makeError(selection, `「${model.colNames[valueIndex]}」是设计元数据或分析输出列，不能作为 SPC 测量值。`);
  }
  if (labelRole?.kind === 'numeric' && labelRole.numericIndex === valueIndex) {
    return makeError(selection, '测量值列与点标签列不能是同一列。');
  }
  const pending = pendingCount(selection, model.k, [
    valueIndex,
    ...(labelRole?.kind === 'numeric' && labelRole.numericIndex != null ? [labelRole.numericIndex] : []),
  ]);
  if (pending > 0) return pendingError(selection, pending);
  const values = model.subs.map((s) => s.vals[valueIndex]);
  const rows = values.map((v) => [v]);
  const out = computeVarModel(model.name, [selection.valueColumn!], rows, { isDemo: false });
  return {
    model: out, requestedLayout: selection.layout, layout: 'individuals', layoutLabel: '单值列（I-MR）',
    variableName: selection.valueColumn!, valueColumn: selection.valueColumn, subgroupColumn: labelRole?.ref ?? null,
    subgroupLabels: labelRole ? labelRole.values.map(labelOf) : rows.map((_, i) => String(i + 1)),
    textCols: rowTextColumns(textCols, rows.length)
      .filter((col) => labelRole?.kind !== 'text' || col.name !== labelRole.name),
    xAxisLabel: labelRole ? `观测（${labelRole.name}）` : '观测序号',
    note: `仅使用「${selection.valueColumn}」的 ${rows.length} 个观测；其他数值列未进入 I-MR 计算`,
  };
}

/** 为当前工作表与用户角色选择构造 SPC 分析数据。 */
export function prepareSpcData(model: VarModel, textCols: TextColumn[], selection: SpcRoleSelection): SpcPreparedData {
  const roles = roleColumns(model, textCols);
  const selectedRole = resolveRole(roles, selection.subgroupColumn);
  const strong = roles.filter((r) => r.strongId);
  const measurementColumns = spcMeasurementColumnNames(model);
  let layout = selection.layout;
  let idRole = selectedRole;
  let valueColumn = selection.valueColumn;

  if (layout === 'auto') {
    // 行数仅 2–10 且数值列 >10 时，优先视为“一列一子组”。此时“测量序号”是
    // 转置前的行索引，不能因为它是强 ID 名就把整张宽表误判成行式子组。
    if (measurementColumns.length > 10 && model.k >= 2 && model.k <= 10) layout = 'columns';
    // 明确命名的“子组/批次”字段优先。重复 ID 表示堆叠数据；唯一 ID 表示行式子组标签。
    if (layout === 'auto') {
      const repeatedRoles = roles.filter((role) => repeatedGroupShape(role).valid);
      // 常见长表会同时有唯一“序号”和重复“批次”。应优先能真正成组的 ID，
      // 不能因数值列排在文本列前面就把整张表误判成单值数据。
      idRole = selectedRole
        ?? repeatedRoles.find((role) => role.strongId)
        ?? strong[0]
        ?? (measurementColumns.length === 1 ? repeatedRoles[0] : null)
        ?? null;
    }
    if (layout === 'auto' && !idRole && textCols.length === 1 && measurementColumns.length === 1) {
      idRole = roles.find((r) => r.kind === 'text') ?? null;
    }
    if (layout === 'auto' && idRole) {
      const shape = repeatedGroupShape(idRole);
      const numericMetadata = new Set(strong
        .filter((role) => role.kind === 'numeric' && role.numericIndex !== idRole?.numericIndex)
        .map((role) => role.numericIndex!));
      const candidates = model.colNames.filter((name, i) =>
        isDoeAnalysisColumn(name) && (idRole?.kind !== 'numeric' || i !== idRole.numericIndex) && !numericMetadata.has(i));
      if (shape.repeated) {
        if (!shape.valid) return makeError(selection, shape.reason!);
        valueColumn = valueColumn && candidates.includes(valueColumn) ? valueColumn : candidates.length === 1 ? candidates[0] : null;
        if (!valueColumn) {
          return makeError(selection, `检测到重复的子组 ID 列「${idRole.name}」，但其余有 ${candidates.length} 个数值列；请选择哪一列是测量值，系统不会把子组 ID 或其他数值字段静默混入计算。`);
        }
        layout = 'stacked';
      } else if (valueColumn && candidates.includes(valueColumn)) {
        layout = 'individuals';
      } else if (candidates.length >= 2 && looksLikeRepeatedMeasurements(candidates)) {
        layout = 'rows';
      } else if (candidates.length >= 2) {
        return makeError(selection, `检测到多个名称不同的业务数值列「${candidates.join('、')}」，无法确认它们是否为同一测量特性的组内重复值；请选择一个测量值列用于 I-MR，或明确选择行式/列式布局。`);
      } else {
        valueColumn = valueColumn && candidates.includes(valueColumn) ? valueColumn : candidates[0] ?? null;
        layout = 'individuals';
      }
    } else if (layout === 'auto' && valueColumn && measurementColumns.includes(valueColumn)) {
      layout = 'individuals';
    } else if (layout === 'auto' && measurementColumns.length === 1) {
      layout = 'individuals';
      valueColumn = measurementColumns[0];
    } else if (layout === 'auto' && looksLikeRepeatedMeasurements(measurementColumns)) {
      layout = 'rows';
    } else if (layout === 'auto') {
      return makeError(selection, measurementColumns.length === 0
        ? '当前工作表只有设计元数据或分析输出列，没有可用于 SPC 的业务测量列。'
        : `检测到多个名称不同的业务数值列「${measurementColumns.join('、')}」，无法确认它们是否为同一测量特性的组内重复值；请选择一个测量值列用于 I-MR，或明确选择行式/列式布局。`);
    }
  }

  const effectiveSelection: SpcRoleSelection = {
    layout: selection.layout,
    valueColumn,
    subgroupColumn: idRole?.ref ?? selection.subgroupColumn,
    pendingCells: selection.pendingCells,
  };
  if (layout === 'rows') {
    // 手动选行式时仍不允许将明确命名的数值“子组/批次”列静默当测量。
    // 重复的文本批次列则保留为阶段列，避免误当成行标签后从阶段候选中删掉。
    const numericIds = roles.filter((role) => role.kind === 'numeric' && (role.strongId || !isDoeAnalysisColumn(role.name)));
    const explicitNumericId = selection.layout === 'rows' ? numericIds[0] ?? null : null;
    const role = selectedRole ?? (selection.layout === 'auto' ? idRole : explicitNumericId);
    return prepareRows(model, textCols, effectiveSelection, role, numericIds);
  }
  if (layout === 'stacked') {
    const role = selectedRole ?? idRole ?? strong.find((r) => repeatedGroupShape(r).repeated) ?? null;
    const numericMetadata = new Set(strong
      .filter((candidate) => candidate.kind === 'numeric' && candidate.numericIndex !== role?.numericIndex)
      .map((candidate) => candidate.numericIndex!));
    const candidates = model.colNames.filter((name, i) =>
      isDoeAnalysisColumn(name) && (role?.kind !== 'numeric' || i !== role.numericIndex) && !numericMetadata.has(i));
    const stackedSelection = !effectiveSelection.valueColumn && candidates.length === 1
      ? { ...effectiveSelection, valueColumn: candidates[0] }
      : effectiveSelection;
    return prepareStacked(model, textCols, stackedSelection, role);
  }
  if (layout === 'columns') return prepareColumns(model, effectiveSelection, roles);
  if (layout === 'individuals') {
    const chosen = valueColumn && model.colNames.includes(valueColumn)
      ? valueColumn
      : measurementColumns.length === 1 ? measurementColumns[0] : null;
    return prepareIndividuals(model, textCols, { ...effectiveSelection, valueColumn: chosen }, selectedRole ?? idRole);
  }
  return makeError(selection, '无法识别 SPC 数据形态，请手动选择数据布局与角色。');
}
