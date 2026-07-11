/**
 * 渲染降采样 — 大数据集图表只画代表性点,统计与判异始终基于全量数据。
 * 返回的都是「索引」而非值,调用方用索引取原值,x 坐标不失真。
 */

/** 均匀抽样:等距选 maxPoints 个索引,始终含首尾与 keep 中的必留索引。 */
export function decimateUniform(n: number, maxPoints: number, keep?: Iterable<number>): number[] {
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>([0, n - 1]);
  const step = (n - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) out.add(Math.round(i * step));
  if (keep) for (const k of keep) if (k >= 0 && k < n) out.add(k);
  return [...out].sort((a, b) => a - b);
}

/** min-max 分桶抽样(保形):每桶保留最小与最大值的索引,折线包络不变。
 * 始终含首尾、全局极值与 keep(如失控点、选中点)。 */
export function decimateMinMax(data: number[], maxPoints: number, keep?: Iterable<number>): number[] {
  const n = data.length;
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const buckets = Math.max(1, Math.floor(maxPoints / 2) - 1);
  const out = new Set<number>([0, n - 1]);
  const bw = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * bw);
    const e = Math.min(n, Math.floor((b + 1) * bw));
    let mi = s, ma = s;
    for (let i = s + 1; i < e; i++) {
      if (data[i] < data[mi]) mi = i;
      if (data[i] > data[ma]) ma = i;
    }
    out.add(mi);
    out.add(ma);
  }
  if (keep) for (const k of keep) if (k >= 0 && k < n) out.add(k);
  return [...out].sort((a, b) => a - b);
}
