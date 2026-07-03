/** Gage R&R / ANOVA / 帕累托 — 全部指标由 /core 引擎实时计算。
 * 活动数据集含分组列时对真实数据实算,否则回落到演示研究。 */
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  nf, anovaGroups, DEFECTS, gageStudyData, GAGE_TOLERANCE,
  computeGageRR, oneWayAnova, oneSampleT, twoSampleT, type GageObservation, type TTestResult,
} from '../../core';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import type { ChartTokens } from '../tokens';
import { paretoColors } from '../tokens';
import { Card, CardHeader, KvRows, Badge, tabStyle, numInput } from '../common';
import { ParetoChart, GroupedBars, BoxPlot } from '../charts/misc';

const selStyle: CSSProperties = {
  padding: '4px 8px', border: '1px solid #cfd5dd', borderRadius: 4,
  fontSize: 12, color: '#2a333f', background: '#fff', fontFamily: 'IBM Plex Mono,monospace',
};

function SourceBadge({ real }: { real: boolean }) {
  return (
    <Badge bg={real ? '#e7f0f9' : '#f4f6f8'} color={real ? '#1f6fb2' : '#9aa2ad'}>
      {real ? '导入数据' : '演示研究'}
    </Badge>
  );
}

// ---------- Gage R&R ----------
export function GageRR({ T }: { T: ChartTokens }) {
  const name = useData((s) => s.model.name);
  return <GageRRInner key={name} T={T} />;
}

