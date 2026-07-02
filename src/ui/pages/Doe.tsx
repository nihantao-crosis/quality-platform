/** 实验设计 DOE ★深度实现 — 四视图切换 + Lenth 效应表 + 设计矩阵。 */
import { useApp, type DoeView } from '../../store/appStore';
import { nf, analyzeDoe, mainEffectMeans, interactionMeans, DOE_DESIGN } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, tabStyle } from '../common';
import { MainEffects, InteractionPlot, EffectsBar, CubePlot } from '../charts/doe';

const VIEWS: Array<[DoeView, string]> = [
  ['main', '主效应图'],
  ['interact', '交互作用图'],
  ['pareto', '效应帕累托'],
  ['cube', '立方图'],
];

const TITLES: Record<DoeView, string> = {
  main: '主效应图 · 响应 = 抗拉强度 (MPa)',
  interact: '交互作用图 · A 温度 × B 压力',
  pareto: '标准化效应帕累托 · Lenth 显著界限',
  cube: '立方图 · 8 顶点响应值',
};

export function Doe({ T }: { T: ChartTokens }) {
  const { doeView, setDoeView } = useApp();
  const r = analyzeDoe();
  const inter = interactionMeans();
  const col = (v: string) => (v === '+' ? '#2c8a45' : '#c22f2f');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>{TITLES[doeView]}</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {VIEWS.map(([k, l]) => (
              <div key={k} style={tabStyle(doeView === k)} onClick={() => setDoeView(k)}>{l}</div>
            ))}
          </div>
        </div>
        <div style={{ padding: '16px 16px 8px' }}>
          {doeView === 'main' && <MainEffects T={T} factors={mainEffectMeans()} />}
          {doeView === 'interact' && <InteractionPlot T={T} {...inter} />}
          {doeView === 'pareto' && <EffectsBar T={T} terms={r.terms} refLine={r.me} />}
          {doeView === 'cube' && <CubePlot T={T} y={(a, b, c) => DOE_DESIGN[a + 2 * b + 4 * c][3]} />}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
        <Card>
          <CardHeader title="效应与系数 (Lenth 检验)" />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'right' }}>
                <th style={{ padding: '8px 16px', fontWeight: 600, textAlign: 'left' }}>项</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>效应</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>系数</th>
                <th style={{ padding: '8px 16px', fontWeight: 600, textAlign: 'center' }}>显著性</th>
              </tr>
            </thead>
            <tbody>
              {r.terms.map((c) => (
                <tr key={c.name} className="mono" style={{ borderTop: '1px solid #f0f2f5', textAlign: 'right' }}>
                  <td style={{ padding: '8px 16px', textAlign: 'left', color: '#33404f', fontFamily: 'IBM Plex Sans', fontWeight: 500 }}>{c.name}</td>
                  <td style={{ padding: '8px 12px', color: '#2a333f', fontWeight: 600 }}>{nf(c.v, 2)}</td>
                  <td style={{ padding: '8px 12px', color: '#5b6472' }}>{nf(c.coef, 2)}</td>
                  <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                    <span style={{ fontFamily: 'IBM Plex Sans', fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 9, ...(c.sig ? { background: '#e8f4ea', color: '#2c8a45' } : { background: '#f4f6f8', color: '#9aa2ad' }) }}>
                      {c.sig ? '显著' : '不显著'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 8 }}>结论与优化</div>
          <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.65 }}>
            温度 (A) 与时间 (C) 为主导因子，压力 (B) 次之；交互作用不显著。要使抗拉强度最大化，应将温度、时间、压力均设为高水平 (+1)，预测强度约 66 MPa。
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="设计矩阵 · 2³ 全因子 (8 运行)" />
        <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'center', fontFamily: 'IBM Plex Sans' }}>
              <th style={{ padding: '8px 12px', fontWeight: 600 }}>运行</th>
              <th style={{ padding: '8px 12px', fontWeight: 600 }}>A 温度</th>
              <th style={{ padding: '8px 12px', fontWeight: 600 }}>B 压力</th>
              <th style={{ padding: '8px 12px', fontWeight: 600 }}>C 时间</th>
              <th style={{ padding: '8px 12px', fontWeight: 600, textAlign: 'right' }}>强度</th>
            </tr>
          </thead>
          <tbody>
            {DOE_DESIGN.map((d, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f0f2f5', textAlign: 'center' }}>
                <td style={{ padding: '7px 12px', color: '#9aa2ad' }}>{i + 1}</td>
                <td style={{ padding: '7px 12px', color: col(d[0]) }}>{d[0]}</td>
                <td style={{ padding: '7px 12px', color: col(d[1]) }}>{d[1]}</td>
                <td style={{ padding: '7px 12px', color: col(d[2]) }}>{d[2]}</td>
                <td style={{ padding: '7px 12px', color: '#2a333f', fontWeight: 600, textAlign: 'right' }}>{d[3]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
