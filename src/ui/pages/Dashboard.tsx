/** 质量总览 — KPI 卡 / X̄ 趋势 / 帕累托 / 分析记录 / 告警。 */
import { useApp } from '../../store/appStore';
import { nf, DEFECTS, type DataModel } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, Badge } from '../common';
import { ControlChart } from '../charts/ControlChart';
import { ParetoChart } from '../charts/misc';

export function Dashboard({ M, T }: { M: DataModel; T: ChartTokens }) {
  const goTo = useApp((s) => s.goTo);
  const cpkGood = M.Cpk >= 1.33;
  const kpis = [
    { label: '过程能力 Cpk', value: nf(M.Cpk, 2), tag: cpkGood ? '达标' : '预警', color: cpkGood ? '#2c8a45' : '#e0902a', sub: '目标 ≥ 1.33' },
    { label: '一次合格率', value: '98.6%', tag: '▲0.4', color: '#2c8a45', sub: '较上月' },
    { label: '不良 PPM', value: Math.round(M.ppm).toLocaleString(), tag: '', color: '#c22f2f', sub: '预计缺陷率' },
    { label: '未处理告警', value: '3', tag: '', color: '#e0902a', sub: '2 高 · 1 中' },
  ];
  const recentRuns = [
    { name: 'X̄-R 控制图', v: 'C2 直径', metric: '2 失控点', status: '需关注', bg: '#fdecec', c: '#c22f2f', time: '10:24', page: 'spc' as const },
    { name: '过程能力', v: 'C2 直径', metric: 'Cpk ' + nf(M.Cpk, 2), status: cpkGood ? '合格' : '预警', bg: cpkGood ? '#e8f4ea' : '#fcf3e3', c: cpkGood ? '#2c8a45' : '#e0902a', time: '10:18', page: 'capability' as const },
    { name: 'Gage R&R', v: 'C2 直径', metric: '8.4%', status: '合格', bg: '#e8f4ea', c: '#2c8a45', time: '09:52', page: 'gagerr' as const },
    { name: '单因子 ANOVA', v: '直径~设备', metric: 'P 0.012', status: '显著', bg: '#e7f0f9', c: '#1f6fb2', time: '09:30', page: 'anova' as const },
    { name: '帕累托', v: '缺陷类别', metric: 'Top2 = 68%', status: '合格', bg: '#e8f4ea', c: '#2c8a45', time: '昨日', page: 'pareto' as const },
  ];
  const alerts = [
    { color: '#c22f2f', title: 'X̄ 图子组 16–18 超出上控制限', desc: '连续 3 点位于中心线上方 · 可能过程偏移', page: 'spc' as const },
    { color: '#c22f2f', title: '子组 22 低于下控制限', desc: '单点越限 · Nelson 准则 1', page: 'spc' as const },
    { color: '#e0902a', title: '设备 B 均值偏高', desc: 'ANOVA 显示设备间差异显著 (P=0.012)', page: 'anova' as const },
  ];

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
            <div style={{ fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>过程均值趋势 · 直径 (mm)</div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>近 25 子组</div>
          </div>
          <div style={{ padding: '10px 14px 6px' }}>
            <ControlChart T={T} data={M.means} cl={M.xbarbar} ucl={M.uclX} lcl={M.lclX} clLabel="X̄" h={210} />
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
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>近期分析记录</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
                <th style={{ padding: '9px 16px', fontWeight: 600 }}>分析</th>
                <th style={{ padding: '9px 8px', fontWeight: 600 }}>变量</th>
                <th style={{ padding: '9px 8px', fontWeight: 600 }}>关键指标</th>
                <th style={{ padding: '9px 8px', fontWeight: 600 }}>状态</th>
                <th style={{ padding: '9px 16px', fontWeight: 600 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((r) => (
                <tr key={r.name} className="hov-row" onClick={() => goTo(r.page)} style={{ borderTop: '1px solid #f0f2f5', cursor: 'pointer' }}>
                  <td style={{ padding: '9px 16px', color: '#33404f', fontWeight: 500 }}>{r.name}</td>
                  <td className="mono" style={{ padding: '9px 8px', color: '#5b6472' }}>{r.v}</td>
                  <td className="mono" style={{ padding: '9px 8px', color: '#5b6472' }}>{r.metric}</td>
                  <td style={{ padding: '9px 8px' }}><Badge bg={r.bg} color={r.c}>{r.status}</Badge></td>
                  <td className="mono" style={{ padding: '9px 16px', color: '#9aa2ad' }}>{r.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 13.5, display: 'flex', alignItems: 'center' }}>
            告警 <span className="mono" style={{ marginLeft: 8, background: '#e23b3b', color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>3</span>
          </div>
          <div style={{ padding: '6px 0' }}>
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
