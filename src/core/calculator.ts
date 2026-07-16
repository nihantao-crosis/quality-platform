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
  const fmt = (x: number) => nf(x, 6).replace(/\.?0+$/, '');
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
