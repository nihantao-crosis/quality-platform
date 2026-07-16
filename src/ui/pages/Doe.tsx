/** 实验设计 DOE — 接真实数据:分析因子设计(选因子/响应列)+ 创建因子设计(生成到工作表)。
 * 出厂演示集显示 2³ 示例;导入用户数据后按实际因子/响应分析,标题与结论全部动态。 */
import { useMemo, useState } from 'react';
import { useApp, type DoeView } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import {
  nf, tInv,
  analyzeDoe, mainEffectMeans, interactionMeans, DOE_DESIGN,
  detectFactorial, analyzeFactorial, factorialAdjustedMainMeans, factorialAdjustedInteractionMeans, factorialCornerPredictions, generateFactorialDesign,
  resolveDoeColumns, resolveDoeBlockValues, factorialModelTerms, factorialOptimizationDecision, isDoeAnalysisColumn, buildDoeWorksheetOutput,
  uncodedEquation, lenthPseFromEffects, studentizedDeletedResiduals,
  type CodedDesign, type FactorialResult, type FactorDef,
} from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, tabStyle, EmptyStateCard, DemoBadge, numInput } from '../common';
import { NormalProbPlot } from '../charts/NormalProbPlot';
import { EffectsNormalPlot } from '../charts/EffectsNormalPlot';
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
  const { doeTab: tab, setDoeTab: setTab } = useApp();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>DOE</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" aria-pressed={tab === 'analyze'} style={tabStyle(tab === 'analyze')} onClick={() => setTab('analyze')}>分析因子设计</button>
          <button type="button" aria-pressed={tab === 'create'} style={tabStyle(tab === 'create')} onClick={() => setTab('create')}>创建因子设计</button>
        </div>
        {M.isDemo && tab === 'analyze' && <div style={{ marginLeft: 'auto' }}><DemoBadge /></div>}
      </Card>
      {tab === 'create' ? <CreateDesign /> : <AnalyzeDesign T={T} />}
    </div>
  );
}

