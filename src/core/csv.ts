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
  /** 原始数据区的最大列数(不含表头与数据全空的整列)；用于专用格式拒绝未识别/被忽略的额外列。 */
  sourceColumnCount: number;
  totalLines: number; // 数据行总数（不含表头）
  skippedRows: number; // 数值列含缺失/非法值被跳过的行
  droppedCols: number; // 保留的文本列数（向后兼容字段名）
}

/** 数据行数上限(第三轮 P1):只限字节不限行数时,17MB 的 260 万行窄表可合法导入,
 * 随后每次编辑深拷贝全表 3.5–12s、约 20 次编辑后 OOM。20 万行是实测的性能包线。
 * 定义在 core(解析层执行),platform/importLimits 再导出供 UI 文案使用。 */
export const MAX_IMPORT_DATA_ROWS = 200_000;
/** 工作表列数上限:两行 × 250 万列的 CSV 曾被成功解析成 250 万列(蜂群 P2-01)。 */
export const MAX_IMPORT_DATA_COLS = 5_000;
/** 工作表单元格总数上限:行×列的乘积预算,防止「行不超、列不超、乘积爆炸」。 */
export const MAX_IMPORT_DATA_CELLS = 2_000_000;
/** 单个文本单元格字符数上限。 */
export const MAX_IMPORT_CELL_CHARS = 32_768;
/** 列名长度上限(盲审 P2:renameColumn 曾接受 500 万字符列名,绕过单元格上限
 * 直接写进 localStorage 与撤销栈)。列名会进表头、图例、导出文件名与报告标题,
 * 上限比单元格严得多。 */
export const MAX_COLUMN_NAME_CHARS = 200;
/** 活动工作表与“最近数据集”共用的名称上限。 */
export const MAX_DATASET_NAME_CHARS = 200;
/** 最近数据集是快速入口而非历史库；写入和 .qproj 读入必须同一上限。 */
export const MAX_RECENT_DATASETS = 5;
/**
 * SQLite vault 是内部工作表库而非无界对象存储。项目导入、导出快照与原生写入
 * 都必须执行同一数量上限，避免大量极小工作表把 JSON 解析、IPC 与事务放大。
 */
export const MAX_VAULT_DATASETS = 1_000;
/** ISO 时间戳通常 24 字符，留出旧版本标记余量但防止巨型 DOM 字段。 */
export const MAX_SAVED_AT_CHARS = 64;

/**
 * P/C 计数图与工作表共用 20 万条的交互性能包线。P 图会为每个样本
 * 派生比例、样本量和上/下限等多个等长数组，因此不能只依赖 64 MB QPROJ 字节上限。
 */
export const MAX_ATTRIBUTE_CHART_POINTS = MAX_IMPORT_DATA_ROWS;

/**
 * 独立 I-MR 观测序列与普通工作表共用同一条 20 万点产品性能包线。
 * indivSeries 可以有意与 rows 展平值不同，但不能借此旁路绕过正式 I-MR 上限。
 */
export const MAX_INDIVIDUAL_SERIES_POINTS = MAX_IMPORT_DATA_ROWS;

/** 鱼骨图是交互列表和报告内容，而非通用文本库；写入与 QPROJ 导入共用以下上限。 */
export const MAX_FISHBONE_PROBLEM_CHARS = 200;
export const MAX_FISHBONE_CATEGORY_CHARS = 100;
export const MAX_FISHBONE_CAUSE_CHARS = 500;
export const MAX_FISHBONE_CAUSES_PER_CATEGORY = 200;
export const MAX_FISHBONE_TOTAL_CAUSES = 1_000;

/** 项目工作台本来只保留最近 40 条；运行时写入与 QPROJ 恢复必须同一上限。 */
export const MAX_SAVED_ANALYSES = 40;
/** 去重工作表库至多与 40 条历史一一对应，key 只用于本机引用而非正文存储。 */
export const MAX_ANALYSIS_DATA_ENTRIES = MAX_SAVED_ANALYSES;
export const MAX_ANALYSIS_ID_CHARS = 200;
export const MAX_ANALYSIS_DATA_KEY_CHARS = 120;
export const MAX_ANALYSIS_LABEL_CHARS = 500;

export function attributeChartResourceError(pointCount: number): string | null {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) return '计数图序列长度无效';
  if (pointCount > MAX_ATTRIBUTE_CHART_POINTS) {
    return `计数图序列长度 ${pointCount.toLocaleString()} 超过 ${MAX_ATTRIBUTE_CHART_POINTS.toLocaleString()} 点上限；请拆分批次或先在外部汇总`;
  }
  return null;
}

/** 只读取数组 length 的快速闸门；调用方必须在扫描/复制序列前调用。 */
export function individualSeriesResourceError(pointCount: number): string | null {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) return 'I-MR 独立序列长度无效';
  if (pointCount > MAX_INDIVIDUAL_SERIES_POINTS) {
    return `I-MR 独立序列长度 ${pointCount.toLocaleString()} 超过 ${MAX_INDIVIDUAL_SERIES_POINTS.toLocaleString()} 点上限；请拆分批次或先在外部抽样`;
  }
  return null;
}

/**
 * 调用方先校验 problem/category 的类型与 causes 是数组；本函数只负责资源预算。
 * cause 允许暂为 unknown，使项目导入可先按数量拒绝百万项数组，无需先遍历全部元素。
 */
