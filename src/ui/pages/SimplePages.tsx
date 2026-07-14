/** Gage R&R / ANOVA / 帕累托 — 全部指标由 /core 引擎实时计算。
 * 活动数据集含分组列时对真实数据实算,否则回落到演示研究。 */
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ReportCard } from '../ReportCard';
import { gageReport, anovaReport, tReport, regReport } from '../reportData';
import {
  nf, anovaGroups, DEFECTS, gageStudyData, GAGE_TOLERANCE,
  computeGageRR, oneWayAnova, anovaResiduals, buildAnovaGroups, wideScaleDisparate, oneSampleT, twoSampleT, linearRegression,
  type GageObservation, type TTestResult, type AnovaMode,
} from '../../core';
import { ScatterPlot } from '../charts/ScatterPlot';
import { NormalProbPlot } from '../charts/NormalProbPlot';
import { Fishbone } from './Fishbone';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import type { ChartTokens } from '../tokens';
import { paretoColors } from '../tokens';
import { Card, CardHeader, KvRows, Badge, tabStyle, numInput, EmptyStateCard, DemoBadge } from '../common';
import { ParetoChart, GroupedBars, BoxPlot, IntervalPlot, MiniHist } from '../charts/misc';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ReportCard data={gageReport({ grr: g.totalGageRR, verdict: g.verdict })} />
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
    </div>
  );
}

// ---------- 假设检验（ANOVA / t 检验 / 回归） ----------

export function Anova({ T }: { T: ChartTokens }) {
  const name = useData((s) => s.model.name);
  const { hypoTab: tab, setHypoTab: setTab } = useApp();
  const tabs: Array<[typeof tab, string]> = [['anova', '单因子 ANOVA'], ['t1', '单样本 t'], ['t2', '双样本 t'], ['reg', '相关与回归']];
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
      {tab === 'reg' && <RegressionPanel key={name} T={T} />}
    </div>
  );
}

