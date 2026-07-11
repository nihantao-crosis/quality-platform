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
