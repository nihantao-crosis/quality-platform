/** Gage R&R / ANOVA / 帕累托 — 结构完整的展示页面。 */
import { useMemo } from 'react';
import { anovaGroups, DEFECTS, GAGE_ROWS } from '../../core';
import type { ChartTokens } from '../tokens';
import { paretoColors } from '../tokens';
import { Card, CardHeader } from '../common';
import { ParetoChart, GroupedBars, BoxPlot } from '../charts/misc';

// ---------- Gage R&R ----------
export function GageRR({ T }: { T: ChartTokens }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
      <Card>
        <CardHeader title="变异分量 · 交叉 Gage R&R (ANOVA 法)" />
        <div style={{ padding: '14px 16px 6px' }}>
          <GroupedBars T={T} />
        </div>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>系统评定</div>
            <div style={{ marginLeft: 'auto', padding: '2px 10px', borderRadius: 11, fontSize: 12, fontWeight: 700, background: '#e8f4ea', color: '#2c8a45' }}>可接受</div>
          </div>
          <div className="mono" style={{ fontSize: 34, fontWeight: 700, color: '#2c8a45' }}>8.4%</div>
          <div style={{ fontSize: 12, color: '#8a929d', marginTop: 2 }}>合计 Gage R&R (%研究变异)</div>
          <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 10, lineHeight: 1.5 }}>&lt; 10% 优秀 · 10–30% 可接受 · &gt; 30% 不可接受 (AIAG)</div>
        </Card>
        <Card>
          <div style={{ padding: '11px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 12.5 }}>方差分量</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
                <th style={{ padding: '7px 16px', fontWeight: 600 }}>来源</th>
                <th style={{ padding: '7px 8px', fontWeight: 600, textAlign: 'right' }}>%贡献</th>
                <th style={{ padding: '7px 16px', fontWeight: 600, textAlign: 'right' }}>%研究</th>
              </tr>
            </thead>
            <tbody>
              {GAGE_ROWS.map((g) => (
                <tr key={g.src} style={{ borderTop: '1px solid #f0f2f5' }}>
                  <td style={{ padding: '7px 16px', color: '#33404f', whiteSpace: 'pre' }}>{g.src}</td>
                  <td className="mono" style={{ padding: '7px 8px', textAlign: 'right', color: '#5b6472' }}>{g.contrib}</td>
                  <td className="mono" style={{ padding: '7px 16px', textAlign: 'right', color: '#2a333f', fontWeight: 600 }}>{g.study}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

// ---------- ANOVA ----------
const ANOVA_ROWS = [
  { src: '设备', df: '2', ss: '0.00947', f: '4.82', p: '0.012', pColor: '#c22f2f' },
  { src: '误差', df: '33', ss: '0.03241', f: '', p: '', pColor: '#5b6472' },
  { src: '合计', df: '35', ss: '0.04188', f: '', p: '', pColor: '#5b6472' },
];

export function Anova({ T }: { T: ChartTokens }) {
  const groups = useMemo(() => anovaGroups(), []);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
      <Card>
        <CardHeader title="单因子方差分析 · 直径 vs 设备" />
        <div style={{ padding: '14px 16px 6px' }}>
          <BoxPlot T={T} groups={groups} />
        </div>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card>
          <div style={{ padding: '11px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 12.5 }}>方差分析表</div>
          <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'right', fontFamily: 'IBM Plex Sans' }}>
                <th style={{ padding: '7px 8px 7px 16px', textAlign: 'left', fontWeight: 600 }}>来源</th>
                <th style={{ padding: '7px 6px', fontWeight: 600 }}>DF</th>
                <th style={{ padding: '7px 6px', fontWeight: 600 }}>SS</th>
                <th style={{ padding: '7px 6px', fontWeight: 600 }}>F</th>
                <th style={{ padding: '7px 16px', fontWeight: 600 }}>P</th>
              </tr>
            </thead>
            <tbody>
              {ANOVA_ROWS.map((a) => (
                <tr key={a.src} style={{ borderTop: '1px solid #f0f2f5', textAlign: 'right' }}>
                  <td style={{ padding: '7px 8px 7px 16px', textAlign: 'left', color: '#33404f', fontFamily: 'IBM Plex Sans' }}>{a.src}</td>
                  <td style={{ padding: '7px 6px', color: '#5b6472' }}>{a.df}</td>
                  <td style={{ padding: '7px 6px', color: '#5b6472' }}>{a.ss}</td>
                  <td style={{ padding: '7px 6px', color: '#5b6472' }}>{a.f}</td>
                  <td style={{ padding: '7px 16px', color: a.pColor, fontWeight: 600 }}>{a.p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card style={{ padding: '15px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 6 }}>结论</div>
          <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.6 }}>
            P = 0.012 &lt; 0.05，在 95% 置信水平下拒绝原假设：三台设备的直径均值存在显著差异。设备 B 均值偏高，建议核查其定位与刀具补偿参数。
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------- 帕累托 ----------
export function Pareto({ T }: { T: ChartTokens }) {
  const colors = paretoColors(T);
  const total = DEFECTS.reduce((a, d) => a + d.count, 0);
  let cum = 0;
  const rows = DEFECTS.map((d, i) => {
    cum += d.count;
    return { ...d, cum: Math.round((cum / total) * 100) + '%', color: colors[i % colors.length] };
  });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
      <Card>
        <CardHeader title="缺陷帕累托图 · 2026 年 6 月" />
        <div style={{ padding: '14px 16px 6px' }}>
          <ParetoChart T={T} rows={DEFECTS} w={960} h={340} />
        </div>
      </Card>
      <Card>
        <CardHeader title="缺陷明细" />
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
              <th style={{ padding: '8px 16px', fontWeight: 600 }}>类别</th>
              <th style={{ padding: '8px 8px', fontWeight: 600, textAlign: 'right' }}>数量</th>
              <th style={{ padding: '8px 16px', fontWeight: 600, textAlign: 'right' }}>累计%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.name} style={{ borderTop: '1px solid #f0f2f5' }}>
                <td style={{ padding: '8px 16px', color: '#33404f' }}>
                  <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: d.color, marginRight: 8 }} />
                  {d.name}
                </td>
                <td className="mono" style={{ padding: '8px 8px', color: '#2a333f', textAlign: 'right', fontWeight: 600 }}>{d.count}</td>
                <td className="mono" style={{ padding: '8px 16px', color: '#5b6472', textAlign: 'right' }}>{d.cum}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: '12px 16px', margin: 6, background: '#f2f8f3', border: '1px solid #d6ebda', borderRadius: 4, fontSize: 12, color: '#2c6b3c', lineHeight: 1.55 }}>
          「尺寸超差」与「表面划伤」合计占缺陷总数的 68%。按 80/20 原则，优先针对这两类缺陷开展改善（如刀具磨损监控与来料表面检验），可消除大部分不良。
        </div>
      </Card>
    </div>
  );
}
