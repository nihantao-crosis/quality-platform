/**
 * 计算器按键逻辑 — 从原型 calcKey 逐字迁移（连算/清除/退格/正负号/小数）。
 */
import { nf } from './basicMath';

export interface CalcState {
  disp: string;
  acc: number | null;
  op: string | null;
  fresh: boolean;
}

export const CALC_INIT: CalcState = { disp: '0', acc: null, op: null, fresh: true };

export function calcKey(state: CalcState, k: string): CalcState {
  const c: CalcState = { ...state };
  const comp = (a: number, o: string, b: number) =>
    o === '+' ? a + b : o === '−' ? a - b : o === '×' ? a * b : o === '÷' ? (b === 0 ? 0 : a / b) : b;
  const fmt = (x: number) => nf(x, 6).replace(/\.?0+$/, '');
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
    c.disp = '0';
    c.acc = null;
    c.op = null;
    c.fresh = true;
  } else if (k === '±') {
    c.disp = c.disp === '0' ? '0' : String(-Number(c.disp));
  } else if (k === '=') {
    if (c.op != null) {
      c.disp = fmt(comp(c.acc as number, c.op, Number(c.disp)));
      c.op = null;
      c.fresh = true;
    }
  } else {
    if (c.op != null && !c.fresh) {
      c.acc = comp(c.acc as number, c.op, Number(c.disp));
      c.disp = fmt(c.acc);
    } else c.acc = Number(c.disp);
    c.op = k;
    c.fresh = true;
  }
  return c;
}
