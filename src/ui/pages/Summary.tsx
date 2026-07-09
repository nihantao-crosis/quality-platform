/** 描述性统计 · 图形化摘要（对标 Minitab Graphical Summary）。 */
import { useState } from 'react';
import { useData } from '../../store/dataStore';
import { computeDescriptive, nf } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, Badge } from '../common';
import { Histogram } from '../charts/Histogram';

export function Summary({ T }: { T: ChartTokens }) {
  const M = useData((s) => s.model);
  const [bins, setBins] = useState(13);
  const d = computeDescriptive(M.all);

  const dp = 3; // 显示小数位
  const statRows: Array<[string, string, string?]> = [
    ['观测数 N', String(d.n)],
    ['均值', nf(d.mean, dp)],
    ['均值标准误 SE', nf(d.seMean, dp)],
    ['标准差', nf(d.stdev, dp)],
    ['方差', nf(d.variance, dp)],
    ['变异系数 CV', nf(d.cv, 2) + ' %'],
    ['偏度', nf(d.skewness, 3)],
    ['峰度', nf(d.kurtosis, 3)],
    ['最小值', nf(d.min, dp)],
    ['第一四分位 Q1', nf(d.q1, dp)],
    ['中位数', nf(d.median, dp)],
    ['第三四分位 Q3', nf(d.q3, dp)],
    ['最大值', nf(d.max, dp)],
    ['极差', nf(d.range, dp)],
    ['四分位距 IQR', nf(d.iqr, dp)],
    ['总和', nf(d.sum, dp)],
  ];
  const ciRows: Array<[string, string]> = [
    ['均值 95% CI', `(${nf(d.ciMean[0], dp)}, ${nf(d.ciMean[1], dp)})`],
    ['中位数 95% CI', `(${nf(d.ciMedian[0], dp)}, ${nf(d.ciMedian[1], dp)})`],
    ['标准差 95% CI', `(${nf(d.ciStdev[0], dp)}, ${nf(d.ciStdev[1], dp)})`],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Card style={{ flex: '2 1 460px', minWidth: 420 }}>
          <CardHeader
            title="分布图形摘要"
            right={
              <label style={{ fontSize: 12, color: '#8a929d', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                组数 {bins}
                <input type="range" min={5} max={30} value={bins} onChange={(e) => setBins(+e.target.value)} style={{ width: 110 }} />
              </label>
            }
          />
          <Histogram T={T} data={M.all} mu={d.mean} sigmaWithin={d.stdev} sigmaOverall={d.stdev} lsl={null} usl={null} tgt={d.mean} bins={bins} h={210} />
          <BoxPlot T={T} d={d} />
          <div style={{ fontSize: 11.5, color: '#98a1ac', padding: '2px 4px 4px' }}>
            上:直方图叠正态曲线（μ={nf(d.mean, dp)}, σ={nf(d.stdev, dp)}）· 下:箱线图（Q1–中位–Q3,须及 1.5·IQR,○ 为离群点）
          </div>
        </Card>

        <Card style={{ flex: '1 1 300px', minWidth: 280 }}>
          <CardHeader
            title="正态性检验"
            right={d.adAvailable
              ? <Badge bg={d.ad.normal ? '#e8f4ea' : '#fcf3e3'} color={d.ad.normal ? '#2c8a45' : '#d98324'}>{d.ad.normal ? '近似正态' : '偏离正态'}</Badge>
              : <Badge bg="#eef1f4" color="#8a929d">样本不足</Badge>}
          />
          <div style={{ padding: '4px 4px 8px', fontSize: 13, color: '#3a4350', lineHeight: 1.8 }}>
            {d.adAvailable ? (
              <>
                <Row k="Anderson-Darling A²" v={nf(d.ad.a2star, 3)} />
                <Row k="P 值" v={d.ad.p >= 0.999 ? '>0.999' : nf(d.ad.p, 3)} />
                <div style={{ fontSize: 12, color: '#8a929d', marginTop: 6 }}>
                  {d.ad.normal
                    ? 'P ≥ 0.05,不能拒绝正态假设,可用正态相关方法(能力分析、t 检验)。'
                    : 'P < 0.05,数据显著偏离正态,建议先做 Box-Cox 变换或采用非参数方法。'}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: '#8a929d' }}>Anderson-Darling 正态检验至少需要 8 个观测,当前仅 {d.n} 个。</div>
            )}
          </div>
          <div style={{ borderTop: '1px solid #eef0f3', marginTop: 8, paddingTop: 8 }}>
            <div style={{ fontSize: 11.5, color: '#98a1ac', fontWeight: 600, marginBottom: 4 }}>95% 置信区间</div>
            {ciRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="描述性统计量" right={<span style={{ fontSize: 12, color: '#8a929d' }}>变量:{M.name}（{M.all.length} 个观测）</span>} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '2px 22px', padding: '2px 4px 6px' }}>
          {statRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </div>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 2px', borderBottom: '1px solid #f4f6f8', fontSize: 13 }}>
      <span style={{ color: '#5b6472' }}>{k}</span>
      <span className="mono" style={{ color: '#26303c', fontWeight: 600 }}>{v}</span>
    </div>
  );
}

