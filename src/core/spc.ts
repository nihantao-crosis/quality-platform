/**
 * SPC 判异 — Nelson 准则引擎，从原型 evalRules 逐字迁移（交接文档 §8.3）。
 */

export interface NelsonRules {
  r1: boolean; // 单点超出 3σ
  r2: boolean; // 连续 9 点位于中心线同侧
  r3: boolean; // 连续 6 点持续上升或下降
  r4: boolean; // 相邻 3 点中 ≥2 点位于同侧 2σ 区外
}

export interface RuleViolation {
  i: number; // 0-based 点索引
  rule: 1 | 2 | 3 | 4;
  desc: string;
}

export interface ControlConstants {
  A2: number;
  A3: number;
  d2: number;
  D3: number;
  D4: number;
  B3: number;
  B4: number;
  c4: number;
}

/** 控制图常数表 n=2..10（ASTM E2587 / Minitab 标准值） */
export const CONTROL_CONSTANTS: Record<number, ControlConstants> = {
  2: { A2: 1.880, A3: 2.659, d2: 1.128, D3: 0, D4: 3.267, B3: 0, B4: 3.267, c4: 0.7979 },
  3: { A2: 1.023, A3: 1.954, d2: 1.693, D3: 0, D4: 2.574, B3: 0, B4: 2.568, c4: 0.8862 },
  4: { A2: 0.729, A3: 1.628, d2: 2.059, D3: 0, D4: 2.282, B3: 0, B4: 2.266, c4: 0.9213 },
  5: { A2: 0.577, A3: 1.427, d2: 2.326, D3: 0, D4: 2.114, B3: 0, B4: 2.089, c4: 0.9400 },
  6: { A2: 0.483, A3: 1.287, d2: 2.534, D3: 0, D4: 2.004, B3: 0.030, B4: 1.970, c4: 0.9515 },
  7: { A2: 0.419, A3: 1.182, d2: 2.704, D3: 0.076, D4: 1.924, B3: 0.118, B4: 1.882, c4: 0.9594 },
  8: { A2: 0.373, A3: 1.099, d2: 2.847, D3: 0.136, D4: 1.864, B3: 0.185, B4: 1.815, c4: 0.9650 },
  9: { A2: 0.337, A3: 1.032, d2: 2.970, D3: 0.184, D4: 1.816, B3: 0.239, B4: 1.761, c4: 0.9693 },
  10: { A2: 0.308, A3: 0.975, d2: 3.078, D3: 0.223, D4: 1.777, B3: 0.284, B4: 1.716, c4: 0.9727 },
};

/** n=5 常数（原型固定值，向后兼容） */
export const CONTROL_CONSTANTS_N5 = CONTROL_CONSTANTS[5];

export function evalRules(
  data: number[],
  cl: number,
  sigma: number,
  rules: NelsonRules,
): { viol: Set<number>; list: RuleViolation[] } {
  const viol = new Set<number>();
  const list: RuleViolation[] = [];
  if (rules.r1)
    data.forEach((v, i) => {
      if (Math.abs(v - cl) > 3 * sigma) {
        viol.add(i);
        list.push({ i, rule: 1, desc: '单点超出 3σ 控制限' });
      }
    });
  if (rules.r2) {
    let run = 0;
    let sign = 0;
    data.forEach((v, i) => {
      const s = Math.sign(v - cl);
      if (s === sign && s !== 0) run++;
      else {
        run = 1;
        sign = s;
      }
      if (run >= 9) {
        for (let q = i - 8; q <= i; q++) viol.add(q);
        list.push({ i, rule: 2, desc: '连续 9 点位于中心线同侧' });
      }
    });
  }
  if (rules.r3) {
    let inc = 1;
    let dec = 1;
    for (let i = 1; i < data.length; i++) {
      if (data[i] > data[i - 1]) {
        inc++;
        dec = 1;
      } else if (data[i] < data[i - 1]) {
        dec++;
        inc = 1;
      } else {
        inc = 1;
        dec = 1;
      }
      if (inc >= 6 || dec >= 6) {
        for (let q = i - 5; q <= i; q++) viol.add(q);
        list.push({ i, rule: 3, desc: '连续 6 点持续上升或下降' });
      }
    }
  }
  if (rules.r4) {
    for (let i = 2; i < data.length; i++) {
      const w = [i - 2, i - 1, i];
      const up = w.filter((q) => data[q] - cl > 2 * sigma).length;
      const dn = w.filter((q) => cl - data[q] > 2 * sigma).length;
      if (up >= 2 || dn >= 2) {
        w.forEach((q) => {
          if (Math.abs(data[q] - cl) > 2 * sigma) viol.add(q);
        });
        list.push({ i, rule: 4, desc: '相邻三点中两点位于 2σ 区外（同侧）' });
      }
    }
  }
  const seen = new Set<string>();
  const out = list
    .filter((x) => {
      const k = x.rule + '-' + x.i;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.i - b.i);
  return { viol, list: out };
}