function GageRRInner({ T }: { T: ChartTokens }) {
  const { model, textCols } = useData();
  const { lsl, usl } = useApp();
  // 真实研究需要：≥1 测量列 + ≥2 文本列（部件 / 操作员）
  const canReal = textCols.length >= 2 && model.colNames.length >= 1;
  const [useReal, setUseReal] = useState(canReal);
  const [valCol, setValCol] = useState(0);
  const [partCol, setPartCol] = useState(0);
  const [operCol, setOperCol] = useState(1);

  const real = useMemo(() => {
    if (!canReal || !useReal) return null;
    const parts = textCols[partCol].values;
    const opers = textCols[operCol].values;
    const vals = model.subs.map((s) => s.vals[valCol]);
    const partIds = [...new Set(parts)];
    const operIds = [...new Set(opers)];
    if (partIds.length < 2 || operIds.length < 2) return null;
    const trialCount = new Map<string, number>();
    const obs: GageObservation[] = vals.map((v, i) => {
      const key = parts[i] + '¦' + opers[i];
      const t = trialCount.get(key) ?? 0;
      trialCount.set(key, t + 1);
      return { part: partIds.indexOf(parts[i]), operator: operIds.indexOf(opers[i]), trial: t, value: v };
    });
    // 每个 部件×操作员 至少 2 次重复才能分离重复性
    if (Math.min(...trialCount.values()) < 2) return null;
    try {
      return computeGageRR(obs, Math.abs(usl - lsl));
    } catch {
      return null;
    }
  }, [canReal, useReal, model, textCols, valCol, partCol, operCol, lsl, usl]);

  const g = useMemo(() => real ?? computeGageRR(gageStudyData(), GAGE_TOLERANCE), [real]);
  const isReal = real != null;
  const verdictText = { acceptable: '可接受', marginal: '临界', unacceptable: '不可接受' }[g.verdict];
  const verdictStyle = {
    acceptable: { background: '#e8f4ea', color: '#2c8a45' },
    marginal: { background: '#fcf3e3', color: '#d98324' },
    unacceptable: { background: '#fdecec', color: '#c22f2f' },
  }[g.verdict];
  const bigColor = { acceptable: '#2c8a45', marginal: '#d98324', unacceptable: '#c22f2f' }[g.verdict];
  // 图表取前四个分量（不含合计变异），名称去缩进
  const cats = g.components.slice(0, 4).map((c) => ({
    name: c.source.trim(),
    contrib: c.pctContribution,
    study: c.pctStudyVar,
    tol: c.pctTolerance,
  }));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>变异分量 · 交叉 Gage R&R (ANOVA 法)</div>
          <SourceBadge real={isReal} />
          {canReal && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5b6472' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={useReal} onChange={(e) => setUseReal(e.target.checked)} />
                用导入数据
              </label>
              测量
              <select style={selStyle} value={valCol} onChange={(e) => setValCol(+e.target.value)}>
                {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              部件
              <select style={selStyle} value={partCol} onChange={(e) => setPartCol(+e.target.value)}>
                {textCols.map((c, i) => <option key={c.name} value={i}>{c.name}</option>)}
              </select>
              操作员
              <select style={selStyle} value={operCol} onChange={(e) => setOperCol(+e.target.value)}>
                {textCols.map((c, i) => <option key={c.name} value={i}>{c.name}</option>)}
              </select>
            </div>
          )}
        </div>
        {canReal && useReal && !isReal && (
          <div style={{ margin: '10px 16px 0', padding: '8px 12px', background: '#fcf3e3', border: '1px solid #f0e0c8', borderRadius: 4, fontSize: 12, color: '#d98324' }}>
            所选列不构成有效交叉研究（需 ≥2 部件 × ≥2 操作员，且每组合 ≥2 次重复）— 已回落到演示研究。
          </div>
        )}
        <div style={{ padding: '14px 16px 6px' }}>
          <GroupedBars T={T} cats={cats} />
        </div>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>系统评定</div>
            <div style={{ marginLeft: 'auto', padding: '2px 10px', borderRadius: 11, fontSize: 12, fontWeight: 700, ...verdictStyle }}>{verdictText}</div>
          </div>
          <div className="mono" style={{ fontSize: 34, fontWeight: 700, color: bigColor }}>{nf(g.totalGageRR, 1)}%</div>
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
              {g.components.map((c) => (
                <tr key={c.source} style={{ borderTop: '1px solid #f0f2f5' }}>
                  <td style={{ padding: '7px 16px', color: '#33404f', whiteSpace: 'pre' }}>{c.source}</td>
                  <td className="mono" style={{ padding: '7px 8px', textAlign: 'right', color: '#5b6472' }}>{nf(c.pctContribution, 2)}</td>
                  <td className="mono" style={{ padding: '7px 16px', textAlign: 'right', color: '#2a333f', fontWeight: 600 }}>{nf(c.pctStudyVar, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

// ---------- 假设检验（ANOVA / t 检验） ----------
type HypoTab = 'anova' | 't1' | 't2';

export function Anova({ T }: { T: ChartTokens }) {
  const name = useData((s) => s.model.name);
  const [tab, setTab] = useState<HypoTab>('anova');
  const tabs: Array<[HypoTab, string]> = [['anova', '单因子 ANOVA'], ['t1', '单样本 t'], ['t2', '双样本 t']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>检验方法</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {tabs.map(([k, l]) => (
            <div key={k} style={tabStyle(tab === k)} onClick={() => setTab(k)}>{l}</div>
          ))}
        </div>
      </Card>
      {tab === 'anova' && <AnovaInner key={name} T={T} />}
      {tab === 't1' && <OneSampleTPanel key={name} T={T} />}
      {tab === 't2' && <TwoSampleTPanel key={name} T={T} />}
    </div>
  );
}

/** t 检验结果卡（单/双样本共用） */
function TTestResultCards({ r, estimateLabel, conclusion }: { r: TTestResult; estimateLabel: string; conclusion: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>检验结果</div>
          <div style={{ marginLeft: 'auto' }}>
            <Badge bg={r.significant ? '#fdecec' : '#e8f4ea'} color={r.significant ? '#c22f2f' : '#2c8a45'}>
              {r.significant ? '差异显著' : '无显著差异'}
            </Badge>
          </div>
        </div>
        <KvRows
          rows={[
            { k: estimateLabel, v: nf(r.estimate, 4) },
            { k: 't 统计量', v: nf(r.t, 3) },
            { k: '自由度 df', v: nf(r.df, 1) },
            { k: 'P 值（双侧）', v: r.p < 0.001 ? '< 0.001' : nf(r.p, 3) },
            { k: '95% 置信区间', v: `[${nf(r.ciLow, 4)}, ${nf(r.ciHigh, 4)}]` },
            { k: '标准误 SE', v: nf(r.se, 5) },
          ]}
        />
      </Card>
      <Card style={{ padding: '15px 16px' }}>
        <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 6 }}>结论</div>
        <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.6 }}>{conclusion}</div>
      </Card>
    </div>
  );
}

function OneSampleTPanel({ T }: { T: ChartTokens }) {
  const { model } = useData();
  const { tgt } = useApp();
  const [col, setCol] = useState(0);
  const [mu0, setMu0] = useState(tgt);
  const xs = model.subs.map((s) => s.vals[col]);
  const r = oneSampleT(xs, mu0);
  const conclusion = r.significant
    ? `P ${r.p < 0.001 ? '< 0.001' : '= ' + nf(r.p, 3)} < 0.05，「${model.colNames[col]}」的均值 ${nf(r.estimate, 4)} 与目标 ${nf(mu0, 4)} 存在显著差异,过程中心可能偏移,建议调整。`
    : `P = ${nf(r.p, 3)} ≥ 0.05，无充分证据表明「${model.colNames[col]}」的均值偏离目标 ${nf(mu0, 4)},过程中心可视为对准目标。`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>单样本 t 检验 · 均值 vs 目标 μ₀</div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5b6472' }}>
            测量列
            <select style={selStyle} value={col} onChange={(e) => setCol(+e.target.value)}>
              {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              μ₀
              <input
                type="number" step="0.01" value={mu0} style={numInput}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setMu0(v); }}
              />
            </label>
          </div>
        </div>
        <div style={{ padding: '14px 16px 6px' }}>
          <BoxPlot T={T} groups={[{ name: model.colNames[col], vals: xs }]} />
        </div>
        <div style={{ padding: '0 16px 12px', fontSize: 11.5, color: '#9aa2ad' }}>
          红点为样本均值 {nf(r.estimate, 4)} · N = {xs.length} · H₀: μ = {nf(mu0, 4)}
        </div>
      </Card>
      <TTestResultCards r={r} estimateLabel="样本均值" conclusion={conclusion} />
    </div>
  );
}

