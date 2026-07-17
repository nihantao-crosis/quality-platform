/**
 * SPC 判异 — Nelson 准则引擎，从原型 evalRules 逐字迁移（交接文档 §8.3）。
 */

export interface NelsonRules {
  r1: boolean; // 1 点超出 3σ
  r2: boolean; // 连续 9 点位于中心线同侧
  r3: boolean; // 连续 6 点持续上升或下降
  r4: boolean; // 连续 14 点上下交替
  r5: boolean; // 相邻 3 点中 ≥2 点位于同侧 2σ 区外
  r6: boolean; // 相邻 5 点中 ≥4 点位于同侧 1σ 区外
  r7: boolean; // 连续 15 点全在 1σ 区内(中心线附近)
  r8: boolean; // 连续 8 点全在 1σ 区外(两侧皆可)
}

export type RuleNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Minitab「Xbar 图选项 → 检验」的可编辑 K 值,与准则 1–8 一一对应。
 * k1=σ 倍数(1 点 > K1σ);k2=连续 K2 点同侧;k3=连续 K3 点递增/递减;k4=连续 K4 点交替;
 * k5=「K5+1 点中 K5 点 > 2σ 同侧」;k6=「K6+1 点中 K6 点 > 1σ 同侧」;
 * k7=连续 K7 点在 1σ 内;k8=连续 K8 点 > 1σ(两侧)。
 * 注意:k1 只改准则 1 的判异检测阈,绝不改动控制限 UCL/LCL 本身。 */
export interface NelsonRuleK {
  k1: number;
  k2: number;
  k3: number;
  k4: number;
  k5: number;
  k6: number;
  k7: number;
  k8: number;
}

/** Nelson (1984) / Minitab 特殊原因检验的标准参数。 */
export const DEFAULT_RULE_K: NelsonRuleK = { k1: 3, k2: 9, k3: 6, k4: 14, k5: 2, k6: 4, k7: 15, k8: 8 };

/** 各 K 的合法域:k1∈[1,6] 允许一位小数;k5/k6 是「K/K+1」联动窗口,其余为普通游程长度。 */
const RULE_K_LIMITS: Record<keyof NelsonRuleK, { min: number; max: number; integer: boolean }> = {
  k1: { min: 1, max: 6, integer: false },
  k2: { min: 2, max: 30, integer: true },
  k3: { min: 2, max: 30, integer: true },
  k4: { min: 2, max: 30, integer: true },
  k5: { min: 2, max: 5, integer: true },
  k6: { min: 2, max: 6, integer: true },
  k7: { min: 2, max: 30, integer: true },
  k8: { min: 2, max: 30, integer: true },
};