export function fishboneResourceError(data: {
  problem: string;
  categories: ReadonlyArray<{ name: string; causes: ReadonlyArray<unknown> }>;
}): string | null {
  if (data.problem.length > MAX_FISHBONE_PROBLEM_CHARS) {
    return `鱼骨图问题超过 ${MAX_FISHBONE_PROBLEM_CHARS} 字符上限`;
  }
  let totalCauses = 0;
  for (const category of data.categories) {
    if (category.name.length > MAX_FISHBONE_CATEGORY_CHARS) {
      return `鱼骨图分类名称超过 ${MAX_FISHBONE_CATEGORY_CHARS} 字符上限`;
    }
    if (category.causes.length > MAX_FISHBONE_CAUSES_PER_CATEGORY) {
      return `鱼骨图单个分类原因数超过 ${MAX_FISHBONE_CAUSES_PER_CATEGORY.toLocaleString()} 条上限`;
    }
    totalCauses += category.causes.length;
    if (totalCauses > MAX_FISHBONE_TOTAL_CAUSES) {
      return `鱼骨图原因总数超过 ${MAX_FISHBONE_TOTAL_CAUSES.toLocaleString()} 条上限`;
    }
  }
  for (const category of data.categories) {
    if (category.causes.some((cause) => typeof cause === 'string' && cause.length > MAX_FISHBONE_CAUSE_CHARS)) {
      return `鱼骨图单条原因超过 ${MAX_FISHBONE_CAUSE_CHARS} 字符上限`;
    }
  }
  return null;
}

/**
 * 工作表资源预算的**唯一**校验器(蜂群 P1-02)。
 * CSV/XLSX/剪贴板/.qproj stores/vault/SQLite 写入/启动恢复必须全部复用它——
 * 此前只有 CSV 解析处判行数,.qproj 与 vault 只校验结构和有限数,
 * 9.54 MiB 的项目可携带 250 万×1 行,写进 SQLite 后每次启动同步 JSON.parse +
 * computeVarModel,形成持续启动卡死/OOM,需手工清理应用数据才能恢复。
 */
export function worksheetResourceError(dims: {
  rows: number;
  cols: number;
  textCols?: number;
  maxCellChars?: number;
  maxColumnNameChars?: number;
}): string | null {
  const { rows, cols, textCols = 0, maxCellChars = 0 } = dims;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols)
    || !Number.isSafeInteger(textCols) || rows < 0 || cols < 0 || textCols < 0) {
    return '工作表维度无效';
  }
  if (rows > MAX_IMPORT_DATA_ROWS) {
    return `数据行数 ${rows.toLocaleString()} 超过 ${MAX_IMPORT_DATA_ROWS.toLocaleString()} 行上限；请拆分或先在外部抽样`;
  }
  const totalCols = cols + textCols;
  if (totalCols > MAX_IMPORT_DATA_COLS) {
    return `数据列数 ${totalCols.toLocaleString()} 超过 ${MAX_IMPORT_DATA_COLS.toLocaleString()} 列上限；请先在外部转置或裁剪`;
  }
  const cells = rows * totalCols;
  if (cells > MAX_IMPORT_DATA_CELLS) {
    return `单元格总数 ${cells.toLocaleString()} 超过 ${MAX_IMPORT_DATA_CELLS.toLocaleString()} 上限；请缩小数据范围`;
  }
  if (dims.maxColumnNameChars != null && dims.maxColumnNameChars > MAX_COLUMN_NAME_CHARS) {
    return `列名长度 ${dims.maxColumnNameChars.toLocaleString()} 超过 ${MAX_COLUMN_NAME_CHARS} 字符上限`;
  }
  if (maxCellChars > MAX_IMPORT_CELL_CHARS) {
    return `单个单元格文本长度 ${maxCellChars.toLocaleString()} 超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
  }
  return null;
}

/**
 * 待录入坐标与工作表共用的唯一不变量。
 *
 * 必须先只读数组 length 执行数量闸门，再遍历元素；否则攻击者可在很小的
 * rows/cols 矩阵旁附带百万级 pendingCells，让项目校验、SQLite 恢复或运行时
 * 导入在最终丢弃这些坐标之前先耗尽 CPU/内存。
 */
export function worksheetPendingCellsError(
  pendingCells: unknown,
  dims: { rows: number; cols: number },
): string | null {
  if (!Array.isArray(pendingCells)) return 'pendingCells 不是数组';
  const { rows, cols } = dims;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 0 || cols < 0) {
    return 'pendingCells 对应的工作表维度无效';
  }

  const matrixCells = rows * cols;
  if (!Number.isSafeInteger(matrixCells)) return 'pendingCells 对应的工作表维度无效';
  if (matrixCells > MAX_IMPORT_DATA_CELLS) {
    return `pendingCells 对应的工作表单元格总数 ${matrixCells.toLocaleString()} 超过上限 ${MAX_IMPORT_DATA_CELLS.toLocaleString()}`;
  }
  const limit = Math.min(matrixCells, MAX_IMPORT_DATA_CELLS);
  if (pendingCells.length > limit) {
    return `pendingCells 数量 ${pendingCells.length.toLocaleString()} 超过待录入坐标上限 ${limit.toLocaleString()}`;
  }

  // 合法工作表至多 200 万格，用位图去重只需约 2 MB；超大矩阵
  // 已在上方遍历 pendingCells 之前拒绝，不再回落百万项 Set。
  const seen = new Uint8Array(matrixCells);
  for (const cell of pendingCells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
      return 'pendingCells 包含无效坐标';
    }
    const { row, col } = cell as { row?: unknown; col?: unknown };
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col)) {
      return 'pendingCells 包含无效坐标';
    }
    const numericRow = row as number;
    const numericCol = col as number;
    if (numericRow < 0 || numericRow >= rows || numericCol < 0 || numericCol >= cols) {
      return `pendingCells 坐标越界 (${numericRow}, ${numericCol})`;
    }
    const key = numericRow * cols + numericCol;
    if (seen[key] === 1) {
      return `pendingCells 包含重复坐标 (${numericRow}, ${numericCol})`;
    }
    seen[key] = 1;
  }
  return null;
}

// 合法数值形态:允许 +1.5 / .5 / 1.(Excel/Minitab 均接受);仍拒绝 1O、0x10 等畸形串。
// 行级解析必须与本判定同口径(双审 P2):此前列分类用严格正则、取值却用 parseFloat,
// 「1O」被静默取成 1、「0x10」取成 0 混入统计且 skippedRows=0。
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function isNum(s: string): boolean {
  return NUM_RE.test(s.trim());
}

/**
 * 引号口径(CORE-05,RFC 4180 / Excel 同款宽松规则):只有位于**字段起始**(可有前导空白)
 * 的 `"` 才开启引号字段;非引号字段中部的 `"` 是字面量(1/2" 螺栓、12" 管)。引号字段内
 * `""` 为转义引号,单个 `"` 关闭引号;关闭后同一字段内再出现的 `"` 仍按字面量处理。
 * 所有逐字符扫描器(记录拆分、单元格拆分、列宽测量、分隔符计数、帕累托预检)共用
 * quoteOpensAt 这一判定,否则资源预检与实际拆分会对同一文本给出不同的列数/记录数。
 * 分隔符未定时(嗅探首条记录/帕累托预检)把三种候选分隔符都视为字段边界。
 */
const ANY_DELIMITER = '\t,;';

function isFieldBoundary(ch: string, delimiter: string): boolean {
  if (delimiter === ' ') return /\s/.test(ch);
  return delimiter.length === 1 ? ch === delimiter : delimiter.includes(ch);
}

/**
 * 引号外位置 i 的 `"` 是否位于字段起始:向前跳过空白,到达文本开头、换行或字段边界即是;
 * 碰到任何非空白字符(包括刚闭合的引号)即不是。只在遇到引号时回看,热循环不增加逐字符
 * 分支;每段空白至多被一次回看扫描,整体仍为线性。
 */
function quoteOpensAt(src: string, i: number, delimiter: string): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const prev = src[j];
    if (prev === '\n' || prev === '\r' || isFieldBoundary(prev, delimiter)) return true;
    if (prev.trim() !== '') return false;
  }
  return true;
}

