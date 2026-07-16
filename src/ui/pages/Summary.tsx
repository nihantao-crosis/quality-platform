/** 描述性统计 · 图形化摘要（对标 Minitab Graphical Summary）。 */
import { useState } from 'react';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { computeDescriptive, nf, resolveNumericColumn } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, Badge } from '../common';
import { Histogram } from '../charts/Histogram';

export function Summary({ T }: { T: ChartTokens }) {
  const { model: M, pendingCells } = useData();
  const { activeVar, setActiveVar } = useApp();
  const [bins, setBins] = useState(13);
  const selected = resolveNumericColumn(M, activeVar);
  const pending = pendingCells.filter((cell) => cell.col === selected.index);
  const d = computeDescriptive(selected.values);

  const dp = 3; // 显示小数位
  const statRows: Array<[string, string, string?]> = [
    ['观测数 N', String(d.n)],
    ['均值', nf(d.mean, dp)],
    ['均值标准误 SE', nf(d.seMean, dp)],
    ['标准差', nf(d.stdev, dp)],
    ['方差', nf(d.variance, dp)],
    ['变异系数 CV', d.cv == null ? '—（均值为 0）' : nf(d.cv, 2) + ' %'],
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
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#5b6472', fontSize: 12.5 }}>
          分析变量
          <select
            aria-label="描述性统计变量"
            value={selected.name}
            onChange={(event) => setActiveVar(event.target.value)}
            style={{ padding: '5px 9px', border: '1px solid #cfd5dd', borderRadius: 4, background: '#fff', color: '#2a333f' }}
          >
            {M.colNames.map((name, index) => <option key={`${name}-${index}`} value={name}>{name}</option>)}
          </select>
        </label>
        <span style={{ fontSize: 11.5, color: '#8a929d' }}>一次只分析一个数值变量；不会把不同量纲的列展平混算。</span>
      </Card>
      {pending.length > 0 ? (
        <Card style={{ padding: '18px 20px', color: '#b0620f', background: '#fff8e8', lineHeight: 1.7 }}>
          <b>描述性统计尚未运行：</b>「{selected.name}」还有 {pending.length} 个待录入单元格。完成录入后再分析，系统不会把占位值当实测值。
        </Card>
      ) : (
      <>
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
          <Histogram T={T} data={selected.values} mu={d.mean} sigmaWithin={d.stdev} sigmaOverall={d.stdev} lsl={null} usl={null} tgt={d.mean} bins={bins} h={210} />
          <BoxPlot T={T} data={selected.values} d={d} />
          <div style={{ fontSize: 11.5, color: '#98a1ac', padding: '2px 4px 4px' }}>
            上:直方图叠正态曲线（μ={nf(d.mean, dp)}, σ={nf(d.stdev, dp)}）· 下:箱线图（Q1–中位–Q3,须及 1.5·IQR,○ 为离群点）
          </div>
        </Card>

        <Card style={{ flex: '1 1 300px', minWidth: 280 }}>
          <CardHeader
            title="正态性检验"
            right={d.adAvailable
              ? <Badge bg={d.ad.normal ? '#e8f4ea' : '#fcf3e3'} color={d.ad.normal ? '#2c8a45' : '#d98324'}>{d.ad.normal ? '近似正态' : '偏离正态'}</Badge>
              : <Badge bg="#eef1f4" color="#8a929d">不可检验</Badge>}
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
              <div style={{ fontSize: 12.5, color: '#8a929d' }}>{d.adUnavailableReason}</div>
            )}
          </div>
          <div style={{ borderTop: '1px solid #eef0f3', marginTop: 8, paddingTop: 8 }}>
            <div style={{ fontSize: 11.5, color: '#98a1ac', fontWeight: 600, marginBottom: 4 }}>95% 置信区间</div>
            {ciRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="描述性统计量" right={<span style={{ fontSize: 12, color: '#8a929d' }}>变量：{selected.name}（{selected.values.length} 个观测）</span>} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '2px 22px', padding: '2px 4px 6px' }}>
          {statRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </div>
      </Card>
      </>
      )}
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
function BoxPlot({ T, data, d }: { T: ChartTokens; data: number[]; d: ReturnType<typeof computeDescriptive> }) {
  const W = 640, H = 74, padL = 14, padR = 14;
  const loFence = d.q1 - 1.5 * d.iqr;
  const hiFence = d.q3 + 1.5 * d.iqr;
  const sorted = [...data].sort((a, b) => a - b);
  const inliers = sorted.filter((value) => value >= loFence && value <= hiFence);
  const outliers = sorted.filter((value) => value < loFence || value > hiFence);
  // Tukey 须必须落在真实观测值上，不能直接把理论 fence 当须端。
  const whiskLo = inliers[0] ?? d.q1;
  const whiskHi = inliers[inliers.length - 1] ?? d.q3;
  // 轴范围:含全部数据（含离群),留白
  const dataLo = Math.min(d.min, whiskLo);
  const dataHi = Math.max(d.max, whiskHi);
  const span = (dataHi - dataLo) || 1;
  const lo = dataLo - span * 0.06, hi = dataHi + span * 0.06;
  const X = (v: number) => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
  const cy = 34, bh = 26;

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
      {/* 全部离群观测；重复值稍作纵向错位，避免只看见一个点。 */}
      {outliers.map((value, index) => (
        <circle key={`${value}-${index}`} cx={X(value)} cy={cy + ((index % 3) - 1) * 5} r={3.2} fill="none" stroke={T.limit} strokeWidth={1.3} />
      ))}
      {/* 刻度标注 */}
      {[['min', d.min], ['Q1', d.q1], ['中位', d.median], ['Q3', d.q3], ['max', d.max]].map(([lab, v]) => (
        <text key={lab as string} x={X(v as number)} y={H - 6} fontSize={9.5} fill={T.text} textAnchor="middle">{nf(v as number, 2)}</text>
      ))}
    </svg>
  );
}
