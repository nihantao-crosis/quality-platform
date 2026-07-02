/** 抽样检验 AQL ★深度实现 — 批量/水平/AQL 实时重算 + OC 曲线 + 方案表。 */
import { useApp } from '../../store/appStore';
import { aqlPlan, rqlFor, producerRiskPct, acceptNumber, N_BY_CODE, type InspectionLevel } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, tabStyle } from '../common';
import { OcCurveChart } from '../charts/OcCurveChart';

const AQL_OPTIONS = [0.65, 1.0, 1.5, 2.5, 4.0];
/** 方案表展示前 10 档批量范围 */
const TABLE_ROWS: Array<[string, string]> = [
  ['2–8', 'A'], ['9–15', 'B'], ['16–25', 'C'], ['26–50', 'D'], ['51–90', 'E'],
  ['91–150', 'F'], ['151–280', 'G'], ['281–500', 'H'], ['501–1200', 'J'], ['1201–3200', 'K'],
];

export function Aql({ T }: { T: ChartTokens }) {
  const { aqlLot, aqlLevel, aqlAQL, setAql } = useApp();
  const plan = aqlPlan(aqlLot, aqlLevel, aqlAQL);
  const aqlP = aqlAQL / 100;
  const rqlP = rqlFor(plan);
  const prodRisk = producerRiskPct(plan, aqlAQL);

  const fmtAql = (a: number) => 'AQL ' + a.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5b6472' }}>
          批量 N
          <input
            type="number"
            value={aqlLot}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v)) setAql({ aqlLot: v });
            }}
            className="mono"
            style={{ width: 96, padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5, color: '#2a333f' }}
          />
        </label>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>检验水平</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['I', 'II', 'III'] as InspectionLevel[]).map((l) => (
            <div key={l} style={tabStyle(aqlLevel === l)} onClick={() => setAql({ aqlLevel: l })}>水平 {l}</div>
          ))}
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>AQL</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {AQL_OPTIONS.map((a) => (
            <div key={a} style={tabStyle(aqlAQL === a)} onClick={() => setAql({ aqlAQL: a })}>{fmtAql(a)}</div>
          ))}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {[
          { k: '样本字码', v: plan.code },
          { k: '样本量 n', v: String(plan.n) },
          { k: '接收数 Ac', v: String(plan.ac) },
          { k: '拒收数 Re', v: String(plan.re) },
        ].map((c) => (
          <Card key={c.k} style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: '#8a929d' }}>{c.k}</div>
            <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: '#1f6fb2', marginTop: 4 }}>{c.v}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <Card>
          <CardHeader title="OC 特性曲线 · 接收概率 vs 批质量" />
          <div style={{ padding: '14px 16px 6px' }}>
            <OcCurveChart T={T} n={plan.n} ac={plan.ac} pmax={Math.max(0.1, rqlP * 1.25)} aqlP={aqlP} rqlP={rqlP} />
          </div>
        </Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>风险指标</div>
            <KvRows
              rows={[
                { k: 'AQL (可接收质量)', v: (aqlP * 100).toFixed(2) + '%' },
                { k: '生产方风险 α', v: prodRisk.toFixed(1) + '%' },
                { k: 'RQL / LTPD (Pa=10%)', v: (rqlP * 100).toFixed(2) + '%' },
                { k: '使用方风险 β', v: '10.0%' },
              ]}
            />
            <div style={{ marginTop: 12, padding: 11, background: '#f7f9fb', border: '1px solid #eef1f4', borderRadius: 4, fontSize: 11.5, color: '#6b7480', lineHeight: 1.55 }}>
              OC 曲线描述在不同批质量 p 下该抽样方案的接收概率 Pa。绿线为 AQL 点（生产方希望高概率接收），红线为 RQL 点（使用方希望低概率接收，此处 Pa=10%）。曲线越陡，方案对好坏批的区分力越强。
            </div>
          </Card>
        </div>
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>抽样方案表 (当前检验水平与 AQL，高亮为当前批量)</div>
          <div style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>依据 GB/T 2828.1 · ≈95% 接收于 AQL</div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
              <th style={{ padding: '9px 16px', fontWeight: 600 }}>批量范围 N</th>
              <th style={{ padding: '9px 8px', fontWeight: 600 }}>样本字码</th>
              <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>样本量 n</th>
              <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>Ac 接收</th>
              <th style={{ padding: '9px 16px', fontWeight: 600, textAlign: 'right' }}>Re 拒收</th>
            </tr>
          </thead>
          <tbody>
            {TABLE_ROWS.map(([lot, code]) => {
              const n = N_BY_CODE[code];
              const ac = acceptNumber(n, aqlAQL);
              return (
                <tr key={code} style={{ borderTop: '1px solid #f0f2f5', ...(code === plan.code ? { background: '#e7f0f9' } : {}) }}>
                  <td className="mono" style={{ padding: '8px 16px', color: '#33404f' }}>{lot}</td>
                  <td className="mono" style={{ padding: '8px 8px', color: '#5b6472' }}>{code}</td>
                  <td className="mono" style={{ padding: '8px 8px', color: '#2a333f', textAlign: 'right', fontWeight: 600 }}>{n}</td>
                  <td className="mono" style={{ padding: '8px 8px', color: '#2c8a45', textAlign: 'right', fontWeight: 600 }}>{ac}</td>
                  <td className="mono" style={{ padding: '8px 16px', color: '#c22f2f', textAlign: 'right', fontWeight: 600 }}>{ac + 1}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