/**
 * 用候选分隔符集合切出首条非空逻辑记录再判分隔符;后续按该分隔符做真正的记录拆分。
 * CORE-05 复审:切首条记录(splitQuotedRecords)、分隔符计数(detectDelimiter)与帕累托预检
 * (inspectParetoText)三处在分隔符未定时**同一口径**——三种候选都视为字段边界(ANY_DELIMITER)。
 * 若计数时只把「当前候选」当边界,`"Nr";"Wert, mm"` 里跟在分号后的引号字段会在数逗号时被当成
 * 字面量,引号内的逗号被计入,分号 CSV 被误判为逗号分隔(静默错列)。
 */
function sniffDelimiter(text: string): string {
  const first = splitQuotedRecords(text, 0, ANY_DELIMITER);
  const line = first.records[0];
  return line === undefined ? ',' : detectDelimiter(line);
}

function detectDelimiter(line: string): string {
  // 只统计引号外的分隔符:RFC-4180 引号字段内的逗号不是分隔符(Excel→SheetJS 的主要形态)
  const counts: Array<[string, number]> = [
    ['\t', delimiterCountOutsideQuotes(line, '\t', ANY_DELIMITER)],
    [',', delimiterCountOutsideQuotes(line, ',', ANY_DELIMITER)],
    [';', delimiterCountOutsideQuotes(line, ';', ANY_DELIMITER)],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export interface CsvBlock {
  /** 显示名:块最后一个表头(工厂三列块即测量项名) */
  name: string;
  headers: string[];
  /** 检测顺序中的稳定序号（1-based），用于避免同名块持久化时互相覆盖。 */
  ordinal: number;
  /** 0-based:块在原文中的表头行号与起始列号 */
  headerRow: number;
  colStart: number;
  colEnd: number;
  /** 数据行数(不含表头) */
  rows: number;
  /** 表头与最后一个完整数据行之间被显式忽略的不完整行数。 */
  omittedRows: number;
  /** 该块重组的 CSV 文本,可直接走 parseMatrix */
  csv: string;
}

/** 同名表头也能区分的稳定块标签；预览做长度钳位，避免数据集名被异常表头放大。 */
export function csvBlockLabel(block: CsvBlock): string {
  const source = block.colStart === block.colEnd
    ? `源列 C${block.colStart + 1}`
    : `源列 C${block.colStart + 1}–C${block.colEnd + 1}`;
  const preview = block.headers
    .slice(0, 3)
    .map((header) => {
      const compact = header.replace(/\s+/g, ' ').trim();
      return compact.length > 24 ? compact.slice(0, 23) + '…' : compact;
    })
    .filter(Boolean)
    .join('/');
  const suffix = block.headers.length > 3 ? '/…' : '';
  return `第 ${block.ordinal} 块 · ${source} · ${preview || block.name}${suffix}`;
}

/**
 * 检测「并排多表格块 / 带前置说明区」的工作表(v1.40 工厂 MSA 案例工作簿):
 * 列按「全空列」分隔成组;每组内找首个「整组各列连续两行均非空」的行作表头,
 * 表头前的说明区(合并单元格残留)忽略,数据行取到该组首个不完整行为止。
 * 返回全部候选块;导入层约定:>1 块必须让用户显式选择,恰 1 块仅在整表解析失败时作为回退。
 */
export function detectCsvBlocks(text: string): CsvBlock[] {
  // 弹窗的文件/剪贴板路径会在 parseMatrix 之前先做数据块检测。这里必须共用
  // 同一资源包线，否则超宽剪贴板会先在 grid 中构造整表单元格数组，绕过
  // parseMatrix 里的拒绝。
  const clean = text.replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(clean);
  const logical = splitQuotedRecords(clean, MAX_IMPORT_DATA_ROWS + 1, delim);
  if (logical.tooManyRecords) return [];
  if (logical.recordTooLong || logical.unclosedQuote) return [];
  const lines = logical.records;
  if (lines.length === 0) return [];
  if (delimitedRecordBudgetError(lines, delim, 1)) return [];
  const grid = lines.map((line) => splitDelimitedLine(line, delim));
  let width = 0;
  for (const row of grid) if (row.length > width) width = row.length;
  if (width < 1 || grid.length < 3) return [];
  const used = Array.from({ length: width }, (_, j) => grid.some((row) => (row[j] ?? '') !== ''));
  const groups: Array<[number, number]> = [];
  let start = -1;
  for (let j = 0; j <= width; j++) {
    const on = j < width && used[j];
    if (on && start < 0) start = j;
    if (!on && start >= 0) { groups.push([start, j - 1]); start = -1; }
  }
  const blocks: CsvBlock[] = [];
  for (const [c0, c1] of groups) {
    const full = (row: string[]) => {
      for (let j = c0; j <= c1; j++) if ((row[j] ?? '') === '') return false;
      return true;
    };
    let headerRow = -1;
    for (let r = 0; r + 1 < grid.length; r++) {
      if (full(grid[r]) && full(grid[r + 1])) { headerRow = r; break; }
    }
    if (headerRow < 0) continue;
    const headers = grid[headerRow].slice(c0, c1 + 1);
    // 不能在首个不完整行处 break：中间缺值曾把其后的完整实测行全部静默截掉。
    // 扫到最后一个完整行为止，保留全部完整行；被忽略的不完整行另行计数并在 UI
    // 明示。末尾说明/空白仍不会进入候选块。
    let lastFullRow = -1;
    let completeRows = 0;
    for (let r = headerRow + 1; r < grid.length; r++) {
      if (full(grid[r])) {
        lastFullRow = r;
        completeRows++;
      }
    }
    if (completeRows < 2 || lastFullRow < 0) continue;
    const sourceRows = grid
      .slice(headerRow + 1, lastFullRow + 1)
      .map((row) => row.slice(c0, c1 + 1));
    const dataRows = sourceRows.filter((row) => row.every((cell) => cell !== ''));
    const omittedRows = sourceRows.length - dataRows.length;
    // 重组用原分隔符 + RFC-4180 引号转义:引号感知拆分后单元格可能含分隔符/引号/换行,
    // 必须规范转义;消费方 parseMatrix 已支持解引号,往返无损(Codex 复审 P1 闭环)。
    // CORE-05 复审:block.csv 会被 parseMatrix **重新嗅探**分隔符,含任一候选分隔符(Tab/逗号/分号)
    // 的单元格都要加引号——否则分号块里的「Wert, mm」裸写会让逗号与分号打平,被误判为逗号分隔。
    const headerless = headers.every((cell) => isNum(cell));
    blocks.push({
      name: headerless ? `第${c0 + 1}列起` : headers[headers.length - 1] || `第${c0 + 1}列起`,
      headers: [...headers],
      ordinal: blocks.length + 1,
      headerRow,
      colStart: c0,
      colEnd: c1,
      // 纯数字「表头」实为首个数据行(parseMatrix 同判),行数按数据行如实上报
      rows: headerless ? dataRows.length + 1 : dataRows.length,
      omittedRows,
      csv: [headers, ...dataRows].map((row) => row.map((cell) =>
        /[\t,;"\r\n]/.test(cell) || cell.includes(delim)
          ? '"' + cell.replace(/"/g, '""') + '"'
          : cell).join(delim)).join('\n'),
    });
  }
  return blocks;
}

export function parseMatrix(text: string): ParsedMatrix | { error: string } {
  // RFC-4180 引号支持(Codex 复审 P1):Excel→SheetJS 的 CSV 对含分隔符/换行的单元格加引号,
  // 裸 split 会把「"OK, 复检"」劈成两列造成静默错列;按逻辑记录+引号感知拆分。
  const clean = text.replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(clean);
  const logical = splitQuotedRecords(clean, MAX_IMPORT_DATA_ROWS + 1, delim);
  if (logical.tooManyRecords) {
    return { error: `数据行数超过 ${MAX_IMPORT_DATA_ROWS.toLocaleString()} 行上限；请拆分或先在外部抽样` };
  }
  // 盲审 P2:资源闸先于语法判定——单条逻辑记录超长时,继续逐字符累积会把整份文本
  // 复制进内存(17MB 输入实测堆峰值 ~600MB),必须在这里就以专有文案拒绝。
  if (logical.recordTooLong) {
    return { error: '单条数据记录过长（可能是引号未闭合或缺少换行），已停止解析；请检查文件格式或先在外部拆分' };
  }
  if (logical.unclosedQuote) return { error: 'CSV 引号未闭合，请检查含分隔符或换行的引号字段。' };
  const lines = logical.records;
  if (lines.length < 2) return { error: '数据不足：至少需要 2 行' };

  // 先用常数空间扫描首行；超宽首行不得为了判断表头而先构造数百万个字符串。
  const firstMeasure = measureDelimitedLine(lines[0], delim);
  const firstWidthError = worksheetResourceError({ rows: 0, cols: firstMeasure.columns });
  if (firstWidthError) return { error: firstWidthError };
  const firstCellError = worksheetResourceError({ rows: 0, cols: 0, maxCellChars: firstMeasure.maxCellChars });
  if (firstCellError) return { error: firstCellError };
  const firstCells = splitDelimitedLine(lines[0], delim);

  // 表头：首行任一单元非数值即视为表头
  const hasHeader = firstCells.some((c) => c !== '' && !isNum(c));
  const bodyStart = hasHeader ? 1 : 0;
  const budgetError = delimitedRecordBudgetError(lines, delim, bodyStart, firstMeasure);
  if (budgetError) return { error: budgetError };

  // 只有完整预检通过后才构造全部单元格数组；文件与剪贴板共用本入口。
  const cells = new Array<string[]>(lines.length);
  cells[0] = firstCells;
  for (let i = 1; i < lines.length; i++) cells[i] = splitDelimitedLine(lines[i], delim);
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
    const vals = numericCols.map((j) => { const cell = (r[j] ?? '').trim(); return isNum(cell) ? parseFloat(cell) : Number.NaN; });
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
  // CORE-04 复审:表头与数据全空的整列(Excel 选区含空白 A 列、Tab 行首不再被 trim 吞掉)不计入
  // 原始列数,与帕累托自动路径的整列空白剥离同口径;专用格式(P 图)只按有内容的列判定。
  let sourceColumnCount = 0;
  for (let j = 0; j < nCols; j++) {
    if ((header?.[j] ?? '').trim() !== '' || body.some((r) => (r[j] ?? '').trim() !== '')) sourceColumnCount++;
  }
  return { colNames, rows, textCols, sourceColumnCount, totalLines: body.length, skippedRows: skipped, droppedCols: textCols.length };
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
export const MAX_PARETO_CATEGORIES = 50_000;
const MAX_PARETO_RAW_RECORDS = MAX_IMPORT_DATA_ROWS;
const MAX_PARETO_FIELDS = MAX_IMPORT_DATA_CELLS;

/** 解析「缺陷类别 + 频数」数据(帕累托)。与 parseMatrix 完全独立,规则:
 *  1. 横向 2×N(类别一行/频数一行)→ 自动转置;
 *  2. 纵向 文本列+数值列 → 直取;表头仅在命中关键词时剥离(不做「首行含文本即表头」的误判);
 *  3. 单列文本标签 → 按出现次数 tally 聚合;
 *  4. ≥1 个类别即可;频数须为非负数;同名类别自动合并求和。 */
/** 分隔符探测(帕累托专用):Tab/逗号/分号之外,额外支持「文本 + 空白 + 数字」的空格分隔。 */
/** `boundary` 决定引号是否位于字段起始;分隔符未定(嗅探)时必须传 ANY_DELIMITER,见 sniffDelimiter。 */
function delimiterCountOutsideQuotes(line: string, delimiter: string, boundary: string): number {
  let quoted = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && (quoted || quoteOpensAt(line, i, boundary))) {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && line[i] === delimiter) count++;
  }
  return count;
}

/**
 * 帕累托文本的常数空间前置扫描。只记录首条逻辑记录的分隔符计数和全表记录数，
 * 不创建 records/cells 数组；这样超多窄行不会先把几十万条字符串留在内存里。
 */
function inspectParetoText(text: string): {
  delimiter: string;
  records: number;
  error?: string;
} {
  let quoted = false;
  let records = 0;
  let recordHasContent = false;
  let sawNonWhitespace = false;
  let sawWhitespaceAfterContent = false;
  let recordIsSpaceLike = false;
  let spaceLikeRecords = 0;
  let recordCounts = { tab: 0, comma: 0, semicolon: 0 };
  let firstCounts: typeof recordCounts | null = null;

  const observe = (ch: string) => {
    if (/\s/.test(ch)) {
      // 空格分隔只认引号外空白；"Failure Mode" 内的空格属于同一类别。
      if (quoted) return;
      if (sawNonWhitespace) sawWhitespaceAfterContent = true;
      return;
    }
    recordHasContent = true;
    if (sawWhitespaceAfterContent) recordIsSpaceLike = true;
    sawNonWhitespace = true;
  };
  const finishRecord = (): string | null => {
    if (recordHasContent) {
      records++;
      if (!firstCounts) firstCounts = { ...recordCounts };
      if (recordIsSpaceLike) spaceLikeRecords++;
      if (records > MAX_PARETO_RAW_RECORDS) {
        return `帕累托原始记录数超过 ${MAX_PARETO_RAW_RECORDS.toLocaleString()} 条上限；请先在外部汇总或拆分`;
      }
    }
    recordHasContent = false;
    sawNonWhitespace = false;
    sawWhitespaceAfterContent = false;
    recordIsSpaceLike = false;
    recordCounts = { tab: 0, comma: 0, semicolon: 0 };
    return null;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // 分隔符此时未定:三种候选分隔符都视为字段边界。
    if (ch === '"' && (quoted || quoteOpensAt(text, i, ANY_DELIMITER))) {
      observe(ch);
      if (quoted && text[i + 1] === '"') {
        observe(text[++i]);
      } else quoted = !quoted;
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      const error = finishRecord();
      if (error) return { delimiter: ',', records, error };
    } else {
      observe(ch);
      if (!quoted) {
        if (ch === '\t') recordCounts.tab++;
        else if (ch === ',') recordCounts.comma++;
        else if (ch === ';') recordCounts.semicolon++;
      }
    }
  }
  const error = finishRecord();
  if (error) return { delimiter: ',', records, error };

  const counts = firstCounts ?? { tab: 0, comma: 0, semicolon: 0 };
  const ranked: Array<[string, number]> = [
    ['\t', counts.tab],
    [',', counts.comma],
    [';', counts.semicolon],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const delimiter = ranked[0][1] > 0
    ? ranked[0][0]
    : spaceLikeRecords >= Math.ceil(records * 0.6) ? ' ' : ',';
  // records/引号状态按 ANY_DELIMITER 口径统计,只用于选分隔符(空格分隔判定)与早期行数闸;
  // 未闭合判定与资源预算用的记录数由 quotedRecordStats 按**最终分隔符**重算(CORE-05 复审 P3)。
  return { delimiter, records };
}

/**
 * 按最终选定的分隔符再次做常数空间扫描，限制真实最大列宽、实际字段总数和
 * 解码/trim 后的单格字符数。所有检查均发生在 splitQuotedRecords/cells.map 之前。
 */
function paretoResourceError(text: string, delimiter: string, logicalRecords: number): string | null {
  let quoted = false;
  let recordHasContent = false;
  let columns = delimiter === ' ' ? 0 : 1;
  let totalFields = 0;
  let tokenStarted = false;
  let decodedLength = 0;
  let firstNonWhitespace = -1;
  let lastNonWhitespace = -1;

  const widthError = (width: number) => {
    if (width <= MAX_PARETO_CATEGORIES + 1) return null;
    return logicalRecords === 2
      ? `横向帕累托类别数超过 ${MAX_PARETO_CATEGORIES.toLocaleString()} 上限；请先在外部汇总后导入`
      : `帕累托单行列数超过 ${(MAX_PARETO_CATEGORIES + 1).toLocaleString()} 列上限；请先裁剪数据`;
  };
  const finishToken = (): string | null => {
    if (!tokenStarted) return null;
    const trimmedLength = firstNonWhitespace < 0 ? 0 : lastNonWhitespace - firstNonWhitespace + 1;
    if (trimmedLength > MAX_IMPORT_CELL_CHARS) {
      return `单个类别/频数单元格长度 ${trimmedLength.toLocaleString()} 超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
    }
    columns++;
    tokenStarted = false;
    decodedLength = 0;
    firstNonWhitespace = -1;
    lastNonWhitespace = -1;
    return widthError(columns);
  };
  const finishCell = (): string | null => {
    const trimmedLength = firstNonWhitespace < 0 ? 0 : lastNonWhitespace - firstNonWhitespace + 1;
    if (trimmedLength > MAX_IMPORT_CELL_CHARS) {
      return `单个类别/频数单元格长度 ${trimmedLength.toLocaleString()} 超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
    }
    decodedLength = 0;
    firstNonWhitespace = -1;
    lastNonWhitespace = -1;
    return null;
  };
  const appendDecoded = (ch: string) => {
    const index = decodedLength++;
    if (ch.trim() !== '') {
      if (firstNonWhitespace < 0) firstNonWhitespace = index;
      lastNonWhitespace = index;
    }
  };
  const finishRecord = (): string | null => {
    if (recordHasContent) {
      const cellError = delimiter === ' ' ? finishToken() : finishCell();
      if (cellError) return cellError;
      const rowWidthError = widthError(columns);
      if (rowWidthError) return rowWidthError;
      totalFields += columns;
      if (totalFields > MAX_PARETO_FIELDS) {
        return `帕累托原始单元格总数超过 ${MAX_PARETO_FIELDS.toLocaleString()} 上限；请先在外部汇总或缩小数据范围`;
      }
    }
    recordHasContent = false;
    columns = delimiter === ' ' ? 0 : 1;
    tokenStarted = false;
    decodedLength = 0;
    firstNonWhitespace = -1;
    lastNonWhitespace = -1;
    return null;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (quoted || (delimiter === ' ' ? !tokenStarted : quoteOpensAt(text, i, delimiter)))) {
      recordHasContent = true;
      if (delimiter === ' ') tokenStarted = true;
      if (quoted && text[i + 1] === '"') {
        appendDecoded('"');
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      const error = finishRecord();
      if (error) return error;
    } else if (delimiter === ' ') {
      if (!quoted && /\s/.test(ch)) {
        const error = finishToken();
        if (error) return error;
      } else {
        if (ch.trim() !== '') recordHasContent = true;
        tokenStarted = true;
        appendDecoded(ch);
        if (firstNonWhitespace >= 0 && lastNonWhitespace - firstNonWhitespace + 1 > MAX_IMPORT_CELL_CHARS) {
          return `单个类别/频数单元格长度超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
        }
      }
    } else if (!quoted && ch === delimiter) {
      recordHasContent = true;
      const error = finishCell();
      if (error) return error;
      columns++;
      const errorWidth = widthError(columns);
      if (errorWidth) return errorWidth;
    } else {
      if (ch.trim() !== '') recordHasContent = true;
      appendDecoded(ch);
      if (firstNonWhitespace >= 0 && lastNonWhitespace - firstNonWhitespace + 1 > MAX_IMPORT_CELL_CHARS) {
        return `单个类别/频数单元格长度超过 ${MAX_IMPORT_CELL_CHARS.toLocaleString()} 字符上限`;
      }
    }
  }
  return finishRecord();
}

/** RFC 4180 常见子集：保留空字段，支持双引号包裹、字段内分隔符与 "" 转义。 */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  if (delimiter === ' ') {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    let tokenStarted = false;
    const finish = () => {
      if (!tokenStarted) return;
      out.push(cell.trim());
      cell = '';
      tokenStarted = false;
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && (quoted || !tokenStarted)) {
        tokenStarted = true;
        if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && /\s/.test(ch)) finish();
      else { cell += ch; tokenStarted = true; }
    }
    finish();
    return out;
  }
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (quoted || quoteOpensAt(line, i, delimiter))) {
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

/**
 * 不构造单元格字符串数组，只计算按 splitDelimitedLine 规则解码后的真实列数与
 * 最大单元格长度。引号与 "" 转义不会被误当成内容，首尾空白也与 String.trim 同口径。
 */
function measureDelimitedLine(line: string, delimiter: string): { columns: number; maxCellChars: number } {
  if (delimiter === ' ') {
    let columns = 0;
    let maxCellChars = 0;
    let quoted = false;
    let tokenStarted = false;
    let decodedLength = 0;
    let firstNonWhitespace = -1;
    let lastNonWhitespace = -1;
    const append = (ch: string) => {
      const index = decodedLength++;
      if (ch.trim() !== '') {
        if (firstNonWhitespace < 0) firstNonWhitespace = index;
        lastNonWhitespace = index;
      }
    };
    const finish = () => {
      if (!tokenStarted) return;
      const trimmedLength = firstNonWhitespace < 0 ? 0 : lastNonWhitespace - firstNonWhitespace + 1;
      columns++;
      if (trimmedLength > maxCellChars) maxCellChars = trimmedLength;
      tokenStarted = false;
      decodedLength = 0;
      firstNonWhitespace = -1;
      lastNonWhitespace = -1;
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && (quoted || !tokenStarted)) {
        tokenStarted = true;
        if (quoted && line[i + 1] === '"') { append('"'); i++; }
        else quoted = !quoted;
      } else if (!quoted && /\s/.test(ch)) finish();
      else { tokenStarted = true; append(ch); }
    }
    finish();
    return { columns, maxCellChars };
  }

  let columns = 1;
  let maxCellChars = 0;
  let quoted = false;
  let decodedLength = 0;
  let firstNonWhitespace = -1;
  let lastNonWhitespace = -1;
  const append = (ch: string) => {
    const index = decodedLength++;
    if (ch.trim() !== '') {
      if (firstNonWhitespace < 0) firstNonWhitespace = index;
      lastNonWhitespace = index;
    }
  };
  const finishCell = () => {
    const trimmedLength = firstNonWhitespace < 0 ? 0 : lastNonWhitespace - firstNonWhitespace + 1;
    if (trimmedLength > maxCellChars) maxCellChars = trimmedLength;
    decodedLength = 0;
    firstNonWhitespace = -1;
    lastNonWhitespace = -1;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (quoted || quoteOpensAt(line, i, delimiter))) {
      if (quoted && line[i + 1] === '"') { append('"'); i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === delimiter) {
      finishCell();
      columns++;
    } else append(ch);
  }
  finishCell();
  return { columns, maxCellChars };
}

/** 全表单元格数组构建前的标量预检。maxCols 取所有数据记录的真实最大列数。 */
function delimitedRecordBudgetError(
  lines: string[],
  delimiter: string,
  bodyStart: number,
  firstMeasure?: { columns: number; maxCellChars: number },
): string | null {
  const rows = lines.length - bodyStart;
  if (rows > MAX_IMPORT_DATA_ROWS) {
    return `数据行数 ${rows.toLocaleString()} 超过 ${MAX_IMPORT_DATA_ROWS.toLocaleString()} 行上限；请拆分或先在外部抽样`;
  }
  let maxDataColumns = 0;
  for (let i = 0; i < lines.length; i++) {
    const measured = i === 0 && firstMeasure ? firstMeasure : measureDelimitedLine(lines[i], delimiter);
    const widthError = worksheetResourceError({ rows: 0, cols: measured.columns });
    if (widthError) return widthError;
    const cellError = worksheetResourceError({ rows: 0, cols: 0, maxCellChars: measured.maxCellChars });
    if (cellError) return cellError;
    if (i >= bodyStart && measured.columns > maxDataColumns) {
      maxDataColumns = measured.columns;
      // 用数据行数 × 真实最大行宽度计算实际工作表矩形预算，不再信任表头/首行宽度。
      const matrixError = worksheetResourceError({ rows, cols: maxDataColumns });
      if (matrixError) return matrixError;
    }
  }
  return null;
}

/**
 * 按逻辑 CSV 记录拆分：字段内换行保留，只有引号外换行才结束一条记录。
 * `delimiter` 决定「字段起始」位置(见 quoteOpensAt);分隔符未定时传 ANY_DELIMITER。
 */
function splitQuotedRecords(
  text: string,
  maxRecords: number,
  delimiter: string,
): { records: string[]; unclosedQuote: boolean; tooManyRecords: boolean; recordTooLong?: boolean } {
  const records: string[] = [];
  let record = '';
  let quoted = false;
  // 盲审 P2:逐字符累积时若整个文本是**一条**超长记录(未闭合引号 / 无换行的宽表),
  // 在行数上限生效前就已经把整份文本复制进 record,17MB 输入实测堆峰值 ~600MB。
  // 单条记录本身也要有上限——正常 CSV 的一行不会超过这个量级。
  const MAX_RECORD_CHARS = MAX_IMPORT_DATA_COLS * 64;
  let recordTooLong = false;
  // CORE-04:只用 trim 判断「纯空白行」,不得改写记录开头——Tab 分隔行首的 \t 表示
  // 「第一个单元格为空」,整行 trim 会让该行所有单元格左移一列(Excel 左上角空白的常见版式)。
  // 行尾空白照旧剥掉:尾部空单元格不影响列对齐,且保持既有列宽预算与帕累托形态判定不变。
  const pushRecord = (): boolean => {
    if (record.trim() !== '') records.push(record.trimEnd());
    record = '';
    return records.length > maxRecords;
  };
  for (let i = 0; i < text.length; i++) {
    if (record.length > MAX_RECORD_CHARS) { recordTooLong = true; break; }
    const ch = text[i];
    if (ch === '"' && (quoted || quoteOpensAt(text, i, delimiter))) {
      record += ch;
      if (quoted && text[i + 1] === '"') {
        record += text[++i];
      } else quoted = !quoted;
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (pushRecord()) return { records, unclosedQuote: false, tooManyRecords: true };
    } else record += ch;
  }
  if (pushRecord()) return { records, unclosedQuote: false, tooManyRecords: true };
  return { records, unclosedQuote: quoted, tooManyRecords: false, recordTooLong };
}

/**
 * 与 splitQuotedRecords 同一套字段边界/引号/换行判定的常数空间计数:只数非空白逻辑记录与
 * 结尾是否仍在引号内,不构造任何字符串。帕累托在选定分隔符后用它做未闭合判定与资源预算,
 * 保证预检与实际拆分对同一文本给出相同记录数(CORE-05 复审 P3)。
 */
function quotedRecordStats(text: string, delimiter: string): { records: number; unclosedQuote: boolean } {
  let records = 0;
  let quoted = false;
  let hasContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (quoted || quoteOpensAt(text, i, delimiter))) {
      hasContent = true;
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (hasContent) records++;
      hasContent = false;
    } else if (!hasContent && ch.trim() !== '') hasContent = true;
  }
  if (hasContent) records++;
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
  // 类别行数上限(双审 P2):此前仅受 20MB 字节闸,2MB 文本即可在 spread 处崩溃;
  // 真实帕累托类别数在几十级,5 万行已远超合理用途
  // 上限按「合并后类别数」判(闭环审核):按行数判会误伤本函数明示支持的
  // 「单列原始缺陷标签自动计数」(10 万条标签合并后可能只有几十类),
  // 也会被「横排两行自动转置」路径整条绕过。防栈溢出已由循环求 maxLen 达成。
  const cleanText = text.replace(/^\uFEFF/, '');
  const inspection = inspectParetoText(cleanText);
  if (inspection.error) return { error: inspection.error };
  const recordStats = quotedRecordStats(cleanText, inspection.delimiter);
  if (recordStats.unclosedQuote) return { error: 'CSV 引号未闭合，请检查含逗号或换行的类别字段。' };
  const resourceError = paretoResourceError(cleanText, inspection.delimiter, recordStats.records);
  if (resourceError) return { error: resourceError };

  const logical = splitQuotedRecords(cleanText, MAX_PARETO_RAW_RECORDS, inspection.delimiter);
  if (logical.tooManyRecords) return { error: `帕累托原始记录数超过 ${MAX_PARETO_RAW_RECORDS.toLocaleString()} 条上限；请先在外部汇总或拆分` };
  if (logical.unclosedQuote) return { error: 'CSV 引号未闭合，请检查含逗号或换行的类别字段。' };
  const lines = logical.records;
  if (lines.length === 0) return { error: '没有可解析的内容。期望格式:「类别,频数」两列(纵向)或「类别一行 + 频数一行」(横向),也可粘贴单列原始缺陷标签。' };

  const delim = inspection.delimiter;
  let cells = lines.map((line) => splitDelimitedLine(line, delim));
  // CORE-04:记录不再整行 trim 后,Excel 选区左侧整列空白会以前导空单元格出现。自动识别
  // 路径按「所有行都为空」的整列剥离(列对齐不变);显式选列路径保留原列号,与源表一致。
  // 复审 P2:单遍求出可剥离的前导空列数 k 再切一次,O(单元格总数);逐列整表 slice 是
  // O(行数×k²),2 行 × 5 万前导 Tab 即在主线程同步卡数秒。
  if (!columns && cells.length > 0) {
    let strip = Number.POSITIVE_INFINITY;
    for (const row of cells) {
      let lead = 0;
      // 每行至少保留 1 个单元格(与原 while 的 row.length > 1 同口径)
      while (lead < row.length - 1 && lead < strip && row[lead] === '') lead++;
      if (lead < strip) strip = lead;
      if (strip === 0) break;
    }
    if (strip > 0) cells = cells.map((row) => row.slice(strip));
  }
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
  let emptyCategory = false;
  let tooManyCategories = false;
  const add = (rawName: string, count: number) => {
    if (order.length >= MAX_PARETO_CATEGORIES && !merged.has(rawName.trim())) { tooManyCategories = true; return; }
    // 双审 P1:空类别名不得放行——导入侧通过而项目校验器拒绝,会造成「导出被阻断、
    // 重启后整个帕累托存储被隔离清空」的延迟数据丢失
    const name = rawName.trim();
    if (!name) { emptyCategory = true; return; }
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
    let maxLen = 0; for (const r of cells) if (r.length > maxLen) maxLen = r.length; // 不用 Math.max(...):十万行展开栈溢出(与 186 行同一纪律)
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
    // 与自动路径同一判定顺序(复审 P3:此前顺序不同 → 同类输入两条路径报错文案不一致)。
    // 空类别在本分支已由上方逐行 return 拦下,不再重复判。
    if (tooManyCategories) return { error: `类别数超过 ${MAX_PARETO_CATEGORIES.toLocaleString()} 上限；帕累托分析请先在外部汇总后导入` };
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
    let maxLen = 0; for (const r of cells) if (r.length > maxLen) maxLen = r.length; // 不用 Math.max(...):十万行展开栈溢出(与 186 行同一纪律)
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
  // 判定顺序:先「结构性拒绝」(空类别名/类别数超限),再「内容为空」——
  // 复审 P3:此前把空类别排在最后,6 万类别且全空名的输入会报「没有解析到任何类别」,指引错方向
  if (emptyCategory) return { error: '存在空类别名：请为每一行填写类别名称后重试' };
  if (tooManyCategories) return { error: `类别数超过 ${MAX_PARETO_CATEGORIES.toLocaleString()} 上限；帕累托分析请先在外部汇总后导入` };
  if (rows.length === 0) return { error: '没有解析到任何类别' };
  if (rows.every((r) => r.count === 0)) return { error: '所有类别的频数都是 0,无法绘制帕累托图' };
  return { rows, note: notes.length ? notes.join(';') : undefined };
}
