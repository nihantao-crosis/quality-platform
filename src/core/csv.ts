/**
 * CSV / 剪贴板数据解析 — 自动识别分隔符与表头。
 * 数值列构成测量矩阵；文本列保留（供 ANOVA 分组 / Gage 部件·操作员列）。
 */

export interface TextColumn {
  name: string;
  values: string[]; // 与保留的数据行对齐
  /** 该文本列在导入表「保留列」(数值+文本)中的原始位置(0 基)。
   * 批次716-R2 P1:工作表按此交错显示,还原 Minitab 式导入原列序(如 部件/测试人/螺钉高度);
   * 旧数据/程序生成数据集可缺省 → 回落「数值列在前」的历史顺序。 */
  sourceIndex?: number;
}

/** 工作表显示列引用:kind 指向数值矩阵列或文本列的下标。 */
export interface WorksheetColumnRef { kind: 'numeric' | 'text'; index: number }

/** 工作表显示列序:按 TextColumn.sourceIndex 把文本列交错回导入原位。
 * 任一文本列缺 sourceIndex 或位置冲突时整体回落「数值在前、文本在后」的历史顺序;
 * 后加的数值列(公式列/插入列)没有原位信息,始终排在数值序尾部。 */
export function worksheetDisplayOrder(numericCount: number, textCols: TextColumn[]): WorksheetColumnRef[] {
  const fallback: WorksheetColumnRef[] = [
    ...Array.from({ length: numericCount }, (_, i) => ({ kind: 'numeric' as const, index: i })),
    ...textCols.map((_, i) => ({ kind: 'text' as const, index: i })),
  ];
  if (!textCols.length) return fallback;
  const known = textCols.every((t) => Number.isInteger(t.sourceIndex) && (t.sourceIndex as number) >= 0);
  const unique = new Set(textCols.map((t) => t.sourceIndex)).size === textCols.length;
  if (!known || !unique) return fallback;
  const sorted = textCols.map((t, i) => ({ i, s: t.sourceIndex as number })).sort((a, b) => a.s - b.s);
  const out: WorksheetColumnRef[] = [];
  let emitted = 0;
  sorted.forEach(({ i, s }, order) => {
    // 原始位置 s 的文本列前面有 s−order 个数值列(order = 排在它前面的文本列数)
    const numsBefore = Math.min(numericCount, Math.max(emitted, s - order));
    while (emitted < numsBefore) out.push({ kind: 'numeric', index: emitted++ });
    out.push({ kind: 'text', index: i });
  });
  while (emitted < numericCount) out.push({ kind: 'numeric', index: emitted++ });
  return out;
}

/** 与工作表顶部一致的数值列 C 编号；文本列占据位置并显示为 C#-T。 */
export function worksheetNumericColumnCodes(numericCount: number, textCols: TextColumn[]): number[] {
  const codes = new Array<number>(numericCount);
  worksheetDisplayOrder(numericCount, textCols).forEach((ref, displayIndex) => {
    if (ref.kind === 'numeric') codes[ref.index] = displayIndex + 1;
  });
  return codes;
}

export interface ParsedMatrix {
  colNames: string[]; // 数值列名
  rows: number[][];
  textCols: TextColumn[];
  /** 原始数据区的最大列数；用于专用格式拒绝未识别/被忽略的额外列。 */
  sourceColumnCount: number;
  totalLines: number; // 数据行总数（不含表头）
  skippedRows: number; // 数值列含缺失/非法值被跳过的行
  droppedCols: number; // 保留的文本列数（向后兼容字段名）
}

const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function isNum(s: string): boolean {
  return NUM_RE.test(s.trim());
}

