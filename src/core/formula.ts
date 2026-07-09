/**
 * 公式引擎（对标 Minitab 计算器 Calc → Calculator）——从已有列算出一列新值。
 *
 * 纯函数、零依赖、安全(自建递归下降解析器,不用 eval)。支持:
 *  - 列引用:C1 C2 …(1 基,对应第 j 列)或用单引号引用列名 '直径 (mm)'
 *  - 运算:+ − × ÷ ^ 与一元负号、括号;^ 右结合,* / 高于 + −
 *  - 逐元素函数:abs sqrt exp ln log(=ln) log10 sin cos tan round sq
 *  - 聚合函数(整列折算成常量再广播):mean/avg std/sd var min max sum median range n/count
 *  - 常量:pi e
 * 每行独立求值;聚合函数对「其参数在所有行上的取值」做一次归约并缓存。
 */

export interface FormulaCtx {
  /** 各列的数值数组，columns[j] 为第 j 列(0 基) */
  columns: number[][];
  /** 与 columns 对齐的列名 */
  colNames: string[];
  /** 行数 */
  rowCount: number;
}

export interface FormulaResult {
  values: number[];
  /** 引用到的列索引(0 基,去重升序) */
  refs: number[];
}

// ---------- 词法 ----------
type Tok =
  | { t: 'num'; v: number }
  | { t: 'col'; i: number }        // C<n> 已解析为 0 基索引
  | { t: 'name'; s: string }       // 标识符(函数名 / 常量) 或 引号列名
  | { t: 'op'; s: string }
  | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

const OPS = new Set(['+', '-', '*', '/', '^']);

function tokenize(src: string, colNames: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const norm = src
    .replace(/×/g, '*').replace(/÷/g, '/')
    .replace(/[−–—]/g, '-'); // 各种减号/破折号统一成 ASCII 减号
  const lower = (s: string) => s.toLowerCase();
  const nameToCol = (raw: string): number => {
    const idx = colNames.indexOf(raw);
    if (idx < 0) throw new FormulaError(`未找到列「${raw}」`);
    return idx;
  };
  while (i < norm.length) {
    const c = norm[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    // 比较运算符(可能是双字符)
    if (c === '<' || c === '>' || c === '=' || c === '!') {
      const two = norm.slice(i, i + 2);
      if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '<>') { toks.push({ t: 'op', s: two }); i += 2; continue; }
      if (c === '=') { toks.push({ t: 'op', s: '==' }); i++; continue; }
      if (c === '<' || c === '>') { toks.push({ t: 'op', s: c }); i++; continue; }
      throw new FormulaError(`无法识别的字符「${c}」(不等号请用 <> 或 !=)`);
    }
    if (OPS.has(c)) { toks.push({ t: 'op', s: c }); i++; continue; }
    if (c === "'") {
      // 引号列名
      let j = i + 1;
      while (j < norm.length && norm[j] !== "'") j++;
      if (j >= norm.length) throw new FormulaError('列名引号未闭合');
      toks.push({ t: 'col', i: nameToCol(norm.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < norm.length && /[0-9.]/.test(norm[j])) j++;
      // 科学计数法 1e-3
      if (norm[j] === 'e' || norm[j] === 'E') {
        j++;
        if (norm[j] === '+' || norm[j] === '-') j++;
        while (j < norm.length && /[0-9]/.test(norm[j])) j++;
      }
      const num = Number(norm.slice(i, j));
      if (!Number.isFinite(num)) throw new FormulaError(`无法识别的数字「${norm.slice(i, j)}」`);
      toks.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z一-龥_]/.test(c)) {
      let j = i;
      while (j < norm.length && /[A-Za-z0-9_一-龥]/.test(norm[j])) j++;
      const word = norm.slice(i, j);
      // 逻辑词运算符
      if (['and', 'or', 'not'].includes(lower(word))) { toks.push({ t: 'op', s: lower(word) }); i = j; continue; }
      // C<n> 列引用(仅当形如 C 后跟数字,且不是紧跟 '(' 的函数名)
      const m = /^[Cc](\d+)$/.exec(word);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n < 1) throw new FormulaError(`列引用 ${word} 无效(应为 C1 及以上)`);
        toks.push({ t: 'col', i: n - 1 });
      } else {
        toks.push({ t: 'name', s: lower(word) });
      }
      i = j;
      continue;
    }
    throw new FormulaError(`无法识别的字符「${c}」`);
  }
  return toks;
}

