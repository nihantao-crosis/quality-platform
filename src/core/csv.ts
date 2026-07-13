/**
 * CSV / 剪贴板数据解析 — 自动识别分隔符与表头。
 * 数值列构成测量矩阵；文本列保留（供 ANOVA 分组 / Gage 部件·操作员列）。
 */

export interface TextColumn {
  name: string;
  values: string[]; // 与保留的数据行对齐
}

export interface ParsedMatrix {
  colNames: string[]; // 数值列名
  rows: number[][];
  textCols: TextColumn[];
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
  if (numericCols.length > 10) return { error: `检测到 ${numericCols.length} 个数值列，子组大小上限为 10（控制图常数表范围）` };

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

  const textCols: TextColumn[] = textColIdx.map((_, t) => ({ name: textNames[t], values: textVals[t] }));
  return { colNames, rows, textCols, totalLines: body.length, skippedRows: skipped, droppedCols: textCols.length };
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

// ---------- 帕累托专用:类别 + 频数 ----------

export interface CategoryCounts {
  rows: { name: string; count: number }[];
  /** 解析器做过的自动处理说明(如横向转置/剥离表头),用于 toast 告知用户 */
  note?: string;
}

const CAT_HEADER_RE = /^(类别|名称|缺陷|项目|原因|category|name|defect|item)$/i;
const CNT_HEADER_RE = /^(count|counts|频数|数量|次数|频次|frequency|freq)$/i;

/** 解析「缺陷类别 + 频数」数据(帕累托)。与 parseMatrix 完全独立,规则:
 *  1. 横向 2×N(类别一行/频数一行)→ 自动转置;
 *  2. 纵向 文本列+数值列 → 直取;表头仅在命中关键词时剥离(不做「首行含文本即表头」的误判);
 *  3. 单列文本标签 → 按出现次数 tally 聚合;
 *  4. ≥1 个类别即可;频数须为非负数;同名类别自动合并求和。 */
/** 分隔符探测(帕累托专用):Tab/逗号/分号之外,额外支持「文本 + 空白 + 数字」的空格分隔。 */
function detectCatDelimiter(lines: string[]): string {
  const first = lines[0];
  if (/\t/.test(first)) return '\t';
  if (/,/.test(first)) return ',';
  if (/;/.test(first)) return ';';
  const spaceLike = lines.filter((l) => /\S\s+\S/.test(l)).length;
  return spaceLike >= Math.ceil(lines.length * 0.6) ? ' ' : ',';
}

/** 一列是否为「序号列」:全为整数且严格递增(常见 1..N 序号)。 */
function isIndexColumn(vals: string[]): boolean {
  if (vals.length < 2 || !vals.every((v) => /^\d+$/.test(v))) return false;
  const nums = vals.map(Number);
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) return false;
  return true;
}

export function parseCategoryCounts(text: string): CategoryCounts | { error: string } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return { error: '没有可解析的内容。期望格式:「类别,频数」两列(纵向)或「类别一行 + 频数一行」(横向),也可粘贴单列原始缺陷标签。' };

  const delim = detectCatDelimiter(lines);
  const splitLine = (l: string): string[] =>
    (delim === ' ' ? l.split(/\s+/) : l.split(delim)).map((c) => c.trim()).filter((c) => c !== '');
  let cells = lines.map(splitLine);
  const notes: string[] = [];
  if (delim === ' ') notes.push('已按空格分隔解析');

  // 规则 1:横向布局(恰 2 行),支持带行首标签(类别/频数)的 Excel 横向表
  if (cells.length === 2 && cells[0].length >= 2 && cells[0].length === cells[1].length) {
    const [r0, r1] = cells;
    if (r0.every((c) => !isNum(c)) && r1.every((c) => isNum(c))) {
      cells = r0.map((name, i) => [name, r1[i]]);
      notes.push('检测到横向数据(类别一行/频数一行),已自动转置');
    } else if (!isNum(r1[0]) && r0.slice(1).every((c) => !isNum(c)) && r1.slice(1).every((c) => isNum(c))) {
      cells = r0.slice(1).map((name, i) => [name, r1[i + 1]]);
      notes.push('检测到带行标签的横向数据,已剥离标签并转置');
    }
  }

  // 关键词表头剥离(仅纵向、明确命中时)
  if (cells.length >= 2 && cells[0].length >= 2
      && CAT_HEADER_RE.test(cells[0][0]) && cells[0].slice(1).some((c) => CNT_HEADER_RE.test(c))) {
    cells = cells.slice(1);
    notes.push('已识别并跳过表头行');
  } else if (cells.length >= 2 && cells[0].length === 1 && CAT_HEADER_RE.test(cells[0][0])) {
    cells = cells.slice(1);
    notes.push('已识别并跳过表头行');
  }

  const merged = new Map<string, number>();
  const order: string[] = [];
  const add = (name: string, count: number) => {
    if (!merged.has(name)) order.push(name);
    merged.set(name, (merged.get(name) ?? 0) + count);
  };

  if (cells.every((r) => r.length === 1)) {
    // 单列:全数值无从命名类别;含文本则按标签 tally
    if (cells.every((r) => isNum(r[0]))) {
      return { error: '仅有一列数值,无法确定类别名。请提供「类别,频数」两列,或粘贴单列原始缺陷标签(将自动计数)。' };
    }
    cells.forEach((r) => add(r[0], 1));
    notes.push('单列标签已按出现次数自动计数');
  } else {
    // 多列:先识别「序号列」以免把行号当频数(常见 Excel 序号,类别,频数)
    const maxLen = Math.max(...cells.map((r) => r.length));
    let indexCol = -1;
    for (let j = 0; j < maxLen; j++) {
      const col = cells.map((r) => r[j]).filter((c): c is string => c != null);
      if (col.length === cells.length && isIndexColumn(col)) { indexCol = j; break; }
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