function detectDelimiter(line: string): string {
  const counts: Array<[string, number]> = [
    ['\t', (line.match(/\t/g) || []).length],
    [',', (line.match(/,/g) || []).length],
    [';', (line.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseMatrix(text: string): ParsedMatrix | { error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return { error: '数据不足：至少需要 2 行' };

  const delim = detectDelimiter(lines[0]);
  const cells = lines.map((l) => l.split(delim).map((c) => c.trim()));

  // 表头：首行任一单元非数值即视为表头
  const hasHeader = cells[0].some((c) => c !== '' && !isNum(c));
  const header = hasHeader ? cells[0] : null;
  const body = hasHeader ? cells.slice(1) : cells;
  if (body.length < 2) return { error: '数据不足：至少需要 2 行数据' };

  let nCols = 0; // 不用 Math.max(...) — 十万行展开会栈溢出
  for (const r of body) if (r.length > nCols) nCols = r.length;
  // 数值列：≥80% 行可解析为数；其余为文本列
  const numericCols: number[] = [];
  const textColIdx: number[] = [];
  for (let j = 0; j < nCols; j++) {
    const vals = body.map((r) => r[j] ?? '');
    const ok = vals.filter((v) => isNum(v)).length;
    if (ok / vals.length >= 0.8) numericCols.push(j);
    else if (vals.filter((v) => v !== '').length / vals.length >= 0.8) textColIdx.push(j);
  }
  if (numericCols.length === 0) return { error: '未检测到数值列' };
  // 不在导入层把“数值列数”当作“子组大小”。例如 20 个数值列可能是 20 个列式子组，
  // 每列只有 5 次测量；SPC 页面会根据数据角色转置后再校验真正的组内样本量。

  const nameOf = (j: number, fallback: string) => {
    const h = header?.[j]?.trim();
    return h && !isNum(h) ? h : fallback;
  };
  const colNames = numericCols.map((j, idx) => nameOf(j, `C${idx + 1}`));
  const textNames = textColIdx.map((j, idx) => nameOf(j, `T${idx + 1}`));

  const rows: number[][] = [];
  const textVals: string[][] = textColIdx.map(() => []);
  let skipped = 0;
  for (const r of body) {
    const vals = numericCols.map((j) => parseFloat(r[j] ?? ''));
    if (vals.some((v) => !Number.isFinite(v))) skipped++;
    else {
      rows.push(vals);
      textColIdx.forEach((j, t) => textVals[t].push(r[j] ?? ''));
    }
  }
  if (rows.length < 2) return { error: '有效数据行不足 2 行' };

  // sourceIndex = 在「保留列」(数值∪文本,按原表列位升序)中的位置,供工作表交错还原原列序
  const keptOrder = [...numericCols, ...textColIdx].sort((a, b) => a - b);
  const textCols: TextColumn[] = textColIdx.map((j, t) => ({ name: textNames[t], values: textVals[t], sourceIndex: keptOrder.indexOf(j) }));
  return { colNames, rows, textCols, sourceColumnCount: nCols, totalLines: body.length, skippedRows: skipped, droppedCols: textCols.length };
}

/** 单列计数解析：整数列（供 P/C 图导入） */
export function parseCounts(text: string): { counts: number[]; name: string } | { error: string } {
  const r = parseMatrix(text);
  if ('error' in r) return r;
  if (r.colNames.length !== 1) return { error: `计数数据应为单列（检测到 ${r.colNames.length} 个数值列）` };
  const counts = r.rows.map((row) => row[0]);
  if (counts.some((c) => c < 0 || !Number.isInteger(c))) return { error: '计数必须为非负整数' };
  return { counts, name: r.colNames[0] };
}

export interface PChartColumns {
  counts: number[];
  sampleSizes: number | number[];
  variableSampleSizes: boolean;
}

/**
 * P 图导入列语义：第一列是不良数，第二列（可选）是该批检验数。
 * 单列文件继续使用界面给出的固定 n；拒绝静默丢弃第三列或文本列。
 */
export function extractPChartColumns(parsed: ParsedMatrix, defaultSampleSize: number): PChartColumns | { error: string } {
  const totalColumns = parsed.sourceColumnCount ?? parsed.colNames.length + parsed.textCols.length;
  if (totalColumns < 1 || totalColumns > 2 || parsed.textCols.length > 0) {
    return { error: `P 图数据应为 1 列（不良数）或 2 列（不良数、样本量），检测到 ${totalColumns} 列` };
  }
  if (parsed.skippedRows > 0 || parsed.colNames.length !== totalColumns) {
    return { error: `P 图数据包含 ${parsed.skippedRows || '无法识别'} 行/列非法值；不允许跳过后继续计算` };
  }
  if (!Number.isSafeInteger(defaultSampleSize) || defaultSampleSize < 1) {
    return { error: '默认样本量必须为正整数' };
  }
  const counts = parsed.rows.map((row) => row[0]);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    return { error: '不良数必须为非负整数' };
  }
  if (parsed.colNames.length === 1) {
    if (counts.some((count) => count > defaultSampleSize)) return { error: '不良数不能大于默认样本量' };
    return { counts, sampleSizes: defaultSampleSize, variableSampleSizes: false };
  }
  const sampleSizes = parsed.rows.map((row) => row[1]);
  if (sampleSizes.some((n) => !Number.isSafeInteger(n) || n < 1)) {
    return { error: '逐批样本量必须为正整数' };
  }
  if (counts.some((count, index) => count > sampleSizes[index])) {
    return { error: '不良数不能大于对应批次样本量' };
  }
  return {
    counts,
    sampleSizes,
    variableSampleSizes: sampleSizes.some((n) => n !== sampleSizes[0]),
  };
}

// ---------- 帕累托专用:类别 + 频数 ----------

export interface CategoryCounts {
  rows: { name: string; count: number }[];
  /** 解析器做过的自动处理说明(如横向转置/剥离表头),用于 toast 告知用户 */
  note?: string;
}

/** 多列帕累托数据可由用户显式指定类别列/频数列（0-based）。 */
export interface CategoryCountColumns {
  categoryColumn: number;
  countColumn: number;
}

const CAT_HEADER_RE = /^(类别|类型|名称|缺陷|缺陷类别|缺陷类型|不良|不良类别|不良类型|项目|原因|category|type|name|defect|item)$/i;
const CNT_HEADER_RE = /^(count|counts|频数|频率|数量|件数|次数|发生次数|发生频数|发生频率|频次|不良数|缺陷数|frequency|freq)$/i;

/** 解析「缺陷类别 + 频数」数据(帕累托)。与 parseMatrix 完全独立,规则:
 *  1. 横向 2×N(类别一行/频数一行)→ 自动转置;
 *  2. 纵向 文本列+数值列 → 直取;表头仅在命中关键词时剥离(不做「首行含文本即表头」的误判);
 *  3. 单列文本标签 → 按出现次数 tally 聚合;
 *  4. ≥1 个类别即可;频数须为非负数;同名类别自动合并求和。 */
/** 分隔符探测(帕累托专用):Tab/逗号/分号之外,额外支持「文本 + 空白 + 数字」的空格分隔。 */
function delimiterCountOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && line[i] === delimiter) count++;
  }
  return count;
}

