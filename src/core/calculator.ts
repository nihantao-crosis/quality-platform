/**
 * 计算器按键逻辑 — 从原型 calcKey 逐字迁移（连算/清除/退格/正负号/小数）。
 */
import { nf } from './basicMath';

export interface CalcState {
  disp: string;
  acc: number | null;
  op: string | null;
  fresh: boolean;
  /** 非空表示上一运算不可执行；界面直接显示 disp='Error'。 */
  error: string | null;
}

export const CALC_INIT: CalcState = { disp: '0', acc: null, op: null, fresh: true, error: null };

export function calcKey(state: CalcState, k: string): CalcState {
  const c: CalcState = { ...state };
  const fail = (message: string): CalcState => ({ disp: 'Error', acc: null, op: null, fresh: true, error: message });
  const comp = (a: number, o: string, b: number): number | null => {
    if (o === '÷' && b === 0) return null;
    return o === '+' ? a + b : o === '−' ? a - b : o === '×' ? a * b : o === '÷' ? a / b : b;
  };
  // 第三轮 P2:裸剪尾零会把 1e20 的整数尾零一并剪掉(显示成「1」并进入连算)。
  // 大/小量级用指数显示,常规量级只剪小数部分的尾零。
  // 闭环审核:1e12 指数阈值把 1e12~2^53 之间的精确整数显示打掉(9999999×9999999
  // 应显示 99999980000001)。大数交给 nf/toFixed(超 1e21 时 JS 自动转指数),
  // 只有极小量级需要指数显示;尾零修剪只作用于小数部分,不再吃掉整数尾零。
  const fmt = (x: number) => {
    if (!Number.isFinite(x)) return 'Error';
    if (x !== 0 && Math.abs(x) < 1e-6) return x.toExponential(6).replace(/\.?0+e/, 'e');
    return nf(x, 6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  };
  // 错误态下运算键不再把 "Error" 转成 NaN；C 清除，数字或小数点开始新一轮输入。
  if (c.error) {
    if (k === 'C') return { ...CALC_INIT };
    if (/^[0-9]$/.test(k) || k === '00' || k === '.') return calcKey({ ...CALC_INIT }, k);
    return c;
  }
  if (/^[0-9]$/.test(k)) {
    c.disp = c.fresh ? k : c.disp === '0' ? k : c.disp + k;
    c.fresh = false;
  } else if (k === '00') {
    if (!c.fresh && c.disp !== '0') c.disp += '00';
  } else if (k === '.') {
    if (!c.disp.includes('.')) c.disp = c.fresh ? '0.' : c.disp + '.';
    c.fresh = false;
  } else if (k === '⌫') {
    c.disp = c.disp.length > 1 ? c.disp.slice(0, -1) : '0';
  } else if (k === 'C') {
    return { ...CALC_INIT };
  } else if (k === '±') {
    c.disp = c.disp === '0' ? '0' : String(-Number(c.disp));
  } else if (k === '=') {
    if (c.op != null) {
      const result = comp(c.acc as number, c.op, Number(c.disp));
      if (result == null) return fail('不能除以零');
      if (!Number.isFinite(result)) return fail('计算结果超出可表示范围');
      c.disp = fmt(result);
      c.op = null;
      c.fresh = true;
    }
  } else {
    if (c.op != null && !c.fresh) {
      const result = comp(c.acc as number, c.op, Number(c.disp));
      if (result == null) return fail('不能除以零');
      if (!Number.isFinite(result)) return fail('计算结果超出可表示范围');
      c.acc = result;
      c.disp = fmt(result);
    } else c.acc = Number(c.disp);
    c.op = k;
    c.fresh = true;
  }
  return c;
}