/** 单字段校验;null 即合法。供 normalizeRuleK 与 qp-prefs / 分析快照白名单校验共用同一口径。 */
export function ruleKValueError(key: keyof NelsonRuleK, value: unknown): string | null {
  const limit = RULE_K_LIMITS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} 不是有限数`;
  if (limit.integer && !Number.isInteger(value)) return `${key} 必须是整数`;
  if (!limit.integer && Math.round(value * 10) / 10 !== value) return `${key} 最多允许一位小数`;
  if (value < limit.min || value > limit.max) return `${key} 超出 [${limit.min}, ${limit.max}] 范围`;
  return null;
}

/** 逐字段规范化:缺失、越界或非法的字段一律回落 Nelson/Minitab 标准值,不抛错。 */
export function normalizeRuleK(raw: unknown): NelsonRuleK {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<Record<keyof NelsonRuleK, unknown>>
    : {};
  const out = { ...DEFAULT_RULE_K };
  for (const key of Object.keys(DEFAULT_RULE_K) as Array<keyof NelsonRuleK>) {
    const value = source[key];
    if (ruleKValueError(key, value) === null) out[key] = value as number;
  }
  return out;
}

/** 默认判异准则:经典四则(1/2/3 + 5「2 of 3 越 2σ」);4/6/7/8 较敏感,默认关闭。 */
export const DEFAULT_RULES: NelsonRules = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };

/** Nelson 判异准则静态定义(与是否检出无关)——供 UI 常驻展示与 tooltip。
 * 完整对齐 Nelson (1984) 与 Minitab「特殊原因检验」1–8(编号一致)。 */
export const RULE_DEFS: Record<RuleNo, { name: string; def: string; points: string; source: string }> = {
  1: { name: '准则 1', def: '1 点落在中心线任一侧 3σ 之外', points: '1 点', source: 'Nelson 1984 / Minitab 检验 1' },
  2: { name: '准则 2', def: '连续 9 点落在中心线同一侧', points: '9 点', source: 'Nelson 1984 / Minitab 检验 2' },
  3: { name: '准则 3', def: '连续 6 点持续上升或持续下降', points: '6 点', source: 'Nelson 1984 / Minitab 检验 3' },
  4: { name: '准则 4', def: '连续 14 点上下交替', points: '14 点', source: 'Nelson 1984 / Minitab 检验 4' },
  5: { name: '准则 5', def: '相邻 3 点中有 2 点落在同侧 2σ 区之外', points: '3 中 2', source: 'Nelson 1984 / Minitab 检验 5' },
  6: { name: '准则 6', def: '相邻 5 点中有 4 点落在同侧 1σ 区之外', points: '5 中 4', source: 'Nelson 1984 / Minitab 检验 6' },
  7: { name: '准则 7', def: '连续 15 点全部落在中心线两侧 1σ 区之内', points: '15 点', source: 'Nelson 1984 / Minitab 检验 7' },
  8: { name: '准则 8', def: '连续 8 点全部落在 1σ 区之外(两侧皆可)', points: '8 点', source: 'Nelson 1984 / Minitab 检验 8' },
};

export interface RuleViolation {
  i: number; // 0-based 点索引
  rule: RuleNo;
  desc: string;
}

/** 判异描述:K 为标准值时逐字沿用 RULE_DEFS(向后兼容),自定义时如实写出实际参数。
 * 导出供 SPC 页说明区使用:说明文案必须随当前 K 变化,不能标准描述与自定义 K 并存两个数字。 */
export function ruleKDesc(rule: RuleNo, K: NelsonRuleK): string {
  const std = RULE_DEFS[rule].def;
  switch (rule) {
    case 1: return K.k1 === DEFAULT_RULE_K.k1 ? std : `1 点落在中心线任一侧 ${K.k1}σ 之外`;
    case 2: return K.k2 === DEFAULT_RULE_K.k2 ? std : `连续 ${K.k2} 点落在中心线同一侧`;
    case 3: return K.k3 === DEFAULT_RULE_K.k3 ? std : `连续 ${K.k3} 点持续上升或持续下降`;
    case 4: return K.k4 === DEFAULT_RULE_K.k4 ? std : `连续 ${K.k4} 点上下交替`;
    case 5: return K.k5 === DEFAULT_RULE_K.k5 ? std : `相邻 ${K.k5 + 1} 点中有 ${K.k5} 点落在同侧 2σ 区之外`;
    case 6: return K.k6 === DEFAULT_RULE_K.k6 ? std : `相邻 ${K.k6 + 1} 点中有 ${K.k6} 点落在同侧 1σ 区之外`;
    case 7: return K.k7 === DEFAULT_RULE_K.k7 ? std : `连续 ${K.k7} 点全部落在中心线两侧 1σ 区之内`;
    case 8: return K.k8 === DEFAULT_RULE_K.k8 ? std : `连续 ${K.k8} 点全部落在 1σ 区之外(两侧皆可)`;
  }
}

/** R/S/MR 与属性图按 Minitab 适用性仅执行准则 1–4；5–8 只用于均值/单值等位置图。 */
export function evalLimitedRules(
  data: number[], cl: number, ucl: number | number[], lcl: number | number[], rules: NelsonRules,
  k: Partial<NelsonRuleK> = DEFAULT_RULE_K,
  /** 逐点真实 σ(未截断)。P 图上下限都可能被 [0,1] 钳位,从展示用限值反推 σ 在
   * 双侧同时截断时仍会低估(Codex v1.37 P2-1);P/C 图调用方应直接传入真 σ。 */
  sigmas?: number | number[],
): { viol: Set<number>; list: RuleViolation[] } {
  const ucls = Array.isArray(ucl) ? ucl : Array.from({ length: data.length }, () => ucl);
  const lcls = Array.isArray(lcl) ? lcl : Array.from({ length: data.length }, () => lcl);
  if (ucls.length !== data.length || lcls.length !== data.length) {
    throw new Error('逐点控制限数量必须与数据点数量一致');
  }
  if (ucls.some((value, index) => !Number.isFinite(value) || !Number.isFinite(lcls[index]) || lcls[index] > value)) {
    throw new Error('控制限必须为有限数且 LCL ≤ UCL');
  }
  const K = normalizeRuleK({ ...DEFAULT_RULE_K, ...k });
  const viol = new Set<number>();
  const list: RuleViolation[] = [];
  if (rules.r1) {
    // k1 只缩放准则 1 的检测阈(以图上 3σ 限距推 σ̂ 再取 K1σ);UCL/LCL 本身不变。
    // σ̂ 取两侧限距的最大值:MR/R/S/C 图的 LCL 常被钳位为 0,P 图的 UCL 会被截断到 1,
    // 单侧截断时另一侧仍是真 3σ 距;取 max 同时覆盖两类截断,才与 Minitab「检验 1,K 个
    // 标准差」语义一致。两侧同时截断仅 P 图 n 极小(p̄=0.5 时 n≤8)才会发生,σ̂ 仍轻度
    // 低估——属退化输入,K1=3 默认路径不受影响。
    const scale = K.k1 / 3;
    const sigmaAt = (i: number): number | null => {
      const raw = sigmas == null ? null : Array.isArray(sigmas) ? sigmas[i] : sigmas;
      return raw != null && Number.isFinite(raw) && raw > 0 ? raw : null;
    };
    data.forEach((v, i) => {
      // 调用方给了真 σ 就直接用(彻底修复双侧同时截断的退化情形);否则按 max 限距回退。
      const truth = sigmaAt(i);
      const kSigma = truth != null ? truth * K.k1 : Math.max(ucls[i] - cl, cl - lcls[i]) * scale;
      const out = K.k1 === 3
        ? v > ucls[i] || v < lcls[i]
        : v - cl > kSigma || cl - v > kSigma;
      if (out) {
        viol.add(i);
        list.push({ i, rule: 1, desc: `1 点超出该图的 ${K.k1}σ 控制限` });
      }
    });
  }
  const patternRules: NelsonRules = {
    r1: false, r2: rules.r2, r3: rules.r3, r4: rules.r4,
    r5: false, r6: false, r7: false, r8: false,
  };
  // 准则 2–4 只依赖中心线/点序；sigma 取有限正数即可。准则 1 由非对称 UCL/LCL 精确判断。
  // 趋势/游程规则只依赖点序与中心线；可变控制限不改变这些规则。
  const maxDistance = ucls.reduce((value, upper, index) =>
    Math.max(value, Math.abs(upper - cl), Math.abs(cl - lcls[index])), 0);
  const pattern = evalRules(data, cl, maxDistance / 3 || 1e-12, patternRules, K);
  pattern.viol.forEach((i) => viol.add(i));
  list.push(...pattern.list);
  return { viol, list: list.sort((a, b) => a.i - b.i || a.rule - b.rule) };
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
  k: Partial<NelsonRuleK> = DEFAULT_RULE_K,
): { viol: Set<number>; list: RuleViolation[] } {
  // 可选 K 值:省略即 Nelson/Minitab 标准参数,行为与旧签名逐位一致。
  const K = normalizeRuleK({ ...DEFAULT_RULE_K, ...k });
  const viol = new Set<number>();
  const list: RuleViolation[] = [];
  if (rules.r1)
    data.forEach((v, i) => {
      // k1 只改判异检测阈(K1σ),不改动控制限 UCL/LCL 本身
      if (Math.abs(v - cl) > K.k1 * sigma) {
        viol.add(i);
        list.push({ i, rule: 1, desc: ruleKDesc(1, K) });
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
      if (run >= K.k2) {
        for (let q = i - (K.k2 - 1); q <= i; q++) viol.add(q);
        list.push({ i, rule: 2, desc: ruleKDesc(2, K) });
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
      if (inc >= K.k3 || dec >= K.k3) {
        for (let q = i - (K.k3 - 1); q <= i; q++) viol.add(q);
        list.push({ i, rule: 3, desc: ruleKDesc(3, K) });
      }
    }
  }
  if (rules.r4) {
    // 连续 K4 点上下交替(方向逐点反向)
    let run = 1;
    let prevDir = 0;
    for (let i = 1; i < data.length; i++) {
      const d = Math.sign(data[i] - data[i - 1]);
      if (d === 0) { prevDir = 0; run = 1; continue; }
      run = prevDir !== 0 && d === -prevDir ? run + 1 : 2;
      prevDir = d;
      if (run >= K.k4) {
        for (let q = i - (K.k4 - 1); q <= i; q++) viol.add(q);
        list.push({ i, rule: 4, desc: ruleKDesc(4, K) });
      }
    }
  }
  // 落在同侧 zσ 区外的点入表(准则 5/6 共用):记实际越界点,保证红点/列表/详情一致
  const zoneCount = (r5: boolean, r6: boolean) => {
    const flag = (rule: RuleNo, win: number, need: number, z: number) => {
      for (let i = win - 1; i < data.length; i++) {
        const w = Array.from({ length: win }, (_, j) => i - win + 1 + j);
        const up = w.filter((q) => data[q] - cl > z * sigma).length;
        const dn = w.filter((q) => cl - data[q] > z * sigma).length;
        if (up >= need || dn >= need) {
          const side = up >= need ? (q: number) => data[q] - cl > z * sigma : (q: number) => cl - data[q] > z * sigma;
          w.forEach((q) => { if (side(q)) { viol.add(q); list.push({ i: q, rule, desc: ruleKDesc(rule, K) }); } });
        }
      }
    };
    if (r5) flag(5, K.k5 + 1, K.k5, 2); // 相邻 K5+1 点 ≥K5 点越 2σ(同侧)
    if (r6) flag(6, K.k6 + 1, K.k6, 1); // 相邻 K6+1 点 ≥K6 点越 1σ(同侧)
  };
  zoneCount(rules.r5, rules.r6);
  if (rules.r7) {
    // 连续 K7 点全在 1σ 区内(中心线附近,变异异常小)
    let run = 0;
    for (let i = 0; i < data.length; i++) {
      run = Math.abs(data[i] - cl) < sigma ? run + 1 : 0;
      if (run >= K.k7) { for (let q = i - (K.k7 - 1); q <= i; q++) viol.add(q); list.push({ i, rule: 7, desc: ruleKDesc(7, K) }); }
    }
  }
  if (rules.r8) {
    // 连续 K8 点全在 1σ 区外(两侧皆可)
    let run = 0;
    for (let i = 0; i < data.length; i++) {
      run = Math.abs(data[i] - cl) > sigma ? run + 1 : 0;
      if (run >= K.k8) { for (let q = i - (K.k8 - 1); q <= i; q++) viol.add(q); list.push({ i, rule: 8, desc: ruleKDesc(8, K) }); }
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