function detectCatDelimiter(lines: string[]): string {
  const first = lines[0];
  const ranked = ['\t', ',', ';']
    .map((d) => ({ d, n: delimiterCountOutsideQuotes(first, d) }))
    .sort((a, b) => b.n - a.n);
  if (ranked[0].n > 0) return ranked[0].d;
  const spaceLike = lines.filter((l) => /\S\s+\S/.test(l)).length;
  return spaceLike >= Math.ceil(lines.length * 0.6) ? ' ' : ',';
}

/** RFC 4180 常见子集：保留空字段，支持双引号包裹、字段内分隔符与 "" 转义。 */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  if (delimiter === ' ') return line.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === delimiter) {
      out.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** 按逻辑 CSV 记录拆分：字段内换行保留，只有引号外换行才结束一条记录。 */
function splitQuotedRecords(text: string): { records: string[]; unclosedQuote: boolean } {
  const records: string[] = [];
  let record = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      record += ch;
      if (quoted && text[i + 1] === '"') {
        record += text[++i];
      } else quoted = !quoted;
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (record.trim() !== '') records.push(record.trim());
      record = '';
    } else record += ch;
  }
  if (record.trim() !== '') records.push(record.trim());
  return { records, unclosedQuote: quoted };
}

/** 一列是否为「序号列」:从 0 或 1 起、步长 1 的连续整数(如 1,2,3,…N)。
 *  仅"递增整数"不够——10,20,30 也递增但那是频数;须为真正的连续序号才剔除。 */
function isIndexColumn(vals: string[]): boolean {
  if (vals.length < 2 || !vals.every((v) => /^\d+$/.test(v))) return false;
  const nums = vals.map(Number);
  const start = nums[0];
  if (start !== 0 && start !== 1) return false;
  for (let i = 1; i < nums.length; i++) if (nums[i] !== start + i) return false;
  return true;
}

