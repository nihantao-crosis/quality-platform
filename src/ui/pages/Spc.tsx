/** SPC 控制图 ★深度实现 — 七种图型（X̄-R/X̄-S/I-MR/EWMA/CUSUM/P/C），
 * Nelson 判异（Shewhart 图）/ 限值判异（EWMA/CUSUM）/ 点选明细 /
 * 分阶段控制限（按分组列分段,Minitab Stages 语义）。 */
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useApp, type SpcType } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { nf, evalRules, RULE_DEFS, ewmaSeries, cusumSeries, stagedXbar, stagedRange, splitStages, type RuleNo } from '../../core';
import { ReportCard } from '../ReportCard';
import { spcReport } from '../reportData';
import type { ChartTokens } from '../tokens';
import { Card, KvRows, tabStyle, chipStyle } from '../common';
import { ControlChart, type ControlChartProps } from '../charts/ControlChart';

const stageSelStyle: CSSProperties = {
  padding: '4px 8px', border: '1px solid #cfd5dd', borderRadius: 4,
  fontSize: 12, color: '#2a333f', background: '#fff', fontFamily: 'IBM Plex Mono,monospace',
};

interface ChartSpec {
  t: string;
  props: Omit<ControlChartProps, 'T' | 'violations' | 'sel' | 'onPoint' | 'ptLabel'>;
  main?: boolean;
  dec: number;
}