/** 水平箱线图:Q1–中位–Q3 盒,须延伸到 1.5·IQR 内的极值,盒外点为离群。 */
function BoxPlot({ T, d }: { T: ChartTokens; d: ReturnType<typeof computeDescriptive> }) {
  const W = 640, H = 74, padL = 14, padR = 14;
  const loFence = d.q1 - 1.5 * d.iqr;
  const hiFence = d.q3 + 1.5 * d.iqr;
  const outliers = d.n > 0 ? undefined : undefined; // 由 whisker 端点近似（无原始数组时用 fence 与极值）
  // 须端点:取 fence 与实际极值中更靠内者
  const whiskLo = Math.max(d.min, loFence);
  const whiskHi = Math.min(d.max, hiFence);
  // 轴范围:含全部数据（含离群),留白
  const dataLo = Math.min(d.min, whiskLo);
  const dataHi = Math.max(d.max, whiskHi);
  const span = (dataHi - dataLo) || 1;
  const lo = dataLo - span * 0.06, hi = dataHi + span * 0.06;
  const X = (v: number) => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
  const cy = 34, bh = 26;
  const hasLoOut = d.min < loFence;
  const hasHiOut = d.max > hiFence;
  void outliers;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      {/* 须 */}
      <line x1={X(whiskLo)} y1={cy} x2={X(d.q1)} y2={cy} stroke={T.axis} strokeWidth={1.4} />
      <line x1={X(d.q3)} y1={cy} x2={X(whiskHi)} y2={cy} stroke={T.axis} strokeWidth={1.4} />
      <line x1={X(whiskLo)} y1={cy - 7} x2={X(whiskLo)} y2={cy + 7} stroke={T.axis} strokeWidth={1.4} />
      <line x1={X(whiskHi)} y1={cy - 7} x2={X(whiskHi)} y2={cy + 7} stroke={T.axis} strokeWidth={1.4} />
      {/* 盒 */}
      <rect x={X(d.q1)} y={cy - bh / 2} width={Math.max(1, X(d.q3) - X(d.q1))} height={bh} fill={T.bar3} stroke={T.bar} strokeWidth={1.4} />
      <line x1={X(d.median)} y1={cy - bh / 2} x2={X(d.median)} y2={cy + bh / 2} stroke={T.bar} strokeWidth={2.2} />
      {/* 均值菱形 */}
      <path d={`M ${X(d.mean)} ${cy - 5} L ${X(d.mean) + 5} ${cy} L ${X(d.mean)} ${cy + 5} L ${X(d.mean) - 5} ${cy} Z`} fill={T.curve} opacity={0.9} />
      {/* 离群点(近似:落在极值处) */}
      {hasLoOut && <circle cx={X(d.min)} cy={cy} r={3.4} fill="none" stroke={T.limit} strokeWidth={1.4} />}
      {hasHiOut && <circle cx={X(d.max)} cy={cy} r={3.4} fill="none" stroke={T.limit} strokeWidth={1.4} />}
      {/* 刻度标注 */}
      {[['min', d.min], ['Q1', d.q1], ['中位', d.median], ['Q3', d.q3], ['max', d.max]].map(([lab, v]) => (
        <text key={lab as string} x={X(v as number)} y={H - 6} fontSize={9.5} fill={T.text} textAnchor="middle">{nf(v as number, 2)}</text>
      ))}
    </svg>
  );
}