// ---------- 语法 ----------
type Node =
  | { k: 'num'; v: number }
  | { k: 'col'; i: number }
  | { k: 'const'; v: number }
  | { k: 'neg'; a: Node }
  | { k: 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'elem'; fn: string; a: Node }
  | { k: 'agg'; fn: string; a: Node };

export class FormulaError extends Error {}

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const ELEM: Record<string, (x: number) => number> = {
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp,
  ln: Math.log, log: Math.log, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  round: Math.round, sq: (x) => x * x,
};
const AGG_NAMES = new Set(['mean', 'avg', 'std', 'sd', 'var', 'min', 'max', 'sum', 'median', 'range', 'n', 'count']);

const CMP = new Set(['>', '<', '>=', '<=', '==', '!=', '<>']);

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok | undefined { return this.toks[this.p++]; }
  parse(): Node {
    const n = this.orE();
    if (this.p < this.toks.length) throw new FormulaError('表达式有多余的内容');
    return n;
  }
  private orE(): Node { // or
    let a = this.andE();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && t.s === 'or') { this.next(); a = { k: 'bin', op: 'or', a, b: this.andE() }; }
      else return a;
    }
  }
  private andE(): Node { // and
    let a = this.notE();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && t.s === 'and') { this.next(); a = { k: 'bin', op: 'and', a, b: this.notE() }; }
      else return a;
    }
  }
  private notE(): Node { // not(一元)
    const t = this.peek();
    if (t?.t === 'op' && t.s === 'not') { this.next(); return { k: 'not', a: this.notE() }; }
    return this.cmp();
  }
  private cmp(): Node { // 比较(左结合)
    let a = this.add();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && CMP.has(t.s)) { this.next(); a = { k: 'bin', op: t.s, a, b: this.add() }; }
      else return a;
    }
  }
  private add(): Node { // + −
    let a = this.mul();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && (t.s === '+' || t.s === '-')) { this.next(); a = { k: 'bin', op: t.s, a, b: this.mul() }; }
      else return a;
    }
  }
  private mul(): Node { // * /
    let a = this.pow();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && (t.s === '*' || t.s === '/')) { this.next(); a = { k: 'bin', op: t.s, a, b: this.pow() }; }
      else return a;
    }
  }
  private pow(): Node { // ^ 右结合
    const a = this.unary();
    const t = this.peek();
    if (t?.t === 'op' && t.s === '^') { this.next(); return { k: 'bin', op: '^', a, b: this.pow() }; }
    return a;
  }
  private unary(): Node {
    const t = this.peek();
    if (t?.t === 'op' && (t.s === '-' || t.s === '+')) { this.next(); const a = this.unary(); return t.s === '-' ? { k: 'neg', a } : a; }
    return this.primary();
  }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new FormulaError('表达式不完整');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'col') return { k: 'col', i: t.i };
    if (t.t === 'lp') { const n = this.orE(); const r = this.next(); if (r?.t !== 'rp') throw new FormulaError('括号不匹配'); return n; }
    if (t.t === 'name') {
      const nx = this.peek();
      if (nx?.t === 'lp') {
        this.next(); // (
        const arg = this.orE();
        const r = this.next();
        if (r?.t !== 'rp') throw new FormulaError(`函数 ${t.s}(…) 括号不匹配`);
        if (t.s in ELEM) return { k: 'elem', fn: t.s, a: arg };
        if (AGG_NAMES.has(t.s)) return { k: 'agg', fn: t.s, a: arg };
        throw new FormulaError(`未知函数「${t.s}」`);
      }
      if (t.s in CONSTS) return { k: 'const', v: CONSTS[t.s] };
      throw new FormulaError(`未知名称「${t.s}」(函数需带括号,常量仅支持 pi/e)`);
    }
    throw new FormulaError('表达式语法错误');
  }
}