function TwoSampleTPanel({ T }: { T: ChartTokens }) {
  const { model } = useData();
  const multi = model.colNames.length >= 2;
  // 单列数据集时退回演示两组（设备 A vs B）
  const demo = useMemo(() => anovaGroups(), []);
  const [colA, setColA] = useState(0);
  const [colB, setColB] = useState(multi ? 1 : 0);
  const groups = multi
    ? [
        { name: model.colNames[colA], vals: model.subs.map((s) => s.vals[colA]) },
        { name: model.colNames[colB], vals: model.subs.map((s) => s.vals[colB]) },
      ]
    : [demo[0], demo[1]];
  const r = twoSampleT(groups[0].vals, groups[1].vals);
  const conclusion = r.significant
    ? `P ${r.p < 0.001 ? '< 0.001' : '= ' + nf(r.p, 3)} < 0.05，「${groups[0].name}」与「${groups[1].name}」均值差 ${nf(r.estimate, 4)} 显著（Welch 校正）,两组不可视为同一总体。`
    : `P = ${nf(r.p, 3)} ≥ 0.05，「${groups[0].name}」与「${groups[1].name}」均值无显著差异（Welch 校正）。`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>双样本 t 检验（Welch,不等方差）</div>
          {multi ? (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5b6472' }}>
              样本 1
              <select style={selStyle} value={colA} onChange={(e) => setColA(+e.target.value)}>
                {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              样本 2
              <select style={selStyle} value={colB} onChange={(e) => setColB(+e.target.value)}>
                {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
            </div>
          ) : (
            <div style={{ marginLeft: 'auto' }}><SourceBadge real={false} /></div>
          )}
        </div>
        <div style={{ padding: '14px 16px 6px' }}>
          <BoxPlot T={T} groups={groups} />
        </div>
      </Card>
      <TTestResultCards r={r} estimateLabel="均值差 (1−2)" conclusion={conclusion} />
    </div>
  );
}

function AnovaInner({ T }: { T: ChartTokens }) {
  const { model, textCols } = useData();
  const canReal = textCols.length >= 1 && model.colNames.length >= 1;
  const [useReal, setUseReal] = useState(canReal);
  const [respCol, setRespCol] = useState(0);
  const [grpCol, setGrpCol] = useState(0);

  const realGroups = useMemo(() => {
    if (!canReal || !useReal) return null;
    const labels = textCols[grpCol].values;
    const vals = model.subs.map((s) => s.vals[respCol]);
    const byLabel = new Map<string, number[]>();
    labels.forEach((l, i) => {
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l)!.push(vals[i]);
    });
    const groups = [...byLabel.entries()].map(([name, vals]) => ({ name, vals }));
    // 每组 ≥2 观测、≥2 组
    if (groups.length < 2 || groups.some((g) => g.vals.length < 2)) return null;
    return groups;
  }, [canReal, useReal, model, textCols, respCol, grpCol]);

  const isReal = realGroups != null;
  const groups = useMemo(() => realGroups ?? anovaGroups(), [realGroups]);
  const a = useMemo(() => oneWayAnova(groups.map((g) => g.vals)), [groups]);
  const means = groups.map((g) => g.vals.reduce((x, y) => x + y, 0) / g.vals.length);
  const hi = groups[means.indexOf(Math.max(...means))].name;
  const factorName = isReal ? textCols[grpCol].name : '设备';
  const rows = [
    { src: factorName, df: String(a.factorDf), ss: nf(a.factorSS, 5), f: nf(a.fStat, 2), p: nf(a.pValue, 3), pColor: a.significant ? '#c22f2f' : '#5b6472' },
    { src: '误差', df: String(a.errorDf), ss: nf(a.errorSS, 5), f: '', p: '', pColor: '#5b6472' },
    { src: '合计', df: String(a.totalDf), ss: nf(a.totalSS, 5), f: '', p: '', pColor: '#5b6472' },
  ];
  const conclusion = a.significant
    ? `P = ${nf(a.pValue, 3)} < 0.05，在 95% 置信水平下拒绝原假设：各「${factorName}」组均值存在显著差异。「${hi}」组均值最高，建议优先排查。`
    : `P = ${nf(a.pValue, 3)} ≥ 0.05，无充分证据表明各「${factorName}」组均值存在显著差异，可视为同一总体。`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>
            单因子方差分析 · {isReal ? `${model.colNames[respCol]} vs ${factorName}` : '直径 vs 设备'}
          </div>
          <SourceBadge real={isReal} />
          {canReal && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5b6472' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={useReal} onChange={(e) => setUseReal(e.target.checked)} />
                用导入数据
              </label>
              响应
              <select style={selStyle} value={respCol} onChange={(e) => setRespCol(+e.target.value)}>
                {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              分组
              <select style={selStyle} value={grpCol} onChange={(e) => setGrpCol(+e.target.value)}>
                {textCols.map((c, i) => <option key={c.name} value={i}>{c.name}</option>)}
              </select>
            </div>
          )}
        </div>
        {canReal && useReal && !isReal && (
          <div style={{ margin: '10px 16px 0', padding: '8px 12px', background: '#fcf3e3', border: '1px solid #f0e0c8', borderRadius: 4, fontSize: 12, color: '#d98324' }}>
            所选分组列不满足要求（需 ≥2 组且每组 ≥2 观测）— 已回落到演示研究。
          </div>
        )}
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
              {rows.map((r) => (
                <tr key={r.src} style={{ borderTop: '1px solid #f0f2f5', textAlign: 'right' }}>
                  <td style={{ padding: '7px 8px 7px 16px', textAlign: 'left', color: '#33404f', fontFamily: 'IBM Plex Sans' }}>{r.src}</td>
                  <td style={{ padding: '7px 6px', color: '#5b6472' }}>{r.df}</td>
                  <td style={{ padding: '7px 6px', color: '#5b6472' }}>{r.ss}</td>
                  <td style={{ padding: '7px 6px', color: '#5b6472' }}>{r.f}</td>
                  <td style={{ padding: '7px 16px', color: r.pColor, fontWeight: 600 }}>{r.p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card style={{ padding: '15px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 6 }}>结论</div>
          <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.6 }}>{conclusion}</div>
        </Card>
      </div>
    </div>
  );
}

// ---------- 帕累托 ----------
export function Pareto({ T }: { T: ChartTokens }) {
  const colors = paretoColors(T);
  const total = DEFECTS.reduce((a, d) => a + d.count, 0);
  const cums = DEFECTS.reduce<number[]>((acc, d) => [...acc, (acc[acc.length - 1] ?? 0) + d.count], []);
  const rows = DEFECTS.map((d, i) => ({
    ...d,
    cum: Math.round((cums[i] / total) * 100) + '%',
    color: colors[i % colors.length],
  }));
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
