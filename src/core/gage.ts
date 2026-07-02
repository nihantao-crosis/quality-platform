/**
 * Gage R&R — 交叉设计 ANOVA 法（AIAG）。
 * 补齐交接文档 core-skeleton/statistics.ts §6 的签名。
 */

export interface GageObservation {
  part: number; // 0-based
  operator: number; // 0-based
  trial: number; // 0-based
  value: number;
}

export interface GageComponent {
  source: string;
  variance: number;
  pctContribution: number; // 方差占比
  pctStudyVar: number; // 6σ 占比
  pctTolerance: number; // 6σ / 公差
}

export interface GageResult {
  totalGageRR: number; // %研究变异
  components: GageComponent[]; // 合计GRR / 重复性 / 再现性 / 部件间 / 合计变异
  verdict: 'acceptable' | 'marginal' | 'unacceptable'; // <10 / 10–30 / >30 (AIAG)
}

export function computeGageRR(data: GageObservation[], tolerance: number): GageResult {
  const p = Math.max(...data.map((d) => d.part)) + 1;
  const o = Math.max(...data.map((d) => d.operator)) + 1;
  const r = Math.max(...data.map((d) => d.trial)) + 1;
  const N = data.length;
  const grand = data.reduce((a, d) => a + d.value, 0) / N;

  const partMean = new Array(p).fill(0);
  const operMean = new Array(o).fill(0);
  const cellMean: number[][] = Array.from({ length: p }, () => new Array(o).fill(0));
  data.forEach((d) => {
    partMean[d.part] += d.value / (o * r);
    operMean[d.operator] += d.value / (p * r);
    cellMean[d.part][d.operator] += d.value / r;
  });

  const ssTotal = data.reduce((a, d) => a + (d.value - grand) ** 2, 0);
  const ssPart = o * r * partMean.reduce((a, m) => a + (m - grand) ** 2, 0);
  const ssOper = p * r * operMean.reduce((a, m) => a + (m - grand) ** 2, 0);
  let ssCell = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < o; j++) ssCell += r * (cellMean[i][j] - grand) ** 2;
  const ssInter = ssCell - ssPart - ssOper;
  const ssError = ssTotal - ssCell;

  const msPart = ssPart / (p - 1);
  const msOper = ssOper / (o - 1);
  const msInter = ssInter / ((p - 1) * (o - 1));
  const msError = ssError / (p * o * (r - 1));

  // 方差分量（负值截 0）
  const vRepeat = msError;
  const vInter = Math.max(0, (msInter - msError) / r);
  const vOper = Math.max(0, (msOper - msInter) / (p * r));
  const vPart = Math.max(0, (msPart - msInter) / (o * r));
  const vReprod = vOper + vInter;
  const vGRR = vRepeat + vReprod;
  const vTotal = vGRR + vPart;

  const sTotal = Math.sqrt(vTotal);
  const mk = (source: string, v: number): GageComponent => ({
    source,
    variance: v,
    pctContribution: (v / vTotal) * 100,
    pctStudyVar: (Math.sqrt(v) / sTotal) * 100,
    pctTolerance: ((6 * Math.sqrt(v)) / tolerance) * 100,
  });

  const totalGageRR = (Math.sqrt(vGRR) / sTotal) * 100;
  return {
    totalGageRR,
    components: [
      mk('合计 Gage R&R', vGRR),
      mk('  重复性', vRepeat),
      mk('  再现性', vReprod),
      mk('部件间', vPart),
      mk('合计变异', vTotal),
    ],
    verdict: totalGageRR < 10 ? 'acceptable' : totalGageRR <= 30 ? 'marginal' : 'unacceptable',
  };
}
