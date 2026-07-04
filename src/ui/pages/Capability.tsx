/** 过程能力分析 ★深度实现 — 可编辑规格限实时重算 + 直方图 + PPM 性能表。 */
import { useApp } from '../../store/appStore';
import { useData, suggestedSpec, rememberSpecFor } from '../../store/dataStore';
import { nf, computeCapability, andersonDarling, bestLambda, transformWithSpec, stdev } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, numInput, Badge } from '../common';
import { Histogram } from '../charts/Histogram';
import { NormalProbPlot } from '../charts/NormalProbPlot';

export function Capability({ T }: { T: ChartTokens }) {
  const { lsl, usl, tgt, setSpec: setSpecRaw } = useApp();
  // 写规格限时同步记忆到当前数据集（切换数据集/重启后恢复）
  const setSpec = (patch: Partial<{ lsl: number; usl: number; tgt: number }>) => {
    setSpecRaw(patch);
    const s = useApp.getState();
    rememberSpecFor(M.name, { lsl: s.lsl, tgt: s.tgt, usl: s.usl });
  };
  const M = useData((s) => s.model);
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
    { k: 'Cpm (望目)', v: nf(cap.cpm, 2) },
    { k: 'Z.bench', v: nf(cap.zBench, 2) },
    { k: '西格玛水平', v: nf(cap.sigmaLevel, 2) + 'σ' },
  ];

  // 正态性检验 + 非正态时的 Box-Cox 备选
  const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;
  let boxcox: { lambda: number; ppk: number; adAfter: number } | null = null;
  if (ad && !ad.normal) {
    const bl = bestLambda(M.all);
    if (!('error' in bl)) {
      const tr = transformWithSpec(M.all, lsl, usl, bl.lambda);
      if (!('error' in tr)) {
        const tSd = stdev(tr.data, true);
        const tCap = computeCapability(tr.data, tSd, { lsl: tr.lsl, usl: tr.usl, tgt: (tr.lsl + tr.usl) / 2 });
        boxcox = { lambda: bl.lambda, ppk: tCap.ppk, adAfter: andersonDarling(tr.data).p };
      }
    }
  }
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
          onClick={() => setSpec(suggestedSpec(M))}
          title={M.isDemo ? '恢复默认规格 24.90 / 25.00 / 25.10' : '按 μ±4σ 重新建议规格限'}
          style={{ padding: '5px 12px', border: '1px solid #cfd5dd', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#5b6472', background: '#fff' }}
        >
          复位
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>过程能力直方图 · {M.isDemo ? '直径 (mm)' : M.name}</div>
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
                { k: M.hasSubgroups ? 'σ 组内 (R̄/d₂)' : 'σ 组内 (MR̄/d₂)', v: nf(cap.sigmaWithin, 4) },
                { k: 'σ 整体', v: nf(cap.sigmaOverall, 4) },
                { k: '规格 LSL / 目标 / USL', v: nf(lsl, 2) + ' / ' + nf(tgt, 2) + ' / ' + nf(usl, 2) },
              ]}
            />
          </Card>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>正态概率图</div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>中位秩</div>
          </div>
          <div style={{ padding: '12px 16px 6px' }}>
            <NormalProbPlot T={T} data={M.all} h={300} />
          </div>
        </Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: '#33404f' }}>正态性检验 (Anderson-Darling)</div>
              {ad && (
                <div style={{ marginLeft: 'auto' }}>
                  <Badge bg={ad.normal ? '#e8f4ea' : '#fdecec'} color={ad.normal ? '#2c8a45' : '#c22f2f'}>
                    {ad.normal ? '正态' : '非正态'}
                  </Badge>
                </div>
              )}
            </div>
            {ad ? (
              <>
                <KvRows
                  rows={[
                    { k: 'A²* 统计量', v: nf(ad.a2star, 3) },
                    { k: 'P 值', v: ad.p < 0.005 ? '< 0.005' : nf(ad.p, 3) },
                    { k: '样本量 N', v: String(ad.n) },
                  ]}
                />
                <div style={{ marginTop: 10, fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.55 }}>
                  {ad.normal
                    ? 'P ≥ 0.05，无法拒绝正态假设，Cp/Cpk 等指标可直接使用。'
                    : 'P < 0.05，数据显著偏离正态，建议使用下方 Box-Cox 变换后的能力指标。'}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: '#9aa2ad' }}>样本量不足（N &lt; 8），无法检验。</div>
            )}
          </Card>
          {boxcox && (
            <Card style={{ padding: 16, border: '1px solid #f0e0c8' }}>
              <div style={{ fontWeight: 600, color: '#d98324', marginBottom: 8 }}>非正态能力 · Box-Cox 变换</div>
              <KvRows
                rows={[
                  { k: '最优 λ', v: nf(boxcox.lambda, 1) },
                  { k: '变换后 AD P 值', v: boxcox.adAfter < 0.005 ? '< 0.005' : nf(boxcox.adAfter, 3) },
                  { k: '变换后 Ppk', v: nf(boxcox.ppk, 2) },
                ]}
              />
              <div style={{ marginTop: 10, fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.55 }}>
                数据与规格限经 y = (x^λ − 1)/λ 变换后按整体标准差计算长期能力。
              </div>
            </Card>
          )}
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