export function Spc({ T }: { T: ChartTokens }) {
  const { spcType, setSpcType, spcRules, toggleRule, selSub, setSelSub } = useApp();
  const { model: M, textCols, pModel, cModel, mesRunning } = useData();

  const means = M.subs.map((s) => s.mean);

  // 分阶段：选择一个文本列作为阶段变量（仅 X̄-R,需 ≥2 段）
  const [stageCol, setStageCol] = useState(-1); // -1 = 不分阶段
  const stageLabels = stageCol >= 0 && stageCol < textCols.length ? textCols[stageCol].values : null;
  const canStage = M.hasSubgroups && textCols.length > 0;
  const staged =
    stageLabels && stageLabels.length === M.k && splitStages(stageLabels).length >= 2 && M.hasSubgroups
      ? {
          x: stagedXbar(M.subs.map((s) => s.vals), stageLabels, spcRules),
          r: stagedRange(M.subs.map((s) => s.vals), stageLabels, spcRules),
        }
      : null;
  // EWMA/CUSUM 数据源：子组均值（σ/√n）或单值序列
  const advData = M.hasSubgroups ? means : M.indiv;
  const advMu = M.hasSubgroups ? M.xbarbar : M.indMean;
  const advSigma = M.hasSubgroups ? M.sigmaWithin / Math.sqrt(M.n) : M.iSig;
  const ewma = ewmaSeries(advData, advMu, advSigma);
  const cusum = cusumSeries(advData, advMu, advSigma, 0.5, M.hasSubgroups ? 4 : 5);

  type SpecDef = {
    sub: string;
    charts: ChartSpec[];
    disabled?: boolean;
    shewhart: boolean; // Nelson 准则是否适用
    coreViol?: Set<number>; // 由 core 直接给出（EWMA/CUSUM/分阶段）
    coreList?: { i: number; rule: number; desc: string }[];
  };

  const specs: Record<SpcType, SpecDef> = {
    'xbar-r': {
      sub: staged
        ? `分阶段 · ${staged.x.segments.length} 段（按「${textCols[stageCol]?.name}」）· n = ${M.n}`
        : `子组大小 n = ${M.n} · 均值-极差`,
      disabled: !M.hasSubgroups,
      shewhart: true,
      coreViol: staged ? staged.x.viol : undefined,
      coreList: staged ? staged.x.list : undefined,
      charts: staged
        ? [
            {
              t: `均值控制图 (X̄) · 分阶段`, main: true, dec: 3,
              props: {
                data: means, cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, clLabel: 'X̄', h: 250,
                clSeries: staged.x.clSeries, uclSeries: staged.x.uclSeries, lclSeries: staged.x.lclSeries,
                stepSeries: true, stageBoundaries: staged.x.boundaries,
                stageLabels: staged.x.segments.map((sg) => ({ at: Math.round((sg.start + sg.end) / 2), label: sg.label })),
              },
            },
            {
              t: '极差控制图 (R) · 分阶段', dec: 3,
              props: {
                data: M.subs.map((s) => s.range), cl: M.rbar, ucl: M.uclR, lcl: M.lclR, clLabel: 'R̄', h: 210,
                clSeries: staged.r.clSeries, uclSeries: staged.r.uclSeries, lclSeries: staged.r.lclSeries,
                stepSeries: true, stageBoundaries: staged.r.boundaries,
              },
            },
          ]
        : [
            { t: '均值控制图 (X̄)', main: true, dec: 3, props: { data: means, cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, clLabel: 'X̄', zones: true, h: 250 } },
            { t: '极差控制图 (R)', dec: 3, props: { data: M.subs.map((s) => s.range), cl: M.rbar, ucl: M.uclR, lcl: M.lclR, clLabel: 'R̄', h: 210 } },
          ],
    },
    'xbar-s': {
      sub: `子组大小 n = ${M.n} · 均值-标准差`,
      disabled: !M.hasSubgroups,
      shewhart: true,
      charts: [
        { t: '均值控制图 (X̄)', main: true, dec: 3, props: { data: means, cl: M.xbarbar, ucl: M.uclXs, lcl: M.lclXs, clLabel: 'X̄', zones: true, h: 250 } },
        { t: '标准差控制图 (S)', dec: 4, props: { data: M.svals, cl: M.sbar, ucl: M.uclS, lcl: M.lclS, clLabel: 'S̄', h: 210 } },
      ],
    },
    'i-mr': {
      sub: M.isDemo ? '单值 - 移动极差 · 演示序列' : '单值 - 移动极差 · 全部观测',
      shewhart: true,
      charts: [
        { t: '单值控制图 (I)', main: true, dec: 3, props: { data: M.indiv, cl: M.indMean, ucl: M.iUcl, lcl: M.iLcl, clLabel: 'X̄', zones: true, h: 250 } },
        { t: '移动极差图 (MR)', dec: 3, props: { data: M.mr.slice(1) as number[], cl: M.mrbar, ucl: M.mrUcl, lcl: 0, clLabel: 'MR̄', h: 210 } },
      ],
    },
    ewma: {
      sub: `EWMA · λ=0.2, L=2.7 · 对小漂移敏感`,
      shewhart: false,
      coreViol: ewma.viol,
      charts: [
        { t: 'EWMA 控制图（指数加权移动平均）', main: true, dec: 4, props: { data: ewma.z, cl: ewma.cl, ucl: ewma.ucl[ewma.ucl.length - 1], lcl: ewma.lcl[ewma.lcl.length - 1], uclSeries: ewma.ucl, lclSeries: ewma.lcl, clLabel: 'μ₀', h: 300 } },
      ],
    },
    cusum: {
      sub: `CUSUM · k=0.5, h=${M.hasSubgroups ? 4 : 5} · 累积和`,
      shewhart: false,
      coreViol: cusum.viol,
      charts: [
        { t: 'CUSUM 控制图（C⁺ 蓝 / C⁻ 品红）', main: true, dec: 4, props: { data: cusum.cp, series2: cusum.cn, series2Label: 'C⁻', cl: 0, ucl: cusum.H, lcl: 0, clLabel: '0', h: 300 } },
      ],
    },
    p: {
      sub: `不良率 · 样本量 n = ${pModel.pN} · ${pModel.isDemo ? '演示数据' : pModel.name}`,
      shewhart: true,
      charts: [
        { t: `不良率控制图 (P) · ${pModel.name}`, main: true, dec: 3, props: { data: pModel.pprop, cl: pModel.pbar, ucl: pModel.pUcl, lcl: pModel.pLcl, clLabel: 'p̄', zones: true, h: 300 } },
      ],
    },
    c: {
      sub: `单位缺陷数 · ${cModel.isDemo ? '演示数据' : cModel.name}`,
      shewhart: true,
      charts: [
        { t: `缺陷数控制图 (C) · ${cModel.name}`, main: true, dec: 1, props: { data: cModel.cdata, cl: cModel.cbar, ucl: cModel.cUcl, lcl: cModel.cLcl, clLabel: 'c̄', zones: true, h: 300 } },
      ],
    },
  };

  const effType: SpcType = specs[spcType].disabled ? 'i-mr' : spcType;
  const spec = specs[effType];
  const main = spec.charts.find((c) => c.main)!;

  let viol: Set<number>;
  let violList: { i: number; rule: number; desc: string }[];
  if (spec.coreViol && spec.coreList) {
    // 分阶段：判异已在段内完成
    viol = spec.coreViol;
    violList = spec.coreList;
  } else if (spec.shewhart) {
    const sig = (main.props.ucl - main.props.cl) / 3;
    const r = evalRules(main.props.data, main.props.cl, sig, spcRules);
    viol = r.viol;
    violList = r.list;
  } else {
    viol = spec.coreViol!;
    violList = [...viol].sort((a, b) => a - b).map((i) => ({
      i,
      rule: 1,
      desc: effType === 'ewma' ? 'EWMA 超出时变控制限' : '累积和超出判定限 H',
    }));
  }

  // 离散图(R/S/MR)判异——准则 1:点超出各自控制限。反馈要求"先看极差图":极差失控会使
  // X̄ 控制限失真,故极差/标准差图也须判异、显示红点并计入检验结果(而非仅绘制不检测)。
  // 分阶段模式下用段内判异结果 staged.r(否则会因固定控制限而漏判/误判)。
  const dispViolByChart = new Map<string, Set<number>>();
  const dispItems: { i: number; rule: number; desc: string; chartLabel: string }[] = [];
  if (spec.shewhart) {
    for (const ch of spec.charts) {
      if (ch.main) continue;
      const clLabel = ch.props.clLabel ?? '离散';
      if (staged && effType === 'xbar-r') {
        // 分阶段极差图:采用段内准则判异(否则整段被跳过、极差失控不显示)
        if (staged.r.viol.size) {
          dispViolByChart.set(ch.t, staged.r.viol);
          staged.r.list.forEach((o) => dispItems.push({ i: o.i, rule: o.rule, desc: `${clLabel} 图:${o.desc}`, chartLabel: clLabel }));
        }
      } else if (!spec.coreViol && ch.props.ucl != null) {
        const { ucl, lcl, data: cdata } = ch.props;
        const dv = new Set<number>();
        (cdata as number[]).forEach((v, i) => {
          if (v > ucl || (lcl != null && v < lcl)) dv.add(i);
        });
        if (dv.size) {
          dispViolByChart.set(ch.t, dv);
          [...dv].sort((a, b) => a - b).forEach((i) =>
            dispItems.push({ i, rule: 1, desc: `${clLabel} 图点超出控制限`, chartLabel: clLabel }));
        }
      }
    }
  }
  const allViolItems = [
    ...violList.map((o) => ({ ...o, chartLabel: '' })),
    ...dispItems,
  ];

  const sel = selSub != null && selSub < main.props.data.length ? selSub : null;
  const labWord = { 'xbar-r': '子组', 'xbar-s': '子组', 'i-mr': '观测', ewma: '点', cusum: '点', p: '样本', c: '单位' }[effType];
  const ptLab = (i: number) => labWord + ' ' + (i + 1);

  const stats: { k: string; v: string }[] = [];
  if (effType === 'ewma') {
    stats.push(
      { k: '中心线 μ₀', v: nf(ewma.cl, 4) },
      { k: 'UCL（末端）', v: nf(ewma.ucl[ewma.ucl.length - 1], 4) },
      { k: 'LCL（末端）', v: nf(ewma.lcl[ewma.lcl.length - 1], 4) },
      { k: 'λ / L', v: '0.2 / 2.7' },
      { k: '点数', v: String(advData.length) },
    );
  } else if (effType === 'cusum') {
    stats.push(
      { k: '判定限 H', v: nf(cusum.H, 4) },
      { k: '允差 K', v: nf(cusum.K, 4) },
      { k: 'C⁺ 末值', v: nf(cusum.cp[cusum.cp.length - 1], 4) },
      { k: 'C⁻ 末值', v: nf(cusum.cn[cusum.cn.length - 1], 4) },
      { k: '点数', v: String(advData.length) },
    );
  } else {
    stats.push(
      { k: '中心线 ' + (main.props.clLabel ?? 'CL'), v: nf(main.props.cl, main.dec) },
      { k: 'UCL', v: nf(main.props.ucl, main.dec) },
      { k: 'LCL', v: nf(main.props.lcl, main.dec) },
    );
    if (effType === 'xbar-r' && staged) {
      stats.length = 0;
      staged.x.segments.forEach((sg) => {
        stats.push({ k: `「${sg.label}」CL·UCL·LCL`, v: `${nf(sg.cl, 3)} / ${nf(sg.ucl, 3)} / ${nf(sg.lcl, 3)}` });
      });
      stats.push({ k: '段数', v: String(staged.x.segments.length) }, { k: '子组数', v: String(M.k) });
    } else if (effType === 'xbar-r') stats.push({ k: 'R̄', v: nf(M.rbar, 3) }, { k: 'σ̂ 组内', v: nf(M.sigmaWithin, 4) }, { k: '子组数', v: String(M.k) });
    else if (effType === 'xbar-s') stats.push({ k: 'S̄', v: nf(M.sbar, 4) }, { k: 'σ̂ (S̄/c₄)', v: nf(M.sbar / M.c4, 4) }, { k: '子组数', v: String(M.k) });
    else if (effType === 'i-mr') stats.push({ k: 'MR̄', v: nf(M.mrbar, 3) }, { k: 'σ̂ (MR̄/d₂)', v: nf(M.iSig, 4) }, { k: '观测数', v: String(M.indiv.length) });
    else if (effType === 'p') stats.push({ k: 'p̄', v: nf(pModel.pbar, 4) }, { k: '样本量 n', v: String(pModel.pN) }, { k: '样本数', v: String(pModel.pprop.length) });
    else stats.push({ k: 'c̄', v: nf(cModel.cbar, 3) }, { k: '单位数', v: String(cModel.cdata.length) });
  }

  let subRows: { k: string; v: string }[] = [];
  if (sel != null) {
    if (effType === 'xbar-r' || effType === 'xbar-s') {
      const sg = M.subs[sel];
      subRows = sg.vals.map((v, j) => ({ k: '测量 ' + (j + 1), v: nf(v, 3) }));
      subRows.push({ k: '均值', v: nf(sg.mean, 3) }, { k: '极差', v: nf(sg.range, 3) }, { k: '标准差', v: nf(M.svals[sel], 4) });
    } else if (effType === 'i-mr') {
      subRows = [{ k: '观测值', v: nf(M.indiv[sel], 3) }];
      if (sel > 0) subRows.push({ k: '移动极差', v: nf(M.mr[sel] as number, 3) });
    } else if (effType === 'ewma') {
      subRows = [
        { k: '原始值', v: nf(advData[sel], 4) },
        { k: 'EWMA z', v: nf(ewma.z[sel], 4) },
        { k: 'UCL / LCL', v: nf(ewma.ucl[sel], 4) + ' / ' + nf(ewma.lcl[sel], 4) },
      ];
    } else if (effType === 'cusum') {
      subRows = [
        { k: '原始值', v: nf(advData[sel], 4) },
        { k: 'C⁺', v: nf(cusum.cp[sel], 4) },
        { k: 'C⁻', v: nf(cusum.cn[sel], 4) },
        { k: '判定限 H', v: nf(cusum.H, 4) },
      ];
    } else if (effType === 'p') {
      subRows = [
        { k: '不良数', v: String(pModel.pdef[sel]) },
        { k: '样本量', v: String(pModel.pN) },
        { k: '不良率', v: nf(pModel.pprop[sel], 3) },
      ];
    } else {
      subRows = [{ k: '缺陷数', v: String(cModel.cdata[sel]) }];
    }
  }
  const selBad = sel != null && viol.has(sel);

  const typeTabs: Array<[SpcType, string]> = [
    ['xbar-r', 'X̄-R'], ['xbar-s', 'X̄-S'], ['i-mr', 'I-MR'],
    ['ewma', 'EWMA'], ['cusum', 'CUSUM'], ['p', 'P 图'], ['c', 'C 图'],
  ];
  const ruleToggles = (['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'] as const).map((k) => [k, `准则 ${k.slice(1)}`] as const);

  const report = spcReport({
    violList,
    k: main.props.data.length,
    n: M.n,
    hasSubgroups: M.hasSubgroups,
    typeLabel: typeTabs.find(([k]) => k === effType)?.[1] ?? effType,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ReportCard data={report} />
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>控制图类型</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {typeTabs.map(([k, l]) => {
            const off = specs[k].disabled;
            return (
              <div
                key={k}
                title={off ? '单列数据无子组，不可用' : undefined}
                style={{ ...tabStyle(effType === k), ...(off ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                onClick={() => !off && setSpcType(k)}
              >
                {l}
              </div>
            );
          })}
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        {spec.shewhart ? (
          <>
            <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>判异准则</span>
            <div style={{ display: 'flex', gap: 7 }}>
              {ruleToggles.map(([k, l]) => {
                const d = RULE_DEFS[Number(k.slice(1)) as RuleNo];
                return (
                  <div key={k} style={chipStyle(spcRules[k])} onClick={() => toggleRule(k)} title={`${d.def}(${d.points})· ${d.source}`}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: spcRules[k] ? '#1f6fb2' : '#c8cfd8' }} />
                    {l}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <span style={{ fontSize: 12, color: '#9aa2ad' }}>判异：超出控制限（Nelson 准则不适用）</span>
        )}
        {canStage && effType === 'xbar-r' && (
          <>
            <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
            <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>分阶段</span>
            <select style={stageSelStyle} value={stageCol} onChange={(e) => { setStageCol(+e.target.value); setSelSub(null); }}>
              <option value={-1}>不分阶段</option>
              {textCols.map((c, i) => <option key={c.name} value={i}>按 {c.name}</option>)}
            </select>
            {stageCol >= 0 && !staged && (
              <span style={{ fontSize: 11.5, color: '#d98324' }}>该列只有 1 个连续段,无法分阶段</span>
            )}
          </>
        )}
        {mesRunning && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#1f6fb2', fontWeight: 600 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#1f6fb2', animation: 'qmPulse 1s infinite' }} />
            MES 采集中
          </span>
        )}
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>{spec.sub}</span>
      </Card>

      {spec.shewhart && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 22px', padding: '7px 16px', background: '#fbfcfd', border: '1px solid #e6e9ee', borderRadius: 5, fontSize: 11.5, color: '#7a828d', lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700, color: '#98a1ac' }}>判异准则说明</span>
          {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n) => (
            <span key={n}>
              <b style={{ color: '#5b6472' }}>{RULE_DEFS[n].name}</b>:{RULE_DEFS[n].def}({RULE_DEFS[n].points})
            </span>
          ))}
          <span style={{ color: '#a3abb5' }}>依据:Nelson (1984) / Minitab 特殊原因检验 1–8</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {spec.charts.map((ch) => (
            <Card key={ch.t}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
                <div style={{ fontWeight: 600, color: '#33404f' }}>{ch.t}</div>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: '#a3abb5' }}>点击数据点查看明细</div>
              </div>
              <div style={{ padding: '8px 14px 4px' }}>
                <ControlChart
                  T={T}
                  {...ch.props}
                  dec={ch.dec}
                  violations={ch.main ? viol : dispViolByChart.get(ch.t)}
                  sel={ch.main ? sel : null}
                  onPoint={ch.main ? (i) => setSelSub(i) : undefined}
                  ptLabel={ptLab}
                />
              </div>
            </Card>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {sel != null && (
            <div style={{ background: '#fff', border: '1px solid #cfe0f0', borderRadius: 5, padding: '14px 16px', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 600, color: '#1f6fb2' }}>{ptLab(sel)}</div>
                <div style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, background: selBad ? '#fdecec' : '#e8f4ea', color: selBad ? '#c22f2f' : '#2c8a45' }}>
                  {selBad ? '失控点' : '受控'}
                </div>
              </div>
              <KvRows rows={subRows} />
              {(effType === 'xbar-r' || effType === 'xbar-s' || effType === 'i-mr') && (
                <div
                  onClick={() => useApp.getState().goTo('worksheet')}
                  style={{ marginTop: 10, padding: '6px 0', textAlign: 'center', border: '1px solid #bcd6ee', color: '#1f6fb2', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  在工作表中查看此行 →
                </div>
              )}
            </div>
          )}
          <Card style={{ padding: '15px 16px' }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>控制限与参数</div>
            <KvRows rows={stats} />
          </Card>
          <div style={{ background: '#fff', border: '1px solid #f0d3d3', borderRadius: 5, padding: '15px 16px', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
            <div style={{ fontWeight: 600, color: '#c22f2f', marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              检验结果
              <span className="mono" style={{ marginLeft: 8, background: '#e23b3b', color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>{allViolItems.length}</span>
            </div>
            {allViolItems.length === 0 && (
              <div style={{ padding: '8px 0', fontSize: 12.5, color: '#2c8a45', fontWeight: 500 }}>✓ 未检出失控点，过程受控</div>
            )}
            {allViolItems.slice(0, 12).map((o) => (
              <div key={(o.chartLabel || 'main') + '-' + o.rule + '-' + o.i} style={{ padding: '8px 0', borderTop: '1px solid #f6eaea', fontSize: 12.5 }}>
                <div style={{ color: '#c22f2f', fontWeight: 600 }}>{o.chartLabel ? `${o.chartLabel} 图 · ` : ''}点 {o.i + 1}{spec.shewhart ? ` · 准则 ${o.rule}` : ''}</div>
                <div style={{ color: '#8a929d', marginTop: 2 }}>{o.desc}</div>
              </div>
            ))}
            {allViolItems.length > 12 && (
              <div style={{ padding: '8px 0', fontSize: 12, color: '#9aa2ad' }}>… 共 {allViolItems.length} 项</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
