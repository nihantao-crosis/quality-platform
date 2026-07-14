/** 抽样检验 AQL ★深度实现 — 批量/水平/AQL 实时重算 + OC 曲线 + 方案表 + 转移规则模拟。 */
import { useState } from 'react';
import { useApp } from '../../store/appStore';
import {
  aqlPlan, rqlFor, producerRiskPct, acceptNumber, N_BY_CODE, LETTERS, type InspectionLevel,
  recordBatch, plansByState, SWITCH_INIT, type SwitchStatus, type InspState,
} from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, tabStyle } from '../common';
import { OcCurveChart } from '../charts/OcCurveChart';

const STATE_META: Record<InspState, { label: string; bg: string; color: string }> = {
  normal: { label: '正常检验', bg: '#e7f0f9', color: '#1f6fb2' },
  tightened: { label: '加严检验', bg: '#fdecec', color: '#c22f2f' },
  reduced: { label: '放宽检验', bg: '#e8f4ea', color: '#2c8a45' },
};

const AQL_OPTIONS = [0.65, 1.0, 1.5, 2.5, 4.0];
const LEVEL_SHIFT: Record<InspectionLevel, number> = { I: -2, II: 0, III: 2 };
const fmtLot = (lo: number, hi: number) => `${lo.toLocaleString()}–${hi.toLocaleString()}`;

/** 按当前检验水平生成完整批量范围 → 字码方案表(与 aqlPlan 的水平位移口径一致,覆盖到 15 万)。 */
function planTableRows(level: InspectionLevel, aqlPct: number, lot: number) {
  const shift = LEVEL_SHIFT[level];
  return LETTERS.map(([, lo, hi], i) => {
    const idx = Math.max(0, Math.min(LETTERS.length - 1, i + shift));
    const code = LETTERS[idx][0];
    const n = N_BY_CODE[code];
    const ac = acceptNumber(n, aqlPct);
    return { label: fmtLot(lo, hi), code, n, ac, active: lot >= lo && lot <= hi };
  });
}

export function Aql({ T }: { T: ChartTokens }) {
  const { aqlLot, aqlLevel, aqlAQL, setAql } = useApp();
  const [sw, setSw] = useState<SwitchStatus>(SWITCH_INIT);
  const plan = aqlPlan(aqlLot, aqlLevel, aqlAQL);
  const aqlP = aqlAQL / 100;
  const rqlP = rqlFor(plan);
  const prodRisk = producerRiskPct(plan, aqlAQL);
  const statePlans = plansByState(aqlLot, aqlLevel, aqlAQL);
  const meta = STATE_META[sw.state];

  const fmtAql = (a: number) => 'AQL ' + a.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5b6472' }}>
          批量 N
          <input
            type="number"
            min={2}
            value={aqlLot}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v)) setAql({ aqlLot: Math.max(2, Math.min(150000, v)) }); // 批量须 ≥2、≤15 万,避免 0/负数静默回落
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>转移规则模拟 · 正常 / 加严 / 放宽</div>
            <div style={{ marginLeft: 'auto', padding: '2px 10px', borderRadius: 11, fontSize: 12, fontWeight: 700, background: meta.bg, color: meta.color }}>{meta.label}</div>
          </div>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: '#5b6472', marginBottom: 10 }}>{sw.note}</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div onClick={() => setSw(recordBatch(sw, 'A'))} style={{ padding: '6px 14px', background: '#2c8a45', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>✓ 本批接收</div>
              <div onClick={() => setSw(recordBatch(sw, 'R'))} style={{ padding: '6px 14px', background: '#c22f2f', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>✗ 本批拒收</div>
              <div onClick={() => setSw(SWITCH_INIT)} style={{ padding: '6px 14px', border: '1px solid #cfd5dd', color: '#5b6472', borderRadius: 5, fontSize: 12.5, cursor: 'pointer' }}>重置</div>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minHeight: 18, marginBottom: 10 }}>
              {sw.history.slice(-30).map((r, i) => (
                <span key={i} title={r === 'A' ? '接收' : '拒收'} style={{ width: 14, height: 14, borderRadius: 3, background: r === 'A' ? '#2c8a45' : '#c22f2f', display: 'inline-block' }} />
              ))}
              {sw.history.length === 0 && <span style={{ fontSize: 12, color: '#9aa2ad' }}>点击按钮模拟批检验结果…</span>}
            </div>
            <div style={{ fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.6 }}>
              正常→加严：连续 5 批中 2 批拒收 · 加严→正常：连续 5 批接收<br />
              正常→放宽：连续 10 批接收 · 放宽→正常：任 1 批拒收（GB/T 2828.1 简化模型）
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="三种检验状态的方案对比（当前批量与 AQL）" />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
                <th style={{ padding: '9px 16px', fontWeight: 600 }}>状态</th>
                <th style={{ padding: '9px 8px', fontWeight: 600 }}>字码</th>
                <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>n</th>
                <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>Ac</th>
                <th style={{ padding: '9px 16px', fontWeight: 600, textAlign: 'right' }}>Re</th>
              </tr>
            </thead>
            <tbody>
              {(['normal', 'tightened', 'reduced'] as InspState[]).map((st) => {
                const p = statePlans[st];
                const m2 = STATE_META[st];
                const active = st === sw.state;
                return (
                  <tr key={st} style={{ borderTop: '1px solid #f0f2f5', ...(active ? { background: m2.bg } : {}) }}>
                    <td style={{ padding: '8px 16px', color: m2.color, fontWeight: active ? 700 : 500 }}>{m2.label}{active ? ' ←' : ''}</td>
                    <td className="mono" style={{ padding: '8px 8px', color: '#5b6472' }}>{p.code}</td>
                    <td className="mono" style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600, color: '#2a333f' }}>{p.n}</td>
                    <td className="mono" style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600, color: '#2c8a45' }}>{p.ac}</td>
                    <td className="mono" style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, color: '#c22f2f' }}>{p.re}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.55 }}>
            简化模型：加严 = 同样本量、Ac−1；放宽 = 字码降两档。生产环境应使用标准正式表格。
          </div>
        </Card>
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
            {planTableRows(aqlLevel, aqlAQL, aqlLot).map((row) => (
              <tr key={row.label} style={{ borderTop: '1px solid #f0f2f5', ...(row.active ? { background: '#e7f0f9' } : {}) }}>
                <td className="mono" style={{ padding: '8px 16px', color: '#33404f' }}>{row.label}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#5b6472' }}>{row.code}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#2a333f', textAlign: 'right', fontWeight: 600 }}>{row.n}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#2c8a45', textAlign: 'right', fontWeight: 600 }}>{row.ac}</td>
                <td className="mono" style={{ padding: '8px 16px', color: '#c22f2f', textAlign: 'right', fontWeight: 600 }}>{row.ac + 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