export function parseCategoryCounts(text: string, columns?: CategoryCountColumns): CategoryCounts | { error: string } {
  const logical = splitQuotedRecords(text.replace(/^\uFEFF/, ''));
  if (logical.unclosedQuote) return { error: 'CSV 引号未闭合，请检查含逗号或换行的类别字段。' };
  const lines = logical.records;
  if (lines.length === 0) return { error: '没有可解析的内容。期望格式:「类别,频数」两列(纵向)或「类别一行 + 频数一行」(横向),也可粘贴单列原始缺陷标签。' };

  const delim = detectCatDelimiter(lines);
  let cells = lines.map((line) => splitDelimitedLine(line, delim));
  const notes: string[] = [];
  let transposedHorizontal = false;
  if (delim === ' ') notes.push('已按空格分隔解析');

  // 规则 1:横向布局(恰 2 行),支持带行首标签(类别/频数)的 Excel 横向表
  if (!columns && cells.length === 2 && cells[0].length >= 2 && cells[0].length === cells[1].length) {
    const [r0, r1] = cells;
    if (r0.every((c) => !isNum(c)) && r1.every((c) => isNum(c))) {
      cells = r0.map((name, i) => [name, r1[i]]);
      transposedHorizontal = true;
      notes.push('检测到横向数据(类别一行/频数一行),已自动转置');
    } else if (!isNum(r1[0])
        && r1.slice(1).every((c) => isNum(c))
        && (r0.slice(1).every((c) => !isNum(c))
          || (CAT_HEADER_RE.test(r0[0]) && CNT_HEADER_RE.test(r1[0]) && r0.slice(1).every((c) => c !== '')))) {
      cells = r0.slice(1).map((name, i) => [name, r1[i + 1]]);
      transposedHorizontal = true;
      notes.push('检测到带行标签的横向数据,已剥离标签并转置');
    } else if (r0.length >= 3 && r0.every((c) => isNum(c)) && r1.every((c) => isNum(c))) {
      // Pure numeric category codes have no text cell to infer from. Only an unambiguous
      // 2xN (N>=3) shape is treated as "category-code row + frequency row"; 2x2 stays ambiguous.
      cells = r0.map((name, i) => [name, r1[i]]);
      transposedHorizontal = true;
      notes.push('检测到纯数字横向数据(类别代码一行/频数一行),已自动转置');
    }
  }

  // 关键词表头剥离(仅纵向、明确命中时):首行同时含类别关键词与频数关键词即视为表头,
  // 关键词可在任意列(兼容「序号,类别,频数」这类带序号前缀的表头,序号本身不是类别词)。
  let headerRemoved = false;
  if (cells.length >= 2 && cells[0].length >= 2
      && cells[0].some((c) => CAT_HEADER_RE.test(c)) && cells[0].some((c) => CNT_HEADER_RE.test(c))) {
    cells = cells.slice(1);
    headerRemoved = true;
    notes.push('已识别并跳过表头行');
  } else if (cells.length >= 2 && cells[0].length === 1 && CAT_HEADER_RE.test(cells[0][0])) {
    cells = cells.slice(1);
    headerRemoved = true;
    notes.push('已识别并跳过表头行');
  }

  const merged = new Map<string, number>();
  const order: string[] = [];
  const add = (name: string, count: number) => {
    if (!merged.has(name)) order.push(name);
    merged.set(name, (merged.get(name) ?? 0) + count);
  };

  // 多数字列由用户显式选列，避免把成本/金额等误当频数。类别列允许纯数字代码。
  if (columns) {
    const { categoryColumn, countColumn } = columns;
    if (!Number.isInteger(categoryColumn) || !Number.isInteger(countColumn)
        || categoryColumn < 0 || countColumn < 0 || categoryColumn === countColumn) {
      return { error: '类别列与频数列必须是两个不同的有效列号。' };
    }
    const maxLen = Math.max(...cells.map((r) => r.length));
    if (categoryColumn >= maxLen || countColumn >= maxLen) {
      return { error: `指定列超出数据范围（当前最多 ${maxLen} 列）。` };
    }
    // 上方通用规则未覆盖「代码,频数,成本」时，按所选单元格关键词再识别一次；
    // 不能仅因首条频数非法就静默吞掉数据。
    let selected = cells;
    if (!headerRemoved && selected.length >= 2) {
      const countHead = selected[0][countColumn] ?? '';
      // 类别值本身完全可能就叫“缺陷/类别/不良”；只有所选频数单元格明确命中
      // 频数表头时才能吞掉首行，不能用类别关键词单独判定。
      if (CNT_HEADER_RE.test(countHead)) {
        selected = selected.slice(1);
        notes.push('已按所选列跳过表头行');
      }
    }
    for (const [li, r] of selected.entries()) {
      const name = (r[categoryColumn] ?? '').trim();
      const rawCount = r[countColumn] ?? '';
      if (!name) return { error: `第 ${li + 1} 行所选类别列为空。` };
      if (!isNum(rawCount)) return { error: `第 ${li + 1} 行所选频数「${rawCount}」不是有效数字。` };
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count < 0) return { error: `第 ${li + 1} 行频数为 ${rawCount}，频数必须 ≥ 0。` };
      add(name, count);
    }
    const rows = order.map((name) => ({ name, count: merged.get(name)! }));
    if (rows.length === 0) return { error: '没有解析到任何类别' };
    if (rows.every((r) => r.count === 0)) return { error: '所有类别的频数都是 0,无法绘制帕累托图' };
    notes.push(`已使用第 ${categoryColumn + 1} 列作为类别、第 ${countColumn + 1} 列作为频数`);
    return { rows, note: notes.join(';') };
  }

  if (transposedHorizontal) {
    for (const [li, row] of cells.entries()) {
      const count = Number(row[1]);
      if (!Number.isFinite(count) || count < 0) return { error: `第 ${li + 1} 个类别的频数必须 ≥ 0。` };
      add(row[0], count);
    }
  } else if (cells.every((r) => r.length === 1)) {
    // 单列:全数值无从命名类别;含文本则按标签 tally
    if (cells.every((r) => isNum(r[0]))) {
      return { error: '仅有一列数值,无法确定类别名。请提供「类别,频数」两列,或粘贴单列原始缺陷标签(将自动计数)。' };
    }
    cells.forEach((r) => add(r[0], 1));
    notes.push('单列标签已按出现次数自动计数');
  } else {
    // 多列:先识别「序号列」以免把行号当频数(常见 Excel 序号,类别,频数)。
    // 关键:仅当存在 ≥2 个完整数值列时,才允许把某个严格递增整数列当序号剔除——
    // 否则会把唯一的频数列(恰好是 1,2,3…)误当序号删掉,导致"找不到频数"。
    const maxLen = Math.max(...cells.map((r) => r.length));
    const numericCols: number[] = [];
    for (let j = 0; j < maxLen; j++) {
      const col = cells.map((r) => r[j]).filter((c): c is string => c != null);
      if (col.length === cells.length && col.every(isNum)) numericCols.push(j);
    }
    let indexCol = -1;
    if (numericCols.length >= 2) {
      for (const j of numericCols) {
        const col = cells.map((r) => r[j]).filter((c): c is string => c != null);
        if (isIndexColumn(col)) { indexCol = j; break; }
      }
    }
    for (const [li, r] of cells.entries()) {
      const name = r.find((c) => !isNum(c));
      const nums = r.map((c, j) => ({ c, j })).filter((x) => isNum(x.c) && x.j !== indexCol);
      if (name == null || nums.length === 0) {
        return { error: `第 ${li + 1} 行无法解析(需要 1 个类别名 + 1 个频数):「${r.join(' ')}」` };
      }
      if (nums.length > 1) {
        return { error: `第 ${li + 1} 行含多个数值列,无法确定哪列是频数;请只保留「类别,频数」两列(或加一列序号)。` };
      }
      const v = parseFloat(nums[0].c);
      if (v < 0) return { error: `第 ${li + 1} 行频数为负(${v}),频数必须 ≥ 0` };
      add(name, v);
    }
    if (indexCol >= 0) notes.push('已识别并忽略序号列');
  }

  const rows = order.map((name) => ({ name, count: merged.get(name)! }));
  if (rows.length === 0) return { error: '没有解析到任何类别' };
  if (rows.every((r) => r.count === 0)) return { error: '所有类别的频数都是 0,无法绘制帕累托图' };
  return { rows, note: notes.length ? notes.join(';') : undefined };
}
