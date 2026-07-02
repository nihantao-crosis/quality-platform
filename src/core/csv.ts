/**
 * CSV / 剪贴板数据解析 — 自动识别分隔符与表头，仅保留数值列。
 */

export interface ParsedMatrix {
  colNames: string[];
  rows: number[][];
  totalLines: number; // 数据行总数（不含表头）
  skippedRows: number; // 含缺失/非法值被跳过的行
  droppedCols: number; // 被丢弃的非数值列数
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

  const nCols = Math.max(...body.map((r) => r.length));
  // 数值列：≥80% 行可解析为数
  const numericCols: number[] = [];
  for (let j = 0; j < nCols; j++) {
    const vals = body.map((r) => r[j] ?? '');
    const ok = vals.filter((v) => isNum(v)).length;
    if (ok / vals.length >= 0.8) numericCols.push(j);
  }
  if (numericCols.length === 0) return { error: '未检测到数值列' };
  if (numericCols.length > 10) return { error: `检测到 ${numericCols.length} 个数值列，子组大小上限为 10（控制图常数表范围）` };

  const colNames = numericCols.map((j, idx) => {
    const h = header?.[j]?.trim();
    return h && !isNum(h) ? h : `C${idx + 1}`;
  });

  const rows: number[][] = [];
  let skipped = 0;
  for (const r of body) {
    const vals = numericCols.map((j) => parseFloat(r[j] ?? ''));
    if (vals.some((v) => !Number.isFinite(v))) skipped++;
    else rows.push(vals);
  }
  if (rows.length < 2) return { error: '有效数据行不足 2 行' };

  return { colNames, rows, totalLines: body.length, skippedRows: skipped, droppedCols: nCols - numericCols.length };
}
