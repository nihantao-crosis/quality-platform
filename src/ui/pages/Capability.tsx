/** 过程能力分析 ★深度实现 — 可编辑规格限实时重算 + 直方图 + PPM 性能表。 */
import { useApp } from '../../store/appStore';
import { nf, computeCapability, type DataModel } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, numInput } from '../common';
import { Histogram } from '../charts/Histogram';

export function Capability({ M, T }: { M: DataModel; T: ChartTokens }) {
  const { lsl, usl, tgt, setSpec } = useApp();
  const cap = computeCapability(M.all, M.sigmaWithin, { lsl, tgt, usl });
  const good = cap.verdict === 'sufficient';
  const marginal = cap.verdict === 'marginal';

  const verdictStyle = good
    ? { background: '#e8f4ea', color: '#2c8a45' }
    : marginal
      ? { background: '#fcf3e3', color: '#d98324' }
      : { background: '#fdecec', color: '#c22f2f' };

  const inputs: Array<{ label: string; value: number; key: 'lsl' | 'tgt' | 'usl' }> = [
    { label: 'LSL 下限', value: lsl, key: 'lsl' },
    { label: '目标 Target', value: tgt, key: 'tgt' },
    { label: 'USL 上限', value: usl, key: 'usl' },
  ];

  const big = [
    { k: 'Cp', v: nf(cap.cp, 2), color: '#1f6fb2' },
    { k: 'Cpk', v: nf(cap.cpk, 2), color: good ? '#2c8a45' : marginal ? '#d98324' : '#c22f2f' },
    { k: 'Pp', v: nf(cap.pp, 2), color: '#1f6fb2' },
    { k: 'Ppk', v: nf(cap.ppk, 2), color: '#5b6472' },
  ];
  const big2 = [
    { k: 'CPU', v: nf(cap.cpu, 2) },
    { k: 'CPL', v: nf(cap.cpl, 2) },
    { k: 'Z.bench', v: nf(cap.zBench, 2) },
    { k: '西格玛水平', v: nf(cap.sigmaLevel, 2) + 'σ' },
  ];
  const perf = [
    { k: '实测 (观测)', lsl: '—', usl: '—', ppm: Math.round(cap.ppm.observed).toLocaleString() },
    { k: '组内 (潜在)', lsl: Math.round(cap.ppm.within.belowLsl).toLocaleString(), usl: Math.round(cap.ppm.within.aboveUsl).toLocaleString(), ppm: Math.round(cap.ppm.within.total).toLocaleString() },
    { k: '整体 (实际)', lsl: Math.round(cap.ppm.overall.belowLsl).toLocaleString(), usl: Math.round(cap.ppm.overall.aboveUsl).toLocaleString(), ppm: Math.round(cap.ppm.overall.total).toLocaleString() },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>规格限 (可编辑，实时重算)</span>
        {inputs.map((i) => (
          <label key={i.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#5b6472' }}>
            {i.label}
            <input
              type="number"
              step="0.01"
              value={i.value}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) setSpec({ [i.key]: v });
              }}
              style={numInput}
            />
          </label>
        ))}
        <div
          onClick={() => setSpec({ lsl: 24.9, tgt: 25.0, usl: 25.1 })}
          style={{ padding: '5px 12px', border: '1px solid #cfd5dd', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#5b6472', background: '#fff' }}
        >
          复位
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>过程能力直方图 · 直径 (mm)</div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>正态拟合</div>
          </div>
          <div style={{ padding: '12px 16px 6px' }}>
            <Histogram T={T} data={M.all} mu={M.oMean} sigmaWithin={M.sigmaWithin} sigmaOverall={M.oSd} lsl={lsl} usl={usl} tgt={tgt} h={320} />
          </div>
          <div style={{ display: 'flex', gap: 22, padding: '6px 20px 16px', fontSize: 12, color: '#7a828d' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 22, height: 0, borderTop: `2px solid ${T.curve}` }} />组内</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 22, height: 0, borderTop: `2px dashed ${T.curve2}` }} />整体</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 2, height: 14, background: '#c026a6' }} />规格限</span>
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: '#33404f' }}>能力评估</div>
              <div style={{ marginLeft: 'auto', padding: '2px 10px', borderRadius: 11, fontSize: 12, fontWeight: 700, ...verdictStyle }}>
                {good ? '能力充足' : marginal ? '能力临界' : '能力不足'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {big.map((c) => (
                <div key={c.k} style={{ background: '#f7f9fb', border: '1px solid #eaeef2', borderRadius: 4, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11.5, color: '#8a929d' }}>{c.k}</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: c.color, marginTop: 3 }}>{c.v}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              {big2.map((c) => (
                <div key={c.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f7f9fb', border: '1px solid #eef1f4', borderRadius: 4, fontSize: 12.5 }}>
                  <span style={{ color: '#8a929d' }}>{c.k}</span>
                  <span className="mono" style={{ color: '#2a333f', fontWeight: 600 }}>{c.v}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card style={{ padding: 16 }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 8 }}>详细统计</div>
            <KvRows
              valueWeight={500}
              rows={[
                { k: '样本均值 X̄', v: nf(cap.mean, 4) },
                { k: '样本量 N', v: String(cap.n) },
                { k: 'σ 组内 (R̄/d₂)', v: nf(cap.sigmaWithin, 4) },
                { k: 'σ 整体', v: nf(cap.sigmaOverall, 4) },
                { k: '规格 LSL / 目标 / USL', v: nf(lsl, 2) + ' / ' + nf(tgt, 2) + ' / ' + nf(usl, 2) },
              ]}
            />
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader title="性能 · 每百万缺陷数 (PPM)" />
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'right' }}>
              <th style={{ padding: '9px 16px', fontWeight: 600, textAlign: 'left' }}>来源</th>
              <th style={{ padding: '9px 12px', fontWeight: 600 }}>PPM &lt; LSL</th>
              <th style={{ padding: '9px 12px', fontWeight: 600 }}>PPM &gt; USL</th>
              <th style={{ padding: '9px 16px', fontWeight: 600 }}>PPM 合计</th>
            </tr>
          </thead>
          <tbody>
            {perf.map((p) => (
              <tr key={p.k} className="mono" style={{ borderTop: '1px solid #f0f2f5', textAlign: 'right' }}>
                <td style={{ padding: '9px 16px', textAlign: 'left', color: '#33404f', fontFamily: 'IBM Plex Sans', fontWeight: 500 }}>{p.k}</td>
                <td style={{ padding: '9px 12px', color: '#5b6472' }}>{p.lsl}</td>
                <td style={{ padding: '9px 12px', color: '#5b6472' }}>{p.usl}</td>
                <td style={{ padding: '9px 16px', color: '#2a333f', fontWeight: 600 }}>{p.ppm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