function RegressionPanel({ T }: { T: ChartTokens }) {
  const { model } = useData();
  const multi = model.colNames.length >= 2;
  const [colX, setColX] = useState(0);
  const [colY, setColY] = useState(multi ? 1 : 0);
  if (!multi) {
    return (
      <Card style={{ padding: 20 }}>
        <div style={{ fontSize: 12.5, color: '#8a929d' }}>
          当前数据集只有 1 个测量列。相关与回归需要 2 个及以上数值列（X 与 Y）——请导入多列数据或恢复演示数据集。
        </div>
      </Card>
    );
  }
  const xs = model.subs.map((s) => s.vals[colX]);
  const ys = model.subs.map((s) => s.vals[colY]);
  let reg: ReturnType<typeof linearRegression> | null = null;
  let err = '';
  try {
    reg = colX === colY ? null : linearRegression(xs, ys);
    if (colX === colY) err = 'X 与 Y 不能是同一列';
  } catch (e) {
    err = (e as Error).message;
  }
  const sign = reg && reg.intercept >= 0 ? '+' : '−';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {reg && <ReportCard data={regReport({ r2: reg.r2, p: reg.p, significant: reg.significant, n: reg.n })} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>散点图与最小二乘回归</div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5b6472' }}>
            X
            <select style={selStyle} value={colX} onChange={(e) => setColX(+e.target.value)}>
              {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
            </select>
            Y
            <select style={selStyle} value={colY} onChange={(e) => setColY(+e.target.value)}>
              {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
            </select>
          </div>
        </div>
        {reg ? (
          <>
            <div style={{ padding: '14px 16px 6px' }}>
              <ScatterPlot T={T} xs={xs} ys={ys} slope={reg.slope} intercept={reg.intercept} xLabel={model.colNames[colX]} yLabel={model.colNames[colY]} />
            </div>
            <div className="mono" style={{ padding: '0 16px 14px', fontSize: 12.5, color: '#1f6fb2', fontWeight: 600 }}>
              {model.colNames[colY]} = {nf(reg.intercept, 4)} {sign} {nf(Math.abs(reg.slope), 4)} × {model.colNames[colX]}
            </div>
          </>
        ) : (
          <div style={{ padding: 20, fontSize: 12.5, color: '#d98324' }}>{err}</div>
        )}
      </Card>
      {reg && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontWeight: 600, color: '#33404f' }}>回归统计</div>
              <div style={{ marginLeft: 'auto' }}>
                <Badge bg={reg.significant ? '#e7f0f9' : '#f4f6f8'} color={reg.significant ? '#1f6fb2' : '#9aa2ad'}>
                  {reg.significant ? '斜率显著' : '斜率不显著'}
                </Badge>
              </div>
            </div>
            <KvRows
              rows={[
                { k: '相关系数 r', v: nf(reg.r, 3) },
                { k: '决定系数 R²', v: nf(reg.r2, 3) },
                { k: '斜率 b', v: nf(reg.slope, 4) },
                { k: '截距 a', v: nf(reg.intercept, 4) },
                { k: '斜率 t / df', v: `${nf(reg.t, 2)} / ${reg.df}` },
                { k: 'P 值', v: reg.p < 0.001 ? '< 0.001' : nf(reg.p, 3) },
                { k: '观测数 N', v: String(reg.n) },
              ]}
            />
          </Card>
          <Card style={{ padding: '15px 16px' }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 6 }}>结论</div>
            <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.6 }}>
              {reg.significant
                ? `P ${reg.p < 0.001 ? '< 0.001' : '= ' + nf(reg.p, 3)} < 0.05,「${model.colNames[colX]}」对「${model.colNames[colY]}」存在显著线性关系,R² = ${nf(reg.r2, 3)} 表示约 ${Math.round(reg.r2 * 100)}% 的变异可由回归解释。`
                : `P = ${nf(reg.p, 3)} ≥ 0.05,无充分证据表明「${model.colNames[colX]}」与「${model.colNames[colY]}」存在线性关系（同一过程的重复测量列间通常独立,属预期结果）。`}
            </div>
          </Card>
        </div>
      )}
    </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ReportCard data={tReport({ kind: 't1', p: r.p, significant: r.significant, n: xs.length })} />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ReportCard data={tReport({ kind: 't2', p: r.p, significant: r.significant, n: Math.min(groups[0].vals.length, groups[1].vals.length) })} />
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
    </div>
  );
}

