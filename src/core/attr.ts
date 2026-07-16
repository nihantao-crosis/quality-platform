/**
 * 计数型控制图模型 — P 图（不良率）与 C 图（单位缺陷数）。
 * 演示序列与导入计数共用此模型（真实数据闭环）。
 */

export interface PChartModel {
  kind: 'p';
  name: string;
  isDemo: boolean;
  /**
   * 向后兼容的单一样本量字段。固定样本量时等于每批 n；可变样本量时等于首批 n。
   * 新代码应使用 pNs，避免把可变样本量误报为一个固定值。
   */
  pN: number;
  /** 各批实际检验数（与 pdef / pprop 一一对应）。 */
  pNs: number[];
  /** 是否存在批间样本量变化。 */
  pVariableN: boolean;
  pdef: number[]; // 各样本不良数
  pprop: number[]; // 不良率
  pbar: number;
  /** 向后兼容的首批控制限；新代码应使用逐批控制限数组。 */
  pUcl: number;
  pLcl: number;
  /** 按每批 n_i 计算并截断到概率区间 [0,1] 的逐批控制限。 */
  pUcls: number[];
  pLcls: number[];
}

export interface CChartModel {
  kind: 'c';
  name: string;
  isDemo: boolean;
  cdata: number[]; // 各单位缺陷数
  cbar: number;
  cUcl: number;
  cLcl: number;
}

export function computePChart(counts: number[], sampleSize: number | number[], name: string, isDemo = false): PChartModel {
  if (counts.length < 2) throw new Error('至少需要 2 个样本');
  if (counts.some((c) => c < 0 || !Number.isInteger(c))) throw new Error('不良数必须为非负整数');
  const pNs = Array.isArray(sampleSize)
    ? [...sampleSize]
    : Array.from({ length: counts.length }, () => sampleSize);
  if (pNs.length !== counts.length) throw new Error('每批样本量数量必须与不良数数量一致');
  if (pNs.some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error('样本量必须为正整数');
  if (counts.some((c, index) => c > pNs[index])) throw new Error('不良数不能大于对应批次样本量');
  const pprop = counts.map((d, index) => d / pNs[index]);
  // 可变样本量 P 图的中心线必须按总不良数 / 总检验数加权，不能平均各批不良率。
  const totalInspected = pNs.reduce((sum, n) => sum + n, 0);
  const pbar = counts.reduce((a, b) => a + b, 0) / totalInspected;
  const pUcls = pNs.map((n) => Math.min(1, pbar + 3 * Math.sqrt((pbar * (1 - pbar)) / n)));
  const pLcls = pNs.map((n) => Math.max(0, pbar - 3 * Math.sqrt((pbar * (1 - pbar)) / n)));
  return {
    kind: 'p', name, isDemo,
    pN: pNs[0], pNs, pVariableN: pNs.some((n) => n !== pNs[0]),
    pdef: [...counts], pprop, pbar,
    pUcl: pUcls[0], pLcl: pLcls[0], pUcls, pLcls,
  };
}

export function computeCChart(counts: number[], name: string, isDemo = false): CChartModel {
  if (counts.length < 2) throw new Error('至少需要 2 个单位');
  if (counts.some((c) => c < 0 || !Number.isInteger(c))) throw new Error('缺陷数必须为非负整数');
  const cbar = counts.reduce((a, b) => a + b, 0) / counts.length;
  const cSig = Math.sqrt(cbar);
  return {
    kind: 'c', name, isDemo,
    cdata: counts, cbar,
    cUcl: cbar + 3 * cSig,
    cLcl: Math.max(0, cbar - 3 * cSig),
  };
}
