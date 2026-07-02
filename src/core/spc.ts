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

/** 控制图常数（n=5，原型固定值；X̄-S: A3/B3/B4） */
export const CONTROL_CONSTANTS_N5 = {
  A2: 0.577,
  D4: 2.114,
  D3: 0,
  d2: 2.326,
  A3: 1.427,
  B3: 0,
  B4: 2.089,
} as const;

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