function AnovaInner({ T }: { T: ChartTokens }) {
  const { model, textCols, stackColumns } = useData();
  const { openModal, showToast, anovaMode, anovaRespName, anovaFactorName, setAnovaSel } = useApp();
  const canStacked = textCols.length >= 1 && model.colNames.length >= 1;
  const canWide = model.colNames.length >= 2 && model.k >= 2;
  const canNumFactor = model.colNames.length >= 2; // 一列作因子 + 一列作响应
  const [showDemo, setShowDemo] = useState(false);
  const [chartKind, setChartKind] = useState<'box' | 'interval'>('box');

  // 出厂演示集(直径1..5 是同一量的子组位置,不是「分组」)不作为真实宽表数据,直接走演示研究
  const isDemoDataset = model.isDemo;
  const dataRows = useMemo(() => model.subs.map((s) => s.vals), [model]);

  // 有效模式:store 里的模式若当前数据集不支持则回落;都不可用为 null(空态)
  const modeOk = (m: AnovaMode) => (m === 'stacked' ? canStacked : m === 'wide' ? canWide : canNumFactor);
  const effMode: AnovaMode | null = isDemoDataset ? null
    : modeOk(anovaMode) ? anovaMode
    : canStacked ? 'stacked' : canWide ? 'wide' : canNumFactor ? 'numfactor' : null;

  // 页面与项目汇总共用 buildAnovaGroups,保证界面/卡片一致
  const builtGroups = useMemo(
    () => (effMode === null ? null : buildAnovaGroups(effMode, model.colNames, dataRows, textCols, anovaRespName, anovaFactorName)),
    [effMode, model.colNames, dataRows, textCols, anovaRespName, anovaFactorName],
  );
  const demoGroups = useMemo(() => anovaGroups(), []);

  // 空态:非演示集、无任何可分析形态、未显式要求示例
  if (effMode === null && !showDemo && !isDemoDataset) {
    return (
      <EmptyStateCard
        title="单因子方差分析需要可比较的分组数据"
        need="三种形态之一:① 1 个文本分组列 + 1 个数值响应列(长表);② 用一个数值列作因子(按取值分组)+ 1 个数值响应列;③ ≥2 个同量纲数值列(宽表,各列一组)。各组需 ≥2 观测。"
        current={`${model.colNames.length} 个数值列 · ${textCols.length} 个分组列 · ${model.k} 行`}
        actions={[{ label: '导入数据', primary: true, onClick: () => openModal('import') }]}
        onDemo={() => setShowDemo(true)}
      />
    );
  }

  const isDemo = effMode === null; // 含出厂演示集与「查看示例」
  const groups = isDemo ? demoGroups : builtGroups;

  // 选择器解析索引(与 buildAnovaGroups 默认口径一致)
  const idxOf = (name: string | null, fb: number) => { const i = name ? model.colNames.indexOf(name) : -1; return i >= 0 ? i : fb; };
  const factorNumIdx = idxOf(anovaFactorName, 0);
  const respIdx = idxOf(anovaRespName, effMode === 'numfactor' && factorNumIdx === 0 ? 1 : 0);
  const grpTextIdx = Math.max(0, textCols.findIndex((t) => t.name === anovaFactorName));

  const factorName = isDemo ? '设备'
    : effMode === 'stacked' ? (textCols[grpTextIdx]?.name ?? '分组')
    : effMode === 'numfactor' ? model.colNames[factorNumIdx]
    : '测量列';
  const respLabel = (effMode === 'stacked' || effMode === 'numfactor') ? model.colNames[respIdx] : '';

  // 工具条:提为普通 JSX 变量(不作为组件类型),避免每次渲染重建导致 <select> 焦点丢失
  const tab = (m: AnovaMode, label: string, can: boolean, tip: string) => (
    <div style={{ ...tabStyle(effMode === m), ...(can ? {} : { opacity: 0.45, cursor: 'not-allowed' }) }}
      title={tip} onClick={() => can && setAnovaSel({ anovaMode: m })}>{label}</div>
  );
  const modeBar = (
    <Card style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
      {isDemo ? (
        <span style={{ color: '#8a929d' }}>{isDemoDataset ? '当前为出厂演示数据集,导入你自己的数据后即可分析' : '示例研究(设备 A/B/C × 直径)'}</span>
      ) : (
        <>
          <span style={{ color: '#8a929d', fontWeight: 600 }}>数据形态</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {tab('stacked', '分组列(长表)', canStacked, canStacked ? '文本分组列 + 数值响应列' : '当前数据集没有文本分组列')}
            {tab('numfactor', '数值因子', canNumFactor, canNumFactor ? '一个数值列作因子(按取值分组)+ 一个数值响应列' : '需要 ≥2 个数值列')}
            {tab('wide', '宽表(各列一组)', canWide, canWide ? '每个数值列作为一组(Minitab unstacked)' : '需要 ≥2 个数值列')}
          </div>
        </>
      )}
      {effMode === 'stacked' && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, color: '#5b6472' }}>
          响应
          <select style={selStyle} value={respIdx} onChange={(e) => setAnovaSel({ anovaRespName: model.colNames[+e.target.value] })}>
            {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
          分组
          <select style={selStyle} value={grpTextIdx} onChange={(e) => setAnovaSel({ anovaFactorName: textCols[+e.target.value].name })}>
            {textCols.map((c, i) => <option key={c.name} value={i}>{c.name}</option>)}
          </select>
        </div>
      )}
      {effMode === 'numfactor' && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, color: '#5b6472' }}>
          因子
          <select style={selStyle} value={factorNumIdx} onChange={(e) => setAnovaSel({ anovaFactorName: model.colNames[+e.target.value] })}>
            {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
          响应
          <select style={selStyle} value={respIdx} onChange={(e) => setAnovaSel({ anovaRespName: model.colNames[+e.target.value] })}>
            {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </div>
      )}
      {isDemo && <div style={{ marginLeft: 'auto' }}><DemoBadge /></div>}
    </Card>
  );

  // 模式已选但当前列选不成有效分组
  if (!groups) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {modeBar}
        <Card style={{ padding: '18px 20px', fontSize: 12.5, color: '#d98324', background: '#fffdf7' }}>
          {effMode === 'numfactor'
            ? '所选因子列无法构成有效分组:需要 ≥2 个不同取值、且每个取值 ≥2 个观测。请选一个「水平较少」的列作因子(如 2–3 水平的设定值),或换用其他模式。'
            : `所选分组列不满足要求:需要 ≥2 个组且每组 ≥2 个观测。请换一个分组/响应列${canWide ? ',或切换到「宽表(各列一组)」模式' : ''}。`}
        </Card>
      </div>
    );
  }

  // 宽表各列量纲悬殊(均值相差 >100 倍):不是同一响应量,把它们当组比较没有统计意义。
  // 不再"警告 + 照出 P",直接拦到变量角色选择,引导改用「数值因子」模式或换同量纲数据。
  if (!isDemo && effMode === 'wide' && wideScaleDisparate(groups)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {modeBar}
        <Card style={{ padding: '18px 20px', fontSize: 13, color: '#b03030', background: '#fdecec', lineHeight: 1.7 }}>
          <b>各列量纲悬殊,不能当组比较:</b>所选各数值列均值相差 100 倍以上(如 过盈量≈0.07 / 轴硬度≈30 / 压入力≈900),
          多半不是"同一响应量在不同条件下的观测",把它们当三组做单因子 ANOVA 没有统计意义,故此处不出 F/P。
          <div style={{ fontSize: 12, color: '#8a929d', marginTop: 8 }}>
            正确做法:这类"因子 + 响应"数据请切到上方<b>「数值因子」</b>模式(选一列作因子、另一列作响应),或改用 DOE / 回归分析;
            若各列确为同一量纲的不同条件,请改用同量纲数据。
          </div>
        </Card>
      </div>
    );
  }

  let a; let resid;
  try {
    a = oneWayAnova(groups.map((g) => g.vals));
    resid = anovaResiduals(groups.map((g) => g.vals));
  } catch (e) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {modeBar}
        <Card style={{ padding: '18px 20px', fontSize: 12.5, color: '#c22f2f' }}>无法计算:{(e as Error).message}</Card>
      </div>
    );
  }
  const means = groups.map((g) => g.vals.reduce((x, y) => x + y, 0) / g.vals.length);
  const hi = groups[means.indexOf(Math.max(...means))].name;
  const rows = [
    { src: factorName, df: String(a.factorDf), ss: nf(a.factorSS, 5), f: nf(a.fStat, 2), p: nf(a.pValue, 3), pColor: a.significant ? '#c22f2f' : '#5b6472' },
    { src: '误差', df: String(a.errorDf), ss: nf(a.errorSS, 5), f: '', p: '', pColor: '#5b6472' },
    { src: '合计', df: String(a.totalDf), ss: nf(a.totalSS, 5), f: '', p: '', pColor: '#5b6472' },
  ];
  const conclusion = a.significant
    ? `P = ${nf(a.pValue, 3)} < 0.05，在 95% 置信水平下拒绝原假设：各「${factorName}」组均值存在显著差异。「${hi}」组均值最高，建议优先排查。`
    : `P = ${nf(a.pValue, 3)} ≥ 0.05，无充分证据表明各「${factorName}」组均值存在显著差异，可视为同一总体。`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ReportCard data={anovaReport({ p: a.pValue, significant: a.significant, groups: groups.map((g) => ({ name: g.name, n: g.vals.length })), wideCaution: effMode === 'wide' })} />
      {modeBar}
      {effMode === 'wide' && (
        // 量纲悬殊的宽表已在上游拦截;此处仅对"同量纲宽表"给温和提示(可选堆叠为长表)。
        <div style={{ padding: '9px 14px', background: '#fcf3e3', border: '1px solid #f0e0c8', borderRadius: 5, fontSize: 12, color: '#8a6520', lineHeight: 1.6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 420px' }}>
            宽表模式把每个数值列当作一组。仅当各列是<b>同一响应量(同量纲)</b>在不同条件下的观测时,比较均值才有统计意义;
            若各列是不同物理量,请改用「数值因子」模式或因子实验思路。
          </span>
          <div className="hov-act" onClick={() => { try { stackColumns(); setAnovaSel({ anovaMode: 'stacked' }); showToast('已堆叠为「测量值+来源列」长表并切换到分组列模式'); } catch (e) { showToast('堆叠失败:' + (e as Error).message); } }}
            style={{ padding: '5px 12px', border: '1px solid #d9b96a', borderRadius: 4, cursor: 'pointer', color: '#8a6520', background: '#fff', fontWeight: 600, flex: 'none' }}>
            一键堆叠为长表
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>
            单因子方差分析 · {isDemo ? '直径 vs 设备' : effMode === 'wide' ? `各测量列比较(${groups.length} 组)` : `${respLabel} vs ${factorName}`}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <div style={tabStyle(chartKind === 'box')} onClick={() => setChartKind('box')}>箱线图</div>
            <div style={tabStyle(chartKind === 'interval')} onClick={() => setChartKind('interval')}>区间图</div>
          </div>
        </div>
        <div style={{ padding: '14px 16px 6px' }}>
          {chartKind === 'box' ? <BoxPlot T={T} groups={groups} /> : <IntervalPlot T={T} groups={groups} />}
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
      <Card>
        <CardHeader title="残差诊断(四合一)" right={<span style={{ fontSize: 11.5, color: '#98a1ac' }}>残差 = 观测 − 组均值 · 用于检查模型假设</span>} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 12px 12px' }}>
          <NormalProbPlot T={T} data={resid.residuals} h={230} />
          <ScatterPlot T={T} xs={resid.fits} ys={resid.residuals} slope={0} intercept={0} xLabel="拟合值(组均值)" yLabel="残差" h={230} />
          <MiniHist T={T} data={resid.residuals} h={230} xLabel="残差分布" />
          <ScatterPlot T={T} xs={resid.residuals.map((_, i) => i + 1)} ys={resid.residuals} slope={0} intercept={0} xLabel="观测序(按组)" yLabel="残差" h={230} />
        </div>
      </Card>
    </div>
  );
}

// ---------- 帕累托 ----------
export function Pareto({ T }: { T: ChartTokens }) {
  const { paretoView, setParetoView } = useApp();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>分析视图</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={tabStyle(paretoView === 'pareto')} onClick={() => setParetoView('pareto')}>帕累托图</div>
          <div style={tabStyle(paretoView === 'fishbone')} onClick={() => setParetoView('fishbone')}>鱼骨图（因果分析）</div>
        </div>
        {paretoView === 'fishbone' && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>针对帕累托 Top 缺陷做根因分析</span>
        )}
      </Card>
      {paretoView === 'pareto' ? <ParetoInner T={T} /> : <Fishbone T={T} />}
    </div>
  );
}