// ---------- 分析因子设计 ----------
function AnalyzeDesign({ T }: { T: ChartTokens }) {
  const { model: M, textCols, pendingCells, writeAnalysisColumns } = useData();
  const {
    doeView, setDoeView, doeFactorCols, doeRespCol, setDoeCols,
    doeModelTerms, doeIncludeCurvature, setDoeModel, showToast,
  } = useApp();
  const isDemo = M.isDemo;

  // 列选择:页面与项目汇总共用 resolveDoeColumns(按列名存入 store、默认末列为响应),
  // 保证「分析页所见」与「保存到项目的汇总卡」始终基于同一组列。
  const nCols = M.colNames.length;
  const eligibleIdx = useMemo(
    () => M.colNames.map((name, index) => ({ name, index })).filter(({ name }) => isDoeAnalysisColumn(name)).map(({ index }) => index),
    [M.colNames],
  );
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
  // 本轮 DOE 新增的纯展示状态:效应图页签/残差类型/残差布局与单图页签/残差 vs 变量的因子。
  // 按批次约定只放页面内部 useState,不进全局 store/项目快照。
  const [effView, setEffView] = useState<'pareto' | 'normal' | 'half'>('pareto');
  const [residType, setResidType] = useState<'raw' | 'std' | 'del'>('std');
  const [residLayout, setResidLayout] = useState<'grid' | 'single'>('grid');
  const [residPane, setResidPane] = useState<'normal' | 'fits' | 'hist' | 'order'>('normal');
  const [residFactorIdx, setResidFactorIdx] = useState(0);

  const detect = useMemo(() => {
    if (isDemo) return null;
    const facs = factorIdx.map((i) => ({ name: M.colNames[i], values: M.subs.map((s) => s.vals[i]) }));
    const resp = M.subs.map((s) => s.vals[respIdx]);
    if (facs.length < 2) return { ok: false as const, reason: '请至少勾选 2 个因子列(且不与响应列相同)' };
    const blocks = resolveDoeBlockValues(M.colNames, M.subs.map((sub) => sub.vals), textCols);
    return detectFactorial(facs, resp, { blocks });
  }, [isDemo, factorIdx, respIdx, M, textCols]);

  // 演示:沿用内置 2³(hook 必须在任何早返回之前)
  const demoRes = useMemo(() => (isDemo ? analyzeDoe() : null), [isDemo]);

  const design: CodedDesign | null = detect && detect.ok ? detect.design : null;
  const availableTerms = design ? factorialModelTerms(design.factorNames) : [];
  const storedTerms = doeModelTerms?.filter((term) => availableTerms.includes(term)) ?? null;
  const selectedTerms = storedTerms && storedTerms.length > 0 ? storedTerms : availableTerms;
  const real: FactorialResult | null = design
    ? analyzeFactorial(design, { terms: selectedTerms, includeCurvature: doeIncludeCurvature })
    : null;

  // 空态:非演示且可分析列不足(元数据/旧输出列不计入因子或响应)
  if (!isDemo && eligibleIdx.length < 3) {
    return (
      <EmptyStateCard
        title="因子设计分析需要因子列 + 响应列"
        need="至少 2 个因子列(各为 2 水平,可含中心点)+ 1 个响应列。可用「创建因子设计」生成规范的设计表,按运行序试验并录入响应后回此分析。"
        current={`当前数据集 ${nCols} 个数值列，其中 ${eligibleIdx.length} 个可作为因子/响应（元数据和 DOE 输出已排除）`}
        actions={[]}
      />
    );
  }

  // 列选择工具条(非演示时)
  const picker = !isDemo && (
    <Card style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: '#5b6472' }}>
      <span style={{ fontWeight: 600, color: '#8a929d' }}>因子</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {M.colNames.map((n, i) => i === respIdx || !eligibleIdx.includes(i) ? null : (
          <label key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={factorIdx.includes(i)}
              onChange={(e) => toggleFactor(i, e.target.checked)} />
            {n}
          </label>
        ))}
      </div>
      <span style={{ marginLeft: 'auto', fontWeight: 600, color: '#8a929d' }}>响应</span>
      <select style={selStyle} value={respIdx} onChange={(e) => setResp(+e.target.value)}>
        {eligibleIdx.map((i) => <option key={i} value={i}>{M.colNames[i]}</option>)}
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

  // 响应尚未录入完成:①全列无变异;②设计生成器标记的待录入单元格尚未清空。
  // 待录入状态独立于列名与数值:重命名不会绕过拦截,实测值确为 0 时编辑该格即可正常完成。
  if (!isDemo && design) {
    const respName0 = M.colNames[respIdx];
    const noVariance = new Set(design.response).size < 2;
    const pendingRows = pendingCells.filter((p) => p.col === respIdx).length;
    if (noVariance || pendingRows > 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {picker}
          <Card style={{ padding: '18px 20px', fontSize: 13, color: '#8a6520', background: '#fffdf7', lineHeight: 1.7 }}>
            <b>响应列「{respName0}」尚未录入完成:</b>
            {noVariance
              ? '该列所有值相同(如刚生成设计时的占位 0),无变异,无法估计效应。'
              : `还有 ${pendingRows} 行标记为尚未录入实测响应,此时分析会把占位值当成实测值、给出无意义的显著结论。`}
            <div style={{ fontSize: 12, color: '#9aa2ad', marginTop: 8 }}>
              请到「数据工作表」按运行序逐行录满实测响应后再回此分析。
              {pendingRows > 0 ? '若某运行实测值确为 0,仍请在该单元格中确认录入 0,系统会清除该格的待录入标记。' : ''}
            </div>
          </Card>
        </div>
      );
    }
  }

  // 因子项可能全部与区组/较低阶项混杂。此时只有截距能拟合，不能把“没有可估计项”
  // 写成“未发现显著效应”，否则会给退化设计一个看似完整的统计结论。
  if (!isDemo && real && real.terms.length === 0) {
    const aliasText = real.aliases?.map((alias) =>
      alias.relation === 'same'
        ? `${alias.term} = ${alias.with}`
        : alias.relation === 'opposite'
          ? `${alias.term} = −${alias.with}`
          : `${alias.term} 与 ${alias.with} 线性相关`).join('；');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {picker}
        <Card style={{ padding: '18px 20px', fontSize: 13, color: '#8a6520', background: '#fffdf7', lineHeight: 1.7 }}>
          <b>当前模型没有可独立估计的因子效应，分析未运行。</b>
          <div style={{ fontSize: 12, color: '#7a8491', marginTop: 8 }}>
            所选模型项：{real.requestedTerms.join('、')}。{aliasText ? `可估计性诊断：${aliasText}。` : ''}
            请解除因子与区组/其他项的完全混杂，增加能区分这些效应的运行，或改选可估计模型项。
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

  // 统一为 FactorialResult 形态(演示的 DoeResult 映射进来)
  const res: FactorialResult = isDemo
    ? {
      terms: demoRes!.terms.map((t) => ({ name: t.name, effect: t.v, coef: t.coef, sig: t.sig })),
      method: 'lenth', me: demoRes!.me, pse: demoRes!.pse,
      requestedTerms: demoRes!.terms.map((term) => term.name), includeCurvature: false,
      fits: [], residuals: [], grand: 0, factorNames, nRuns: DOE_DESIGN.length,
    }
    : real!;
  const mainData = isDemo ? mainEffectMeans() : factorialAdjustedMainMeans(res, design!);
  const interData = isDemo ? interactionMeans() : factorialAdjustedInteractionMeans(res, design!, pa, pb);
  // 效应帕累托:饱和/演示用 |效应|+ME 线;t 检验用 |t| + t 临界线
  const isT = res.method === 'ttest';
  // 零残差时 |t| 可为 Infinity(完美拟合下非零效应),给帕累托条一个有限上限避免图崩
  const finiteT = res.terms.map((t) => Math.abs(t.tStat ?? 0)).filter((v) => Number.isFinite(v));
  const capT = (finiteT.length ? Math.max(...finiteT) : 1) * 1.5 + 1;
  const barTerms = res.terms.map((t) => ({
    name: t.name,
    abs: isT ? (Number.isFinite(t.tStat) ? Math.abs(t.tStat as number) : capT) : Math.abs(t.effect),
    sig: t.sig,
  }));
  const barRef = isT ? tInv(0.975, res.dfResid ?? 1) : (res.me ?? 0);

  // 立方图(仅 3 因子):角点响应均值
  const cornerMean = (a: number, b: number, c: number): number => {
    if (isDemo) return DOE_DESIGN[a + 2 * b + 4 * c][3];
    const target = [a ? 1 : -1, b ? 1 : -1, c ? 1 : -1];
    return factorialCornerPredictions(res, design!).find((corner) =>
      corner.coded.every((value, index) => value === target[index]))?.predicted ?? NaN;
  };

  // 动态结论
  const sigTerms = res.terms.filter((t) => t.sig);
  const sigInteractions = sigTerms.filter((t) => t.name.includes('×'));
  const optimization = !isDemo ? factorialOptimizationDecision(res, design!) : null;
  const uniqueSettings = optimization?.status === 'unique' && optimization.optimum
    ? optimization.optimum.factorValues.map((value, index) =>
      `${factorNames[index]}=${nf(value, 6)}(${optimization.optimum!.coded[index] > 0 ? '高' : '低'})`).join('、')
    : '';
  const fixedSettings = optimization?.status === 'tied'
    ? optimization.fixedCoded?.flatMap((coded, index) => coded == null ? [] : [
      `${factorNames[index]}=${nf(coded > 0 ? design!.levels[index].high : design!.levels[index].low, 6)}(${coded > 0 ? '高' : '低'})`,
    ]).join('、')
    : '';
  const tiedSettings = optimization?.status === 'tied'
    ? optimization.optimum?.ties.slice(0, 4).map((corner) => corner.factorValues.map((value, index) =>
      `${factorNames[index]}=${nf(value, 6)}(${corner.coded[index] > 0 ? '高' : '低'})`).join('、')).join('；')
    : '';
  const interactionNote = sigInteractions.length
    ? '已综合显著交互作用，不按主效应符号独立推荐。'
    : '当前未检出显著交互，仍建议用确认试验验证。';
  const conclusion = isDemo
    ? '温度 (A) 与时间 (C) 为主导因子,压力 (B) 次之;交互作用不显著。要使抗拉强度最大化,应将温度、时间、压力均设为高水平 (+1),预测强度约 66 MPa。'
    : optimization?.status === 'no-significant-effect'
      ? `在当前数据下未发现显著的因子或交互作用(${isT ? `残差自由度 ${res.dfResid}` : 'Lenth 检验'})。可增加重复或中心点以提高检验功效。`
      : optimization?.status === 'significant-curvature'
        ? `${sigTerms.length ? `显著工艺项:${sigTerms.map((t) => t.name).join('、')}；同时` : ''}中心点曲率显著；两水平线性模型不能可靠给出最优角点，暂不推荐设置，应升级为响应曲面设计。`
        : optimization?.status === 'tied'
          ? `显著项:${sigTerms.map((t) => t.name).join('、')}。当前模型有 ${optimization.optimum!.ties.length} 个并列最大角点，无唯一最优组合；共同设置为:${fixedSettings || '无（所有因子均存在并列设置）'}。并列组合:${tiedSettings}${optimization.optimum!.ties.length > 4 ? `；另有 ${optimization.optimum!.ties.length - 4} 个` : ''}。${interactionNote}`
          : `显著项:${sigTerms.map((t) => t.name).join('、')}。按当前完整拟合模型枚举 2^${factorNames.length} 个角点，「${respName}」唯一最大的设置为:${uniqueSettings}。${interactionNote}`;
  const hasCenter = !isDemo && design!.coded.some((row) => row.every((value) => value === 0));
  const toggleModelTerm = (term: string, checked: boolean) => {
    if (!checked && selectedTerms.length <= 1) { showToast('模型至少保留 1 个效应项'); return; }
    setDoeModel({ doeModelTerms: checked ? [...selectedTerms, term] : selectedTerms.filter((name) => name !== term) });
  };
  const storeOutputs = () => {
    if (isDemo) return;
    try {
      const output = buildDoeWorksheetOutput(res);
      writeAnalysisColumns(output.numericColumns, output.textColumns);
      showToast('已写回工作表：拟合值、效应、残差、系数、标准化残差（按运行/模型项对齐）');
    } catch (error) {
      showToast(`写回失败：${(error as Error).message}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {picker}
      {!isDemo && (
        <Card style={{ padding: '12px 16px', fontSize: 12, color: '#5b6472' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: '#33404f' }}>模型项</span>
            {availableTerms.map((term) => (
              <label key={term} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedTerms.includes(term)} onChange={(event) => toggleModelTerm(term, event.target.checked)} />
                {term}
              </label>
            ))}
            {hasCenter && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', paddingLeft: 8, borderLeft: '1px solid #e2e5ea' }}>
                <input type="checkbox" checked={doeIncludeCurvature} onChange={(event) => setDoeModel({ doeIncludeCurvature: event.target.checked })} />
                中心点（曲率）
              </label>
            )}
            <span style={{ color: res.droppedTerms?.length ? '#b0620f' : '#2c8a45' }}>
              可估计 {res.terms.length}/{selectedTerms.length} 项
            </span>
            <button type="button" className="hov-act-primary" onClick={storeOutputs}
              style={{ marginLeft: 'auto', padding: '6px 12px', border: 0, borderRadius: 5, background: '#1f6fb2', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              将存储项写回工作表
            </button>
          </div>
          <div style={{ marginTop: 7, color: '#8a929d', lineHeight: 1.55 }}>
            拟合值、残差、标准化残差按当前工作表运行行对齐；效应与系数按「DOE模型项」列逐行对齐。再次写回会覆盖同名输出列，不会重复追加。
          </div>
        </Card>
      )}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid #edf0f3', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>
            {doeView === 'main' && `主效应图 · 响应 = ${respName}`}
            {doeView === 'interact' && `交互作用图 · ${factorNames[pa]} × ${factorNames[pb]}`}
            {doeView === 'pareto' && (effView === 'pareto'
              ? `${isT ? '标准化效应' : '效应'}帕累托 · ${isDemo ? 'Lenth 显著界限' : isT ? 't 临界线' : 'Lenth 显著界限'}`
              : effView === 'normal'
                ? '效应正态图 · 显著项红点标注'
                : '效应半正态图 · 显著项红点标注')}
            {doeView === 'cube' && `立方图 · ${k === 3 ? '8 顶点响应' : '仅 3 因子适用'}`}
          </div>
          {doeView === 'pareto' && (
            <div style={{ display: 'flex', gap: 6 }}>
              {([['pareto', '帕累托'], ['normal', '正态'], ['half', '半正态']] as const).map(([key, label]) => (
                <button type="button" key={key} aria-pressed={effView === key} style={tabStyle(effView === key)} onClick={() => setEffView(key)}>{label}</button>
              ))}
            </div>
          )}
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
              <button type="button" key={k2} aria-pressed={doeView === k2} style={tabStyle(doeView === k2)} onClick={() => setDoeView(k2)}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ padding: '16px 16px 8px' }}>
          {doeView === 'main' && <MainEffects T={T} factors={mainData} />}
          {doeView === 'interact' && <InteractionPlot T={T} {...interData} labelA={factorNames[pa]} labelB={factorNames[pb]} />}
          {doeView === 'pareto' && effView === 'pareto' && <EffectsBar T={T} terms={barTerms} refLine={barRef} />}
          {doeView === 'pareto' && effView !== 'pareto' && (
            <EffectsNormalPlot T={T} half={effView === 'half'}
              pse={res.pse ?? lenthPseFromEffects(res.terms.map((t) => t.effect))}
              terms={res.terms.map((t) => ({ name: t.name, effect: t.effect, sig: t.sig }))} />
          )}
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
          {!isDemo && res.block && (
            <div style={{ fontSize: 12, color: '#5b6472', lineHeight: 1.6, marginTop: 8, paddingTop: 8, borderTop: '1px dashed #eceff2' }}>
              <b>区组调整：</b>已将 {res.block.levels.length} 个区组（DF={res.block.df}）作为扰动项优先纳入模型；与区组生成元混杂的交互项不会被误报为工艺效应。
            </div>
          )}
          {!isDemo && res.curvature && (
            <div style={{ fontSize: 12, color: res.curvature.sig ? '#b0620f' : '#5b6472', lineHeight: 1.6, marginTop: 8, paddingTop: 8, borderTop: '1px dashed #eceff2' }}>
              <b>曲率(弯曲)检验:</b>{res.curvature.sig
                ? `显著(${res.curvature.p !== undefined ? (res.curvature.p < 0.001 ? 'p<0.001' : `p=${nf(res.curvature.p, 3)}`) : '—'})——中心点响应偏离角点线性预测,说明存在弯曲,宜升级为响应曲面(含二次项)设计。`
                : res.curvature.p !== undefined ? `不显著(p=${nf(res.curvature.p, 3)})——无明显弯曲,两水平线性模型足以描述当前区域。` : '中心点已纳入,但无残差自由度可供检验。'}
            </div>
          )}
          {!isDemo && res.droppedTerms && res.droppedTerms.length > 0 && (
            <div style={{ fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.6, marginTop: 8 }}>
              <b>别名/可估计性：</b>{res.aliases?.map((alias) =>
                alias.relation === 'same'
                  ? `${alias.term} = ${alias.with}`
                  : alias.relation === 'opposite'
                    ? `${alias.term} = −${alias.with}`
                    : `${alias.term} 与 ${alias.with} 线性相关`,
              ).join('；') ?? res.droppedTerms.join('、')}。这些项无法单独估计，已从模型剔除；可增加运行或减少模型项解除别名。
            </div>
          )}
        </Card>
      </div>

      {!isDemo && (() => {
        const eq = uncodedEquation(
          res,
          design!.factorNames.map((name, index) => ({ name, low: design!.levels[index].low, high: design!.levels[index].high })),
          respName,
        );
        return (
          <Card style={{ padding: 16 }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 8 }}>回归方程(未编码单位)</div>
            {eq ? (
              <div className="mono" style={{ fontSize: 13, color: '#2a333f', lineHeight: 1.7, wordBreak: 'break-all' }}>{eq.text}</div>
            ) : (
              <div style={{ fontSize: 12.5, color: '#8a6520', lineHeight: 1.6 }}>
                当前模型包含三因子及以上交互项:未编码方程本版只支持「常数 + 主效应 + 两因子交互 + Ct Pt」的乘积展开,暂不展示。
                可在上方「模型项」中去掉高阶交互后查看。
              </div>
            )}
            <div style={{ fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.6, marginTop: 8 }}>
              由编码系数(基于 −1/+1)按 x编码 = (x − 中心)/半量程 换算为实际单位;系数取 4 位有效数字。
              Ct Pt 为中心点指示项(中心点行=1、角点行=0),其系数不随单位变换。
              {res.block ? '区组系数已按各区组等权平均并入常数项。' : ''}
            </div>
          </Card>
        );
      })()}

      {!isDemo && (() => {
        // 残差类型:正规(观测−拟合)/ 标准化(已有)/ 删后(学生化删除);
        // 不可用的类型禁用并说明,当前选择不可用时向可用类型回落。
        const deleted = studentizedDeletedResiduals(res);
        const hasStd = res.stdResiduals != null;
        const type: 'raw' | 'std' | 'del' = residType === 'del' && deleted == null
          ? (hasStd ? 'std' : 'raw')
          : residType === 'std' && !hasStd ? 'raw' : residType;
        const rrAll = type === 'del' ? deleted! : type === 'std' ? res.stdResiduals! : res.residuals;
        const yl = type === 'del' ? '删后残差' : type === 'std' ? '标准化残差' : '残差';
        // 删后残差在 r²=ν 边界可为 ±∞;图形只画有限值,数量差单独说明
        const finiteRows = rrAll.map((value, row) => ({ value, row })).filter((p) => Number.isFinite(p.value));
        const rr = finiteRows.map((p) => p.value);
        const runOrder = finiteRows.map((p) => p.row + 1);
        const fitsF = finiteRows.map((p) => res.fits[p.row]);
        const infCount = rrAll.length - rr.length;
        const rf = Math.min(residFactorIdx, k - 1);
        const lv = design!.levels[rf];
        const factorVals = finiteRows.map((p) => {
          const c = design!.coded[p.row][rf];
          return c < 0 ? lv.low : c > 0 ? lv.high : lv.low / 2 + lv.high / 2;
        });
        const typeOptions: Array<{ key: 'raw' | 'std' | 'del'; label: string; why?: string }> = [
          { key: 'raw', label: '正规' },
          { key: 'std', label: '标准化', why: hasStd ? undefined : '饱和设计无残差自由度,无法标准化' },
          {
            key: 'del', label: '删后',
            why: deleted != null ? undefined
              : hasStd ? `删后残差需要残差自由度 ν≥2(当前 ν=${res.dfResid ?? 0})` : '饱和设计无残差自由度,无法计算删后残差',
          },
        ];
        const PANES: Array<['normal' | 'fits' | 'hist' | 'order', string]> = [
          ['normal', '正态图'], ['fits', 'vs 拟合值'], ['hist', '直方图'], ['order', 'vs 顺序'],
        ];
        const paneChart = (pane: 'normal' | 'fits' | 'hist' | 'order', height: number) =>
          pane === 'normal' ? <NormalProbPlot T={T} data={rr} h={height} />
            : pane === 'fits' ? <ScatterPlot T={T} xs={fitsF} ys={rr} slope={0} intercept={0} xLabel="拟合值" yLabel={yl} h={height} />
              : pane === 'hist' ? <MiniHist T={T} data={rr} h={height} xLabel={`${yl}分布`} />
                : <ScatterPlot T={T} xs={runOrder} ys={rr} slope={0} intercept={0} xLabel="运行序" yLabel={yl} h={height} />;
        return (
          <>
            <Card>
              <CardHeader title={residLayout === 'grid' ? '残差诊断(四合一)' : '残差诊断(单独放大)'}
                right={<span style={{ fontSize: 11.5, color: '#98a1ac' }}>{
                  type === 'del'
                    ? '删后残差 t = r·√((ν−1)/(ν−r²)),r 为标准化残差'
                    : type === 'std' ? '标准化残差 = 残差 /(s·√(1−杠杆))' : '残差 = 观测 − 模型拟合值'
                }</span>} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 0', flexWrap: 'wrap', fontSize: 12, color: '#5b6472' }}>
                <span style={{ fontWeight: 600, color: '#8a929d' }}>残差类型</span>
                {typeOptions.map((option) => (
                  <button type="button" key={option.key} disabled={option.why != null} title={option.why}
                    aria-pressed={type === option.key}
                    style={option.why != null ? { ...tabStyle(false), opacity: 0.45, cursor: 'not-allowed' } : tabStyle(type === option.key)}
                    onClick={() => setResidType(option.key)}>{option.label}</button>
                ))}
                <span style={{ fontWeight: 600, color: '#8a929d', marginLeft: 10 }}>布局</span>
                {([['grid', '四合一'], ['single', '单独']] as const).map(([key, label]) => (
                  <button type="button" key={key} aria-pressed={residLayout === key} style={tabStyle(residLayout === key)} onClick={() => setResidLayout(key)}>{label}</button>
                ))}
                {residLayout === 'single' && (
                  <div style={{ display: 'flex', gap: 6, marginLeft: 10 }}>
                    {PANES.map(([key, label]) => (
                      <button type="button" key={key} aria-pressed={residPane === key} style={tabStyle(residPane === key)} onClick={() => setResidPane(key)}>{label}</button>
                    ))}
                  </div>
                )}
                <span style={{ marginLeft: 'auto', color: '#98a1ac' }}>ν(残差自由度)= {res.dfResid ?? 0}</span>
              </div>
              {typeOptions.some((option) => option.why != null) && (
                <div style={{ padding: '6px 12px 0', fontSize: 11.5, color: '#9aa2ad' }}>
                  {typeOptions.filter((option) => option.why != null).map((option) => `${option.label}:${option.why}`).join('；')}
                </div>
              )}
              {infCount > 0 && (
                <div style={{ padding: '6px 12px 0', fontSize: 11.5, color: '#b0620f' }}>
                  有 {infCount} 个删后残差为 ±∞(删除该点后其余数据完美拟合),未绘出。
                </div>
              )}
              {rr.length === 0 ? (
                <div style={{ padding: 20, color: '#9aa2ad', fontSize: 12.5 }}>当前残差类型下没有可绘制的有限值。</div>
              ) : residLayout === 'grid' ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 12px 12px' }}>
                  {paneChart('normal', 220)}
                  {paneChart('fits', 220)}
                  {paneChart('hist', 220)}
                  {paneChart('order', 220)}
                </div>
              ) : (
                <div style={{ padding: '10px 12px 12px' }}>{paneChart(residPane, 320)}</div>
              )}
            </Card>
            <Card>
              <CardHeader title={`残差 vs 变量 · ${design!.factorNames[rf]}`}
                right={(
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6472', fontWeight: 400 }}>
                    因子
                    <select style={selStyle} value={rf} onChange={(e) => setResidFactorIdx(+e.target.value)}>
                      {design!.factorNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
                    </select>
                  </label>
                )} />
              <div style={{ padding: '10px 12px 12px' }}>
                {rr.length === 0
                  ? <div style={{ padding: 20, color: '#9aa2ad', fontSize: 12.5 }}>当前残差类型下没有可绘制的有限值。</div>
                  : <ScatterPlot T={T} xs={factorVals} ys={rr} slope={0} intercept={0} xLabel={`${design!.factorNames[rf]}(实际水平)`} yLabel={yl} h={240} />}
              </div>
            </Card>
          </>
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
/** 随机化种子默认值:沿用原实现的固定 LCG 种子,保证默认行为不变。 */
const DEFAULT_DOE_SEED = 20260713;

function CreateDesign() {
  const { importMatrix } = useData();
  const { goTo, showToast } = useApp();
  // 因子数改为手动数字输入:文本态允许自由编辑,实际生效值钳制在 2–4 并给出提示。
  const [kText, setKText] = useState('2');
  const [factors, setFactors] = useState<FactorDef[]>([
    { name: '过盈量', low: 0.045, high: 0.09 },
    { name: '轴硬度', low: 28, high: 32 },
    { name: '因子C', low: 0, high: 1 },
    { name: '因子D', low: 0, high: 1 },
  ]);
  const [center, setCenter] = useState(3);
  const [reps, setReps] = useState(1);
  const [blocks, setBlocks] = useState(1);
  const [randomize, setRandomize] = useState(true);
  const [seedText, setSeedText] = useState(String(DEFAULT_DOE_SEED));

  const parsedK = Number.parseInt(kText, 10);
  const kOutOfRange = !(Number.isInteger(parsedK) && parsedK >= 2 && parsedK <= 4);
  const k = Number.isInteger(parsedK) ? Math.max(2, Math.min(4, parsedK)) : 2;
  const parsedSeed = Number.parseInt(seedText, 10);
  const seed = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_DOE_SEED;

  const maxBlocks = 1 << (k - 1);
  const blocksEff = Math.min(blocks, maxBlocks);
  const runs = (1 << k) * reps + center * blocksEff;
  const setF = (i: number, patch: Partial<FactorDef>) =>
    setFactors((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const create = () => {
    const facs = factors.slice(0, k);
    if (facs.some((f) => !f.name.trim())) { showToast('请填写所有因子名'); return; }
    if (new Set(facs.map((f) => f.name.trim())).size !== facs.length) { showToast('因子名不能重复'); return; }
    if (facs.some((f) => !(f.low < f.high))) { showToast('每个因子必须满足低水平 < 高水平'); return; }
    const d = generateFactorialDesign(facs.map((f) => ({ name: f.name.trim(), low: f.low, high: f.high })),
      { centerPoints: center, replicates: reps, blocks: blocksEff, randomize, seed });
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
    const pending = d.rows.map((_, row) => ({ row, col: d.responseCol }));
    importMatrix(`DOE设计_${stamp}`, d.colNames, d.rows, d.textCols, pending);
    goTo('worksheet');
    showToast(`已生成 ${d.rows.length} 运行 / ${d.blockCount} 区组的因子设计（含标准序、运行序、区组、点类型），请录入响应后回 DOE→分析`);
  };

  const inp: React.CSSProperties = { ...numInput, width: 90 };
  return (
    <Card style={{ padding: '18px 20px' }}>
      <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 14 }}>创建两水平全因子设计</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12.5, color: '#5b6472', maxWidth: 620 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          因子数
          <input type="number" min={2} max={4} step={1} value={kText}
            onChange={(e) => setKText(e.target.value)} style={{ ...inp, width: 64 }} />
          <span style={{ color: '#8a929d' }}>({1 << k} 角点/仿行)</span>
          {kOutOfRange && <span style={{ color: '#b0620f', fontWeight: 600 }}>本版支持 2–4 因子</span>}
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
            每区组中心点数
            <input type="number" min={0} max={10} value={center} onChange={(e) => setCenter(Math.max(0, Math.min(10, parseInt(e.target.value) || 0)))} style={{ ...inp, width: 64 }} />
          </label>
          <label title="每个角点组合的完整重复运行次数;中心点数按「每区组中心点数」单独设置,不计入仿行" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            仿行数(角点重复)
            <input type="number" min={1} max={10} value={reps} onChange={(e) => setReps(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))} style={{ ...inp, width: 64 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            区组数
            <select style={selStyle} value={blocksEff} onChange={(e) => setBlocks(+e.target.value)}>
              {Array.from({ length: Math.log2(maxBlocks) + 1 }, (_, index) => 1 << index)
                .map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={randomize} onChange={(e) => setRandomize(e.target.checked)} /> 随机化运行序
          </label>
          <label title="随机化使用确定性 LCG 伪随机数:种子相同 → 打乱后的运行序完全相同,便于复现与审计;默认沿用平台固定种子" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            随机化种子
            <input type="number" value={seedText} onChange={(e) => setSeedText(e.target.value)} disabled={!randomize}
              style={{ ...inp, width: 100, ...(randomize ? {} : { opacity: 0.5 }) }} />
          </label>
          <span style={{ color: '#1c4e7a' }}>共 <b className="mono">{runs}</b> 次试验</span>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.6 }}>
          生成后进入工作表：标准序保留未随机化顺序，运行序为实际执行顺序，区组用 A×B、A×C…生成元保持主效应与区组可分离，
          点类型标明因子点/中心点；末列「响应(待录入)」逐行录入。中心点用于检验曲率并提供纯误差估计。
          随机化由确定性伪随机数(LCG)驱动，同一种子重新生成会得到完全相同的运行序。
        </div>
        <div>
          <button type="button" className="hov-act-primary" onClick={create}
            style={{ display: 'inline-block', padding: '9px 20px', border: 0, background: '#1f6fb2', color: '#fff', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 }}>
            生成设计表 → 工作表
          </button>
        </div>
      </div>
    </Card>
  );
}
