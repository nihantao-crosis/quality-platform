/** 实验设计 DOE — 接真实数据:分析因子设计(选因子/响应列)+ 创建因子设计(生成到工作表)。
 * 出厂演示集显示 2³ 示例;导入用户数据后按实际因子/响应分析,标题与结论全部动态。 */
import { useMemo, useState } from 'react';
import { useApp, type DoeView } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import {
  nf, tInv,
  analyzeDoe, mainEffectMeans, interactionMeans, DOE_DESIGN,
  detectFactorial, analyzeFactorial, mainEffectMeansFrom, interactionMeansFrom, generateFactorialDesign,
  resolveDoeColumns, type CodedDesign, type FactorialResult, type FactorDef,
} from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, tabStyle, EmptyStateCard, DemoBadge, numInput } from '../common';
import { NormalProbPlot } from '../charts/NormalProbPlot';
import { ScatterPlot } from '../charts/ScatterPlot';
import { MiniHist } from '../charts/misc';
import { MainEffects, InteractionPlot, EffectsBar, CubePlot } from '../charts/doe';

const VIEWS: Array<[DoeView, string]> = [
  ['main', '主效应图'],
  ['interact', '交互作用图'],
  ['pareto', '效应帕累托'],
  ['cube', '立方图'],
];

const selStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #cfd5dd', borderRadius: 4,
  fontSize: 12, color: '#2a333f', background: '#fff',
};

export function Doe({ T }: { T: ChartTokens }) {
  const name = useData((s) => s.model.name);
  return <DoeInner key={name} T={T} />;
}

function DoeInner({ T }: { T: ChartTokens }) {
  const { model: M } = useData();
  const [tab, setTab] = useState<'analyze' | 'create'>('analyze');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>DOE</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={tabStyle(tab === 'analyze')} onClick={() => setTab('analyze')}>分析因子设计</div>
          <div style={tabStyle(tab === 'create')} onClick={() => setTab('create')}>创建因子设计</div>
        </div>
        {M.isDemo && tab === 'analyze' && <div style={{ marginLeft: 'auto' }}><DemoBadge /></div>}
      </Card>
      {tab === 'create' ? <CreateDesign /> : <AnalyzeDesign T={T} />}
    </div>
  );
}

