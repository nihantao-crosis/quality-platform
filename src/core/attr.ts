/**
 * 计数型控制图模型 — P 图（不良率）与 C 图（单位缺陷数）。
 * 演示序列与导入计数共用此模型（真实数据闭环）。
 */

export interface PChartModel {
  kind: 'p';
  name: string;
  isDemo: boolean;
  pN: number; // 样本量
  pdef: number[]; // 各样本不良数
  pprop: number[]; // 不良率
  pbar: number;
  pUcl: number;
  pLcl: number;
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

export function computePChart(counts: number[], sampleSize: number, name: string, isDemo = false): PChartModel {
  if (counts.length < 2) throw new Error('至少需要 2 个样本');
  if (sampleSize < 1) throw new Error('样本量必须 ≥ 1');
  if (counts.some((c) => c < 0 || !Number.isInteger(c))) throw new Error('不良数必须为非负整数');
  if (counts.some((c) => c > sampleSize)) throw new Error('不良数不能大于样本量');
  const pprop = counts.map((d) => d / sampleSize);
  const pbar = counts.reduce((a, b) => a + b, 0) / (sampleSize * counts.length);
  const pSig = Math.sqrt((pbar * (1 - pbar)) / sampleSize);
  return {
    kind: 'p', name, isDemo,
    pN: sampleSize, pdef: counts, pprop, pbar,
    pUcl: pbar + 3 * pSig,
    pLcl: Math.max(0, pbar - 3 * pSig),
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