/** 真值判定:有限且非 0 为真(NaN/±∞ 视为假)。用于逻辑运算与条件筛选。 */
export function truthy(x: number): boolean {
  return Number.isFinite(x) && x !== 0;
}

function aggregate(fn: string, xs: number[]): number {
  const finite = xs.filter(Number.isFinite);
  const n = finite.length;
  if (n === 0) return NaN;
  const sum = finite.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  switch (fn) {
    case 'sum': return sum;
    case 'mean': case 'avg': return mean;
    case 'min': return Math.min(...finite);
    case 'max': return Math.max(...finite);
    case 'range': return Math.max(...finite) - Math.min(...finite);
    case 'n': case 'count': return n;
    case 'var': return n > 1 ? finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    case 'std': case 'sd': return n > 1 ? Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    case 'median': {
      const s = [...finite].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
    default: throw new FormulaError(`未知聚合函数「${fn}」`);
  }
}

/** 编译一次公式,返回按行求值器与引用列。 */
export function compileFormula(expr: string, ctx: FormulaCtx): { evalRow: (row: number) => number; refs: number[] } {
  if (expr.trim() === '') throw new FormulaError('公式为空');
  const ast = new Parser(tokenize(expr, ctx.colNames)).parse();
  const refs = new Set<number>();
  const aggCache = new Map<Node, number>();

  const evalNode = (n: Node, row: number): number => {
    switch (n.k) {
      case 'num': return n.v;
      case 'const': return n.v;
      case 'col': {
        if (n.i < 0 || n.i >= ctx.columns.length) throw new FormulaError(`列 C${n.i + 1} 不存在(共 ${ctx.columns.length} 列)`);
        refs.add(n.i);
        return ctx.columns[n.i][row];
      }
      case 'neg': return -evalNode(n.a, row);
      case 'not': return truthy(evalNode(n.a, row)) ? 0 : 1;
      case 'bin': {
        const a = evalNode(n.a, row), b = evalNode(n.b, row);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '^': return Math.pow(a, b);
          case '>': return a > b ? 1 : 0;
          case '<': return a < b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          case '!=': case '<>': return a !== b ? 1 : 0;
          case 'and': return truthy(a) && truthy(b) ? 1 : 0;
          case 'or': return truthy(a) || truthy(b) ? 1 : 0;
          default: throw new FormulaError(`未知运算符 ${n.op}`);
        }
      }
      case 'elem': return ELEM[n.fn](evalNode(n.a, row));
      case 'agg': {
        let v = aggCache.get(n);
        if (v === undefined) {
          const xs: number[] = [];
          for (let r = 0; r < ctx.rowCount; r++) xs.push(evalNode(n.a, r));
          v = aggregate(n.fn, xs);
          aggCache.set(n, v);
        }
        return v;
      }
    }
  };

  return {
    evalRow: (row: number) => evalNode(ast, row),
    get refs() { return [...refs].sort((a, b) => a - b); },
  };
}

/** 便捷入口:直接算出整列。非有限值(如除零)保留为 NaN，由调用方决定如何处理。 */
export function evalFormula(expr: string, ctx: FormulaCtx): FormulaResult {
  const c = compileFormula(expr, ctx);
  const values: number[] = [];
  for (let r = 0; r < ctx.rowCount; r++) values.push(c.evalRow(r));
  return { values, refs: c.refs };
}