function ParetoInner({ T }: { T: ChartTokens }) {
  const { openModal, setImportTab, setImportKind } = useApp();
  const pareto = useData((st) => st.paretoModel);
  const [showDemo, setShowDemo] = useState(false);
  const [mergeOther, setMergeOther] = useState(false);
  const colors = paretoColors(T);

  const isReal = !!(pareto && pareto.rows.length > 0);
  if (!isReal && !showDemo) {
    return (
      <EmptyStateCard
        title="导入缺陷数据,生成你自己的帕累托图"
        need="需要「类别 + 频数」数据:纵向两列(如 划伤,32 / 毛刺,21)或横向两行(类别一行、频数一行,自动转置);也可粘贴单列原始缺陷标签(自动计数)。导入时数据类型选「缺陷类别+频数(帕累托)」。"
        actions={[{ label: '导入类别数据', primary: true, onClick: () => { setImportKind('pareto'); setImportTab('clip'); openModal('import'); } }]}
        onDemo={() => setShowDemo(true)}
      />
    );
  }

  const source = isReal ? pareto!.rows : DEFECTS;
  const sorted = [...source].sort((a, b) => b.count - a.count);
  const total0 = sorted.reduce((a, d) => a + d.count, 0) || 1;
  // 合并尾部:累计占比超过 95% 之后的类别并为「其他」(至少剩 2 个尾部类别才合并)
  let display = sorted;
  if (mergeOther && sorted.length > 3) {
    let cum = 0; let cut = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      cum += sorted[i].count;
      if (cum / total0 >= 0.95) { cut = i + 1; break; }
    }
    if (sorted.length - cut >= 2) {
      display = [...sorted.slice(0, cut), { name: '其他', count: sorted.slice(cut).reduce((a, d) => a + d.count, 0) }];
    }
  }
  const total = display.reduce((a, d) => a + d.count, 0) || 1;
  const cums = display.reduce<number[]>((acc, d) => [...acc, (acc[acc.length - 1] ?? 0) + d.count], []);
  const rows = display.map((d, i) => ({
    ...d,
    cum: Math.round((cums[i] / total) * 100) + '%',
    color: d.name === '其他' ? '#c8cfd8' : colors[i % colors.length],
  }));
  const topN = Math.min(2, sorted.length);
  const topShare = Math.round((sorted.slice(0, topN).reduce((a, d) => a + d.count, 0) / total0) * 100);
  const topNames = sorted.slice(0, topN).map((d) => `「${d.name}」`).join('与');
  // 帕累托(80/20)判定:统计"累计达 80% 所需的类别数 k80"占全部类别的比例——
  // 真正的"关键少数"是少数类别(≤~1/4)贡献 80% 缺陷,且类别数需足够多(≥5)才有意义。
  // 旧逻辑"前两类≥60% 即判 80/20"会把 3 类里 2 类占 61% 也误判为符合,已废弃。
  const nCats = sorted.length;
  let k80 = 0; let run = 0;
  for (const d of sorted) { run += d.count; k80++; if (run / total0 >= 0.8) break; }
  const vitalPct = Math.round((k80 / nCats) * 100);
  const isPareto = nCats >= 5 && k80 / nCats <= 0.25;
  const conclusion = topN < 2
    ? `${topNames}占缺陷总数的 ${topShare}%。`
    : isPareto
      ? `前 ${k80} 类(仅占 ${nCats} 类中的 ${vitalPct}%)即累计贡献 80% 的缺陷,呈典型帕累托「关键少数」集中——优先改善这几类可消除大部分不良。`
      : `前 ${topN} 类(${topNames})合计占 ${topShare}%;需前 ${k80}/${nCats} 类才累计达 80%,集中度不足以称"80/20",建议扩大改善范围或细分类别。`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
      <Card>
        <CardHeader
          title={isReal ? `缺陷帕累托图 · ${pareto!.name}` : '缺陷帕累托图 · 示例'}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {sorted.length > 3 && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#5b6472', cursor: 'pointer' }}>
                  <input type="checkbox" checked={mergeOther} onChange={(e) => setMergeOther(e.target.checked)} />
                  合并尾部为「其他」(95%)
                </label>
              )}
              {!isReal && <DemoBadge />}
            </div>
          }
        />
        <div style={{ padding: '14px 16px 6px' }}>
          <ParetoChart T={T} rows={display} w={960} h={340} />
        </div>
      </Card>
      <Card>
        <CardHeader title="缺陷明细" right={<span style={{ fontSize: 11.5, color: '#98a1ac' }}>共 {total0} 件</span>} />
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
              <th style={{ padding: '8px 16px', fontWeight: 600 }}>类别</th>
              <th style={{ padding: '8px 8px', fontWeight: 600, textAlign: 'right' }}>数量</th>
              <th style={{ padding: '8px 16px', fontWeight: 600, textAlign: 'right' }}>累计%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, di) => (
              <tr key={di} style={{ borderTop: '1px solid #f0f2f5' }}>
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
          {conclusion}
        </div>
      </Card>
    </div>
  );
}