// ---------- 分析因子设计 ----------
function AnalyzeDesign({ T }: { T: ChartTokens }) {
  const { model: M } = useData();
  const { doeView, setDoeView, doeFactorCols, doeRespCol, setDoeCols, showToast } = useApp();
  const isDemo = M.isDemo;

  // 列选择:页面与项目汇总共用 resolveDoeColumns(按列名存入 store、默认末列为响应),
  // 保证「分析页所见」与「保存到项目的汇总卡」始终基于同一组列。
  const nCols = M.colNames.length;
  const { factorIdx, respIdx } = useMemo(
    () => resolveDoeColumns(M.colNames, doeFactorCols, doeRespCol),
    [M.colNames, doeFactorCols, doeRespCol],
  );
  const curFactorNames = factorIdx.map((i) => M.colNames[i]);
  const toggleFactor = (i: number, on: boolean) => {
    const name = M.colNames[i];
    if (on && curFactorNames.length >= 4) { showToast('DOE 因子设计最多支持 4 个因子'); return; }
    setDoeCols(on ? [...curFactorNames, name] : curFactorNames.filter((n) => n !== name), doeRespCol);
  };
  const setResp = (v: number) => {
    const respName = M.colNames[v];
    setDoeCols(curFactorNames.filter((n) => n !== respName), respName);
  };
  const [pairA, setPairA] = useState(0);
  const [pairB, setPairB] = useState(1);

  const detect = useMemo(() => {
    if (isDemo) return null;
    const facs = factorIdx.map((i) => ({ name: M.colNames[i], values: M.subs.map((s) => s.vals[i]) }));
    const resp = M.subs.map((s) => s.vals[respIdx]);
    if (facs.length < 2) return { ok: false as const, reason: '请至少勾选 2 个因子列(且不与响应列相同)' };
    return detectFactorial(facs, resp);
  }, [isDemo, factorIdx, respIdx, M]);

  // 演示:沿用内置 2³(hook 必须在任何早返回之前)
  const demoRes = useMemo(() => (isDemo ? analyzeDoe() : null), [isDemo]);

  // 空态:非演示且数值列不足(需 ≥2 因子 + 1 响应 = 3 列)
  if (!isDemo && nCols < 3) {
    return (
      <EmptyStateCard
        title="因子设计分析需要因子列 + 响应列"
        need="至少 2 个因子列(各为 2 水平,可含中心点)+ 1 个响应列。可用「创建因子设计」生成规范的设计表,按运行序试验并录入响应后回此分析。"
        current={`当前数据集 ${nCols} 个数值列`}
        actions={[]}
      />
    );
  }

  const real: FactorialResult | null = detect && detect.ok ? analyzeFactorial(detect.design) : null;
  const design: CodedDesign | null = detect && detect.ok ? detect.design : null;

  // 列选择工具条(非演示时)
  const picker = !isDemo && (
    <Card style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: '#5b6472' }}>
      <span style={{ fontWeight: 600, color: '#8a929d' }}>因子</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {M.colNames.map((n, i) => i === respIdx ? null : (
          <label key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={factorIdx.includes(i)}
              onChange={(e) => toggleFactor(i, e.target.checked)} />
            {n}
          </label>
        ))}
      </div>
      <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#8a929d' }}>响应</span>
      <select style={selStyle} value={respIdx} onChange={(e) => setResp(+e.target.value)}>
        {M.colNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
      </select>
    </Card>
  );

  // 检测失败(数据形态不对):给出原因 + 引导
  if (!isDemo && detect && !detect.ok) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {picker}
        <Card style={{ padding: '18px 20px', fontSize: 13, color: '#8a6520', background: '#fffdf7', lineHeight: 1.7 }}>
          <b>无法识别为因子设计:</b>{detect.reason}
          <div style={{ fontSize: 12, color: '#9aa2ad', marginTop: 8 }}>
            DOE 因子设计要求每个因子恰好 2 个水平(可加一个中值作中心点)。若数据尚未按设计采集,请到「创建因子设计」生成设计表,
            按运行序试验并录入响应后再来分析。
          </div>
        </Card>
      </div>
    );
  }

  // 响应尚未录入(全为占位 0 或无变异):不产出正式结论,引导先录入(否则会把"未采集"当成"实测为 0")
  if (!isDemo && design && new Set(design.response).size < 2) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {picker}
        <Card style={{ padding: '18px 20px', fontSize: 13, color: '#8a6520', background: '#fffdf7', lineHeight: 1.7 }}>
          <b>响应列「{M.colNames[respIdx]}」尚未录入:</b>该列所有值相同(如刚生成设计时的占位 0),无变异,无法估计效应。
          <div style={{ fontSize: 12, color: '#9aa2ad', marginTop: 8 }}>
            请到「数据工作表」按运行序逐行录入实测响应后再回此分析——否则会把"尚未采集"误当成"实测值为 0"并给出无意义的结论。
          </div>
        </Card>
      </div>
    );
  }

  // ── 渲染结果(演示或真实) ──
  const respName = isDemo ? '抗拉强度 (MPa)' : M.colNames[respIdx];
  const factorNames = isDemo ? ['A 温度', 'B 压力', 'C 时间'] : design!.factorNames;
  const k = factorNames.length;

  // 交互作用对:限制在有效范围且两因子必须不同(避免同一因子导致 NaN 空图)
  const pa = Math.min(pairA, k - 1);
  const pbRaw = Math.min(pairB, k - 1);
  const pb = pbRaw === pa ? (pa + 1) % Math.max(k, 2) : pbRaw;

  const mainData = isDemo ? mainEffectMeans() : mainEffectMeansFrom(design!);
  const interData = isDemo ? interactionMeans() : interactionMeansFrom(design!, pa, pb);

  // 统一为 FactorialResult 形态(演示的 DoeResult 映射进来)
  const res: FactorialResult = isDemo
    ? {
      terms: demoRes!.terms.map((t) => ({ name: t.name, effect: t.v, coef: t.coef, sig: t.sig })),
      method: 'lenth', me: demoRes!.me, pse: demoRes!.pse,
      fits: [], residuals: [], grand: 0, factorNames, nRuns: DOE_DESIGN.length,
    }
    : real!;
  // 效应帕累托:饱和/演示用 |效应|+ME 线;t 检验用 |t| + t 临界线
  const isT = res.method === 'ttest';
  // 零残差时 |t| 可为 Infinity(完美拟合下非零效应),给帕累托条一个有限上限避免图崩
  const finiteT = res.terms.map((t) => Math.abs(t.tStat ?? 0)).filter((v) => Number.isFinite(v));
  const capT = (finiteT.length ? Math.max(...finiteT) : 1) * 1.5 + 1;
  const barTerms = res.terms.map((t) => ({
    name: t.name,
    abs: isT ? (Number.isFinite(t.tStat) ? Math.abs(t.tStat as number) : capT) : Math.abs(t.effect),
  }));
  const barRef = isT ? tInv(0.975, res.dfResid ?? 1) : (res.me ?? 0);

  // 立方图(仅 3 因子):角点响应均值
  const cornerMean = (a: number, b: number, c: number): number => {
    if (isDemo) return DOE_DESIGN[a + 2 * b + 4 * c][3];
    const vals = design!.response.filter((_, r) => design!.coded[r][0] === (a ? 1 : -1) && design!.coded[r][1] === (b ? 1 : -1) && design!.coded[r][2] === (c ? 1 : -1));
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
  };

  // 动态结论
  const sigTerms = res.terms.filter((t) => t.sig);
  const sigMains = sigTerms.filter((t) => !t.name.includes('×'));
  const best = res.terms.filter((t) => !t.name.includes('×')).map((t) => `${t.name}=${t.effect >= 0 ? '高(+)' : '低(−)'}`);
  const conclusion = isDemo
    ? '温度 (A) 与时间 (C) 为主导因子,压力 (B) 次之;交互作用不显著。要使抗拉强度最大化,应将温度、时间、压力均设为高水平 (+1),预测强度约 66 MPa。'
    : sigTerms.length === 0
      ? `在当前数据下未发现显著的因子或交互作用(${isT ? `残差自由度 ${res.dfResid}` : 'Lenth 检验'})。可增加重复或中心点以提高检验功效。`
      : `显著项:${sigTerms.map((t) => t.name).join('、')}。${sigMains.length ? `要使「${respName}」最大化,建议将各主效应设为:${best.join('、')}。` : '主要为交互作用,需结合交互图确定最优组合。'}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {picker}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>
            {doeView === 'main' && `主效应图 · 响应 = ${respName}`}
            {doeView === 'interact' && `交互作用图 · ${factorNames[pa]} × ${factorNames[pb]}`}
            {doeView === 'pareto' && `${isT ? '标准化效应' : '效应'}帕累托 · ${isDemo ? 'Lenth 显著界限' : isT ? 't 临界线' : 'Lenth 显著界限'}`}
            {doeView === 'cube' && `立方图 · ${k === 3 ? '8 顶点响应' : '仅 3 因子适用'}`}
          </div>
          {doeView === 'interact' && !isDemo && k > 2 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6472' }}>
              <select style={selStyle} value={pairA} onChange={(e) => setPairA(+e.target.value)}>
                {factorNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
              </select>×
              <select style={selStyle} value={pairB} onChange={(e) => setPairB(+e.target.value)}>
                {factorNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
              </select>
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {VIEWS.filter(([k2]) => k2 !== 'cube' || k === 3).map(([k2, l]) => (
              <div key={k2} style={tabStyle(doeView === k2)} onClick={() => setDoeView(k2)}>{l}</div>
            ))}
          </div>
        </div>
        <div style={{ padding: '16px 16px 8px' }}>
          {doeView === 'main' && <MainEffects T={T} factors={mainData} />}
          {doeView === 'interact' && <InteractionPlot T={T} {...interData} labelA={factorNames[pa]} labelB={factorNames[pb]} />}
          {doeView === 'pareto' && <EffectsBar T={T} terms={barTerms} refLine={barRef} />}
          {doeView === 'cube' && k === 3 && <CubePlot T={T} y={(a, b, c) => cornerMean(a, b, c)} labels={[factorNames[0], factorNames[1], factorNames[2]] as [string, string, string]} />}
          {doeView === 'cube' && k !== 3 && <div style={{ padding: 20, color: '#9aa2ad', fontSize: 12.5 }}>立方图仅适用于 3 因子设计,当前为 {k} 因子。</div>}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
        <Card>
          <CardHeader title={`效应与系数 · ${isDemo || !isT ? 'Lenth 检验' : `t 检验(残差自由度 ${res.dfResid})`}`} />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'right' }}>
                <th style={{ padding: '8px 16px', fontWeight: 600, textAlign: 'left' }}>项</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>效应</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>系数</th>
                {isT && <th style={{ padding: '8px 12px', fontWeight: 600 }}>P</th>}
                <th style={{ padding: '8px 16px', fontWeight: 600, textAlign: 'center' }}>显著性</th>
              </tr>
            </thead>
            <tbody>
              {res.terms.map((c) => (
                <tr key={c.name} className="mono" style={{ borderTop: '1px solid #f0f2f5', textAlign: 'right' }}>
                  <td style={{ padding: '8px 16px', textAlign: 'left', color: '#33404f', fontFamily: 'IBM Plex Sans', fontWeight: 500 }}>{c.name}</td>
                  <td style={{ padding: '8px 12px', color: '#2a333f', fontWeight: 600 }}>{nf(c.effect, 3)}</td>
                  <td style={{ padding: '8px 12px', color: '#5b6472' }}>{nf(c.coef, 3)}</td>
                  {isT && <td style={{ padding: '8px 12px', color: c.sig ? '#c22f2f' : '#5b6472' }}>{c.p! < 0.001 ? '<0.001' : nf(c.p!, 3)}</td>}
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
          <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.65 }}>{conclusion}</div>
          {!isDemo && res.curvature && (
            <div style={{ fontSize: 12, color: res.curvature.sig ? '#b0620f' : '#5b6472', lineHeight: 1.6, marginTop: 8, paddingTop: 8, borderTop: '1px dashed #eceff2' }}>
              <b>曲率(弯曲)检验:</b>{res.curvature.sig
                ? `显著(${res.curvature.p !== undefined ? (res.curvature.p < 0.001 ? 'p<0.001' : `p=${nf(res.curvature.p, 3)}`) : '—'})——中心点响应偏离角点线性预测,说明存在弯曲,宜升级为响应曲面(含二次项)设计。`
                : res.curvature.p !== undefined ? `不显著(p=${nf(res.curvature.p, 3)})——无明显弯曲,两水平线性模型足以描述当前区域。` : '中心点已纳入,但无残差自由度可供检验。'}
            </div>
          )}
          {!isDemo && res.droppedTerms && res.droppedTerms.length > 0 && (
            <div style={{ fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.6, marginTop: 8 }}>
              设计不完整/存在别名,{res.droppedTerms.length} 个高阶项无法单独估计,已从模型剔除:{res.droppedTerms.join('、')}。
            </div>
          )}
        </Card>
      </div>

      {!isDemo && (() => {
        // 有标准化残差(t 检验路径)则用之,对标 Minitab 四合一;否则回落原始残差
        const rr = res.stdResiduals ?? res.residuals;
        const std = res.stdResiduals != null;
        const yl = std ? '标准化残差' : '残差';
        return (
          <Card>
            <CardHeader title="残差诊断(四合一)" right={<span style={{ fontSize: 11.5, color: '#98a1ac' }}>{std ? '标准化残差 = 残差 /(s·√(1−杠杆))' : '残差 = 观测 − 模型拟合值'}</span>} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 12px 12px' }}>
              <NormalProbPlot T={T} data={rr} h={220} />
              <ScatterPlot T={T} xs={res.fits} ys={rr} slope={0} intercept={0} xLabel="拟合值" yLabel={yl} h={220} />
              <MiniHist T={T} data={rr} h={220} xLabel={`${yl}分布`} />
              <ScatterPlot T={T} xs={rr.map((_, i) => i + 1)} ys={rr} slope={0} intercept={0} xLabel="运行序" yLabel={yl} h={220} />
            </div>
          </Card>
        );
      })()}

      <Card>
        <CardHeader title={isDemo ? '设计矩阵 · 2³ 全因子 (8 运行)' : `设计矩阵 · ${design!.factorNames.length} 因子 (${design!.response.length} 运行)`} />
        <div style={{ overflowX: 'auto' }}>
          <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'center', fontFamily: 'IBM Plex Sans' }}>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>运行</th>
                {factorNames.map((n) => <th key={n} style={{ padding: '8px 12px', fontWeight: 600 }}>{n}</th>)}
                <th style={{ padding: '8px 12px', fontWeight: 600, textAlign: 'right' }}>{isDemo ? '强度' : respName}</th>
              </tr>
            </thead>
            <tbody>
              {isDemo
                ? DOE_DESIGN.map((d, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f0f2f5', textAlign: 'center' }}>
                    <td style={{ padding: '7px 12px', color: '#9aa2ad' }}>{i + 1}</td>
                    {[d[0], d[1], d[2]].map((v, j) => <td key={j} style={{ padding: '7px 12px', color: v === '+' ? '#2c8a45' : '#c22f2f' }}>{v}</td>)}
                    <td style={{ padding: '7px 12px', color: '#2a333f', fontWeight: 600, textAlign: 'right' }}>{d[3]}</td>
                  </tr>
                ))
                : design!.coded.map((row, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f0f2f5', textAlign: 'center' }}>
                    <td style={{ padding: '7px 12px', color: '#9aa2ad' }}>{i + 1}</td>
                    {row.map((c, j) => <td key={j} style={{ padding: '7px 12px', color: c > 0 ? '#2c8a45' : c < 0 ? '#c22f2f' : '#8a929d' }}>{c > 0 ? '+' : c < 0 ? '−' : '0'}</td>)}
                    <td style={{ padding: '7px 12px', color: '#2a333f', fontWeight: 600, textAlign: 'right' }}>{nf(design!.response[i], 3)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------- 创建因子设计 ----------
function CreateDesign() {
  const { importMatrix } = useData();
  const { goTo, showToast } = useApp();
  const [k, setK] = useState(2);
  const [factors, setFactors] = useState<FactorDef[]>([
    { name: '过盈量', low: 0.045, high: 0.09 },
    { name: '轴硬度', low: 28, high: 32 },
    { name: '因子C', low: 0, high: 1 },
  ]);
  const [center, setCenter] = useState(3);
  const [reps, setReps] = useState(1);
  const [randomize, setRandomize] = useState(true);

  const runs = (1 << k) * reps + center;
  const setF = (i: number, patch: Partial<FactorDef>) =>
    setFactors((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const create = () => {
    const facs = factors.slice(0, k);
    if (facs.some((f) => !f.name.trim())) { showToast('请填写所有因子名'); return; }
    if (facs.some((f) => f.low === f.high)) { showToast('每个因子的上下限不能相同'); return; }
    const d = generateFactorialDesign(facs.map((f) => ({ name: f.name.trim(), low: f.low, high: f.high })),
      { centerPoints: center, replicates: reps, randomize, seed: 20260713 });
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
    importMatrix(`DOE设计_${stamp}`, d.colNames, d.rows);
    goTo('worksheet');
    showToast(`已生成 ${d.rows.length} 运行的因子设计,请按运行序试验并在「响应(待录入)」列录入,完成后回 DOE→分析`);
  };

  const inp: React.CSSProperties = { ...numInput, width: 90 };
  return (
    <Card style={{ padding: '18px 20px' }}>
      <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 14 }}>创建两水平全因子设计</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12.5, color: '#5b6472', maxWidth: 620 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          因子数
          <select style={selStyle} value={k} onChange={(e) => setK(+e.target.value)}>
            <option value={2}>2 因子(4 角)</option>
            <option value={3}>3 因子(8 角)</option>
          </select>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {factors.slice(0, k).map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 40, color: '#8a929d' }}>因子{i + 1}</span>
              <input value={f.name} onChange={(e) => setF(i, { name: e.target.value })}
                style={{ width: 130, padding: '5px 8px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5 }} />
              <span>低</span>
              <input type="number" step="any" value={f.low} onChange={(e) => setF(i, { low: parseFloat(e.target.value) || 0 })} style={inp} />
              <span>高</span>
              <input type="number" step="any" value={f.high} onChange={(e) => setF(i, { high: parseFloat(e.target.value) || 0 })} style={inp} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            中心点数
            <input type="number" min={0} max={10} value={center} onChange={(e) => setCenter(Math.max(0, Math.min(10, parseInt(e.target.value) || 0)))} style={{ ...inp, width: 64 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            重复数
            <input type="number" min={1} max={10} value={reps} onChange={(e) => setReps(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))} style={{ ...inp, width: 64 }} />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={randomize} onChange={(e) => setRandomize(e.target.checked)} /> 随机化运行序
          </label>
          <span style={{ color: '#1c4e7a' }}>共 <b className="mono">{runs}</b> 次试验</span>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.6 }}>
          生成后进入工作表:各因子列为设定水平、末列「响应(待录入)」为空(占位 0)。按运行序逐行试验、双击录入响应,
          完成后回到「分析因子设计」即可出主效应/交互/效应帕累托/残差图。中心点用于检验曲率并提供纯误差估计。
        </div>
        <div>
          <div className="hov-act-primary" onClick={create}
            style={{ display: 'inline-block', padding: '9px 20px', background: '#1f6fb2', color: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            生成设计表 → 工作表
          </div>
        </div>
      </div>
    </Card>
  );
}
