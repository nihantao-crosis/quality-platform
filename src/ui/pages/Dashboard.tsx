/** 质量总览 — KPI / X̄ 趋势 / 帕累托 / 分析记录 / 告警，全部指标实时计算。 */
import { useMemo } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import {
  nf, DEFECTS, evalRules, computeCapability, oneWayAnova, anovaGroups,
} from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, Badge } from '../common';
import { ControlChart } from '../charts/ControlChart';
import { ParetoChart } from '../charts/misc';
import { useAnalyses } from '../../store/analyses';

export function Dashboard({ T }: { T: ChartTokens }) {
  const { goTo, lsl, usl, tgt } = useApp();
  const M = useData((s) => s.model);
  const cap = computeCapability(M.all, M.sigmaWithin, { lsl, tgt, usl });
  const anova = useMemo(() => oneWayAnova(anovaGroups().map((g) => g.vals)), []);

  // 告警由 X̄ 图判异实时派生（全部准则开启）
  const means = M.subs.map((s) => s.mean);
  const sigX = (M.uclX - M.xbarbar) / 3;
  const { list: violations } = evalRules(means, M.xbarbar, sigX, { r1: true, r2: true, r3: true, r4: true });
  const spcAlerts = violations.slice(0, 2).map((v) => ({
    color: '#c22f2f',
    title: `X̄ 图子组 ${v.i + 1} 违反准则 ${v.rule}`,
    desc: v.desc,
    page: 'spc' as const,
  }));
  const alerts = [
    ...spcAlerts,
    ...(anova.significant
      ? [{ color: '#e0902a', title: '设备间均值差异显著', desc: `ANOVA 显示设备间差异显著 (P=${nf(anova.pValue, 3)})`, page: 'anova' as const }]
      : []),
  ];

  const cpkGood = cap.cpk >= 1.33;
  const kpis = [
    { label: '过程能力 Cpk', value: nf(cap.cpk, 2), tag: cpkGood ? '达标' : '预警', color: cpkGood ? '#2c8a45' : '#e0902a', sub: '目标 ≥ 1.33' },
    { label: '一次合格率', value: '98.6%', tag: '▲0.4', color: '#2c8a45', sub: '较上月 · 演示指标' },
    { label: '不良 PPM', value: Math.round(cap.ppm.overall.total).toLocaleString(), tag: '', color: '#c22f2f', sub: '预计缺陷率' },
    { label: '未处理告警', value: String(alerts.length), tag: '', color: alerts.length > 0 ? '#e0902a' : '#2c8a45', sub: alerts.length > 0 ? `${spcAlerts.length} SPC · ${alerts.length - spcAlerts.length} ANOVA` : '过程受控' },
  ];

  const saved = useAnalyses((s) => s.saved);
  const restore = useAnalyses((s) => s.restore);
  const fmtTime = (t: number) => {
    const d = new Date(t);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {kpis.map((k) => (
          <Card key={k.label} style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12.5, color: '#8a929d', fontWeight: 500 }}>{k.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <div className="mono" style={{ fontSize: 30, fontWeight: 700, color: k.color, letterSpacing: '-0.02em' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: k.color, fontWeight: 600 }}>{k.tag}</div>
            </div>
            <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 6 }}>{k.sub}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>过程均值趋势 · {M.isDemo ? '直径 (mm)' : M.name}</div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>近 {M.k} 子组</div>
          </div>
          <div style={{ padding: '10px 14px 6px' }}>
            <ControlChart T={T} data={means} cl={M.xbarbar} ucl={M.uclX} lcl={M.lclX} clLabel="X̄" h={210} />
          </div>
        </Card>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>缺陷帕累托 · 本月</div>
          </div>
          <div style={{ padding: '10px 14px 6px' }}>
            <ParetoChart T={T} rows={DEFECTS} w={520} h={210} />
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 13.5, display: 'flex', alignItems: 'center' }}>
            近期分析记录
            {saved.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: '#9aa2ad' }}>{saved.length} 项</span>}
          </div>
          {saved.length === 0 ? (
            <div style={{ padding: '22px 16px', fontSize: 12.5, color: '#9aa2ad', lineHeight: 1.7 }}>
              暂无已保存的分析。打开任一分析模块（SPC / 过程能力 / ANOVA…）后,点右上角
              <b style={{ color: '#1f6fb2' }}> 保存到项目 </b>
              即把该次分析记录在此,点击可随时回看当时的数据集与参数。
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
                  <th style={{ padding: '9px 16px', fontWeight: 600 }}>分析</th>
                  <th style={{ padding: '9px 8px', fontWeight: 600 }}>数据集</th>
                  <th style={{ padding: '9px 8px', fontWeight: 600 }}>关键指标</th>
                  <th style={{ padding: '9px 8px', fontWeight: 600 }}>状态</th>
                  <th style={{ padding: '9px 16px', fontWeight: 600 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {saved.slice(0, 6).map((r) => (
                  <tr key={r.id} className="hov-row" title="点击回看此分析" onClick={() => restore(r.id)} style={{ borderTop: '1px solid #f0f2f5', cursor: 'pointer' }}>
                    <td style={{ padding: '9px 16px', color: '#33404f', fontWeight: 500 }}>{r.title}</td>
                    <td className="mono" style={{ padding: '9px 8px', color: '#5b6472', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.datasetName}</td>
                    <td className="mono" style={{ padding: '9px 8px', color: '#5b6472' }}>{r.metric}</td>
                    <td style={{ padding: '9px 8px' }}><Badge bg={r.statusBg} color={r.statusColor}>{r.status}</Badge></td>
                    <td className="mono" style={{ padding: '9px 16px', color: '#9aa2ad' }}>{fmtTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 13.5, display: 'flex', alignItems: 'center' }}>
            告警
            <span className="mono" style={{ marginLeft: 8, background: alerts.length > 0 ? '#e23b3b' : '#2c8a45', color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>{alerts.length}</span>
          </div>
          <div style={{ padding: '6px 0' }}>
            {alerts.length === 0 && (
              <div style={{ padding: '14px 16px', fontSize: 12.5, color: '#2c8a45', fontWeight: 500 }}>✓ 过程受控，暂无告警</div>
            )}
            {alerts.map((a) => (
              <div key={a.title} className="hov-alert" onClick={() => goTo(a.page)} style={{ display: 'flex', gap: 11, padding: '10px 16px', borderTop: '1px solid #f4f6f8', cursor: 'pointer' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, marginTop: 5, flex: 'none' }} />
                <div>
                  <div style={{ fontSize: 12.5, color: '#33404f', fontWeight: 500 }}>{a.title}</div>
                  <div style={{ fontSize: 11.5, color: '#8a929d', marginTop: 2 }}>{a.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
