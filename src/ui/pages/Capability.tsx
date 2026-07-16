/** 过程能力分析 ★深度实现 — 可编辑规格限实时重算 + 直方图 + PPM 性能表。 */
import { useApp } from '../../store/appStore';
import { useData, suggestedSpec, rememberSpecForActiveMeasurement, resolveActiveMeasurementData } from '../../store/dataStore';
import { nf, fmtCap, capabilityInputError, computeCapability, andersonDarling, bestLambda, transformWithSpec, stdev, evalLimitedRules, evalRules } from '../../core';
import { ReportCard } from '../ReportCard';
import { capabilityReport } from '../reportData';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, numInput, Badge } from '../common';
import { Histogram } from '../charts/Histogram';
import { NormalProbPlot } from '../charts/NormalProbPlot';

export function Capability({ T }: { T: ChartTokens }) {
  const { lsl, usl, tgt, lslOn, uslOn, toggleSide, setSpec: setSpecRaw, spcRules, goTo, capabilityBins: bins, setCapabilityBins: setBins } = useApp();
  const rawModel = useData((s) => s.model);
  const textCols = useData((s) => s.textCols);
  const prepared = resolveActiveMeasurementData(rawModel, textCols);
  const M = prepared.model;
  // 规格同步只在“导入/切换数据集”和“SPC 明确数据角色”两个入口发生。
  // 能力页不能再按数据集记忆自动覆盖规格，否则历史恢复（包括页面已挂载时）
  // 会把快照中的 LSL/Target/USL 改成今天的规格，导致同一记录回看出不同 Cpk。
  if (!M) {
    return (
      <Card style={{ padding: 24, borderColor: '#f0caca', color: '#a62b2b', lineHeight: 1.7 }}>
        <b>过程能力分析未运行：</b>{prepared.error ?? '无法确定当前测量数据角色。'}<br />
        能力页与控制图共用同一数据口径，不会把子组 ID 或其他数值字段静默混入计算。
        <button
          type="button"
          onClick={() => goTo('spc')}
          style={{ display: 'block', marginTop: 12, padding: '6px 12px', border: '1px solid #bcd6ee', borderRadius: 4, background: '#fff', color: '#1f6fb2', cursor: 'pointer', fontWeight: 600 }}
        >
          前往控制图配置数据角色
        </button>
      </Card>
    );
  }
  // 写规格限时同步记忆到当前数据集（切换数据集/重启后恢复）
  const setSpec = (patch: Partial<{ lsl: number; usl: number; tgt: number }>) => {
    setSpecRaw(patch);
    const s = useApp.getState();
    rememberSpecForActiveMeasurement(rawModel, textCols, {
      lsl: s.lsl, tgt: s.tgt, usl: s.usl, lslOn: s.lslOn, uslOn: s.uslOn,
    });
  };
  const toggleSpecSide = (side: 'lslOn' | 'uslOn') => {
    toggleSide(side);
    const s = useApp.getState();
    rememberSpecForActiveMeasurement(rawModel, textCols, {
      lsl: s.lsl, tgt: s.tgt, usl: s.usl, lslOn: s.lslOn, uslOn: s.uslOn,
    });
  };
  // 单侧规格：关闭的一侧传 null
  const effLsl = lslOn ? lsl : null;
  const effUsl = uslOn ? usl : null;
  const inputs: Array<{ label: string; value: number; key: 'lsl' | 'tgt' | 'usl'; on: boolean; side?: 'lslOn' | 'uslOn' }> = [
    { label: 'LSL 下限', value: lsl, key: 'lsl', on: lslOn, side: 'lslOn' },
    { label: '目标 Target', value: tgt, key: 'tgt', on: true },
    { label: 'USL 上限', value: usl, key: 'usl', on: uslOn, side: 'uslOn' },
  ];
  const specEditor = (
    <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>规格限 (可编辑，实时重算)</span>
      {inputs.map((i) => (
        <label key={i.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: i.on ? '#5b6472' : '#b6bdc6' }}>
          {i.side && (
            <input
              type="checkbox"
              checked={i.on}
              title={i.on ? '取消勾选 → 单侧规格（忽略此限）' : '启用此侧规格限'}
              onChange={() => toggleSpecSide(i.side!)}
            />
          )}
          {i.label}
          <input
            type="number"
            step="0.01"
            value={i.value}
            disabled={!i.on}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) setSpec({ [i.key]: v });
            }}
            style={{ ...numInput, ...(i.on ? {} : { background: '#f4f6f8', color: '#b6bdc6' }) }}
          />
        </label>
      ))}
      {!(lslOn && uslOn) && (
        <span style={{ fontSize: 11.5, color: '#d98324', fontWeight: 600 }}>
          单侧规格：Cpk = {lslOn ? 'CPL' : 'CPU'},双侧指标（Cp/Pp/Cpm）不适用
        </span>
      )}
      <button type="button"
        onClick={() => setSpec(suggestedSpec(M))}
        title={M.isDemo ? '恢复默认规格 24.90 / 25.00 / 25.10' : `按当前测量口径（${prepared.variableName}）的 μ±4σ 重新建议规格限`}
        style={{ padding: '5px 12px', border: '1px solid #cfd5dd', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: '#5b6472', background: '#fff' }}
      >
        复位
      </button>
    </Card>
  );
  const inputError = capabilityInputError(M.all, M.sigmaWithin, { lsl: effLsl, tgt, usl: effUsl });
  if (inputError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: '10px 16px', color: '#5b6472', fontSize: 12.5, lineHeight: 1.6 }}>
          <b style={{ color: '#33404f' }}>能力数据口径：</b>{prepared.note}；变量：{prepared.variableName}；实际观测 N={M.all.length}。
        </Card>
        {specEditor}
        <Card style={{ padding: '18px 20px', color: '#a62b2b', background: '#fff5f5', borderColor: '#f0caca', lineHeight: 1.7 }}>
          <b>过程能力分析未运行：</b>{inputError}。请修正规格限或补充有变异的实测数据；系统不会输出负能力指数、无穷 Cpk 或超过 100% 的预测缺陷率。
        </Card>
      </div>
    );
  }
  const cap = computeCapability(M.all, M.sigmaWithin, { lsl: effLsl, tgt, usl: effUsl });
  const good = cap.verdict === 'sufficient';
  const marginal = cap.verdict === 'marginal';

  const verdictStyle = good
    ? { background: '#e8f4ea', color: '#2c8a45' }
    : marginal
      ? { background: '#fcf3e3', color: '#d98324' }
      : { background: '#fdecec', color: '#c22f2f' };

  const big = [
    { k: 'Cp', v: fmtCap(cap.cp), color: '#1f6fb2' },
    { k: 'Cpk', v: nf(cap.cpk, 2), color: good ? '#2c8a45' : marginal ? '#d98324' : '#c22f2f' },
    { k: 'Pp', v: fmtCap(cap.pp), color: '#1f6fb2' },
    { k: 'Ppk', v: nf(cap.ppk, 2), color: '#5b6472' },
  ];
  const big2 = [
    { k: 'CPU', v: fmtCap(cap.cpu) },
    { k: 'CPL', v: fmtCap(cap.cpl) },
    { k: 'Cpm (望目)', v: fmtCap(cap.cpm) },
    { k: 'Z.bench', v: nf(cap.zBench, 2) },
    { k: '西格玛水平', v: nf(cap.sigmaLevel, 2) + 'σ' },
  ];

  // 正态性检验 + 非正态时的 Box-Cox 备选（需双侧规格）
  const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;
  let boxcox: { lambda: number; ppk: number; adAfter: number } | null = null;
  if (ad && !ad.normal && lslOn && uslOn) {
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
    { k: '组内 (潜在)', lsl: cap.ppm.within.belowLsl == null ? '—' : Math.round(cap.ppm.within.belowLsl).toLocaleString(), usl: cap.ppm.within.aboveUsl == null ? '—' : Math.round(cap.ppm.within.aboveUsl).toLocaleString(), ppm: Math.round(cap.ppm.within.total).toLocaleString() },
    { k: '整体 (实际)', lsl: cap.ppm.overall.belowLsl == null ? '—' : Math.round(cap.ppm.overall.belowLsl).toLocaleString(), usl: cap.ppm.overall.aboveUsl == null ? '—' : Math.round(cap.ppm.overall.aboveUsl).toLocaleString(), ppm: Math.round(cap.ppm.overall.total).toLocaleString() },
  ];

  // 能力结论必须先同时检查位置图与离散图；R/MR 失控时不能宣称过程稳定。
  const locationEval = M.hasSubgroups
    ? evalRules(M.subs.map((s) => s.mean), M.xbarbar, (M.uclX - M.xbarbar) / 3, spcRules)
    : evalRules(M.indiv, M.indMean, M.iSig, spcRules);
  const dispersionEval = M.hasSubgroups
    ? evalLimitedRules(M.subs.map((s) => s.range), M.rbar, M.uclR, M.lclR, spcRules)
    : evalLimitedRules(M.mr.slice(1) as number[], M.mrbar, M.mrUcl, 0, spcRules);
  const spcViol = locationEval.viol.size + dispersionEval.viol.size;
  const report = capabilityReport({
    cpk: cap.cpk, verdict: cap.verdict,
    adP: ad ? ad.p : null, n: M.all.length, spcViolations: spcViol,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ReportCard data={report} />
      <Card style={{ padding: '10px 16px', color: '#5b6472', fontSize: 12.5, lineHeight: 1.6 }}>
        <b style={{ color: '#33404f' }}>能力数据口径：</b>{prepared.note}；变量：{prepared.variableName}；实际观测 N={M.all.length}。
      </Card>
      {specEditor}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>过程能力直方图 · {M.isDemo ? '直径 (mm)' : prepared.variableName}</div>
            <label className="mono" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#8a929d' }}>
              组数 {bins}
              <input
                type="range" min={5} max={40} value={bins}
                onChange={(e) => setBins(+e.target.value)}
                style={{ width: 110, accentColor: '#1f6fb2' }}
              />
            </label>
          </div>
          <div style={{ padding: '12px 16px 6px' }}>
            <Histogram T={T} data={M.all} mu={M.oMean} sigmaWithin={M.sigmaWithin} sigmaOverall={M.oSd} lsl={effLsl} usl={effUsl} tgt={tgt} h={320} bins={bins} />
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
                { k: '规格 LSL / 目标 / USL', v: (lslOn ? nf(lsl, 2) : '—') + ' / ' + nf(tgt, 2) + ' / ' + (uslOn ? nf(usl, 2) : '—') },
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
