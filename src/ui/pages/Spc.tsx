/** SPC 控制图 ★深度实现 — 七种图型（X̄-R/X̄-S/I-MR/EWMA/CUSUM/P/C），
 * Nelson 判异（Shewhart 图）/ 限值判异（EWMA/CUSUM）/ 点选明细 /
 * 分阶段控制限（按分组列分段,Minitab Stages 语义）。 */
import type { CSSProperties } from 'react';
import { useApp, type SpcType } from '../../store/appStore';
import { syncSpecForActiveMeasurement, useData } from '../../store/dataStore';
import { expandSpcRuleItems, uniqueSpcPointCount, type SpcViolationItem } from '../../store/analyses';
import {
  nf, evalRules, evalLimitedRules, RULE_DEFS, ewmaSeries, cusumSeries, stagedXbar, stagedRange, stageValidationError,
  prepareSpcData, spcMeasurementColumnNames, spcRoleOptions,
  type RuleNo, type SpcDataLayout, type SpcPreparedData, type VarModel, type TextColumn,
} from '../../core';
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

const LAYOUT_OPTIONS: Array<[SpcDataLayout, string]> = [
  ['auto', '自动识别（推荐）'],
  ['rows', '行式子组：一行一个子组'],
  ['stacked', '堆叠：测量值列 + 子组 ID'],
  ['columns', '列式子组：一列一个子组'],
  ['individuals', '单值列：I-MR'],
];

function SpcRolePanel({
  model, textCols, prepared, layout, valueColumn, subgroupColumn, onRoles, onTranspose,
}: {
  model: VarModel;
  textCols: TextColumn[];
  prepared: SpcPreparedData;
  layout: SpcDataLayout;
  valueColumn: string | null;
  subgroupColumn: string | null;
  onRoles: (patch: Partial<{ spcDataLayout: SpcDataLayout; spcValueCol: string | null; spcSubgroupCol: string | null }>) => void;
  onTranspose: () => void;
}) {
  const roles = spcRoleOptions(model, textCols);
  const measurementColumns = spcMeasurementColumnNames(model);
  return (
    <Card style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#687382', fontWeight: 700 }}>SPC 数据角色</span>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6472' }}>
        布局
        <select style={stageSelStyle} value={layout} onChange={(e) => onRoles({ spcDataLayout: e.target.value as SpcDataLayout })}>
          {LAYOUT_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6472' }}>
        测量值列
        <select style={stageSelStyle} value={valueColumn ?? ''} onChange={(e) => onRoles({ spcValueCol: e.target.value || null })}>
          <option value="">自动 / 不适用</option>
          {measurementColumns.map((name, i) => <option key={name + i} value={name}>{name}</option>)}
        </select>
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5b6472' }}>
        子组 ID / 点标签
        <select style={stageSelStyle} value={subgroupColumn ?? ''} onChange={(e) => onRoles({ spcSubgroupCol: e.target.value || null })}>
          <option value="">自动 / 无</option>
          {roles.map((r, i) => <option key={r.ref + i} value={r.ref}>{r.name}（{r.kind === 'numeric' ? '数值' : '文本'}）</option>)}
        </select>
      </label>
      {prepared.layout === 'columns' && !prepared.error && (
        <button type="button" onClick={onTranspose} style={{ ...stageSelStyle, cursor: 'pointer', color: '#1f6fb2', borderColor: '#bcd6ee', fontWeight: 600 }}>
          转为行式工作表
        </button>
      )}
      <div style={{ flexBasis: '100%', fontSize: 11.5, lineHeight: 1.55, color: prepared.error ? '#c22f2f' : '#6f7885' }}>
        {prepared.error
          ? `角色配置错误：${prepared.error}`
          : `${layout === 'auto' ? `自动识别为「${prepared.layoutLabel}」。` : ''}${prepared.note}；变量：${prepared.variableName}`}
      </div>
    </Card>
  );
}

export function Spc({ T }: { T: ChartTokens }) {
  const {
    spcType, setSpcType, spcRules, toggleRule,
    spcDataLayout, spcValueCol, spcSubgroupCol, setSpcRoles,
    spcStageCol, setSpcStageCol, selSub, setSelSub, showToast,
  } = useApp();
  const { model: rawModel, textCols: rawTextCols, pendingCells, pModel, cModel, mesRunning, transposeDataset } = useData();
  const prepared = prepareSpcData(rawModel, rawTextCols, {
    layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
    pendingCells,
  });
  const setRolesAndSyncSpec = (patch: Partial<{
    spcDataLayout: SpcDataLayout; spcValueCol: string | null; spcSubgroupCol: string | null;
  }>) => {
    setSpcRoles(patch);
    syncSpecForActiveMeasurement();
  };
  const rolePanel = (
    <SpcRolePanel
      model={rawModel} textCols={rawTextCols} prepared={prepared}
      layout={spcDataLayout} valueColumn={spcValueCol} subgroupColumn={spcSubgroupCol}
      onRoles={setRolesAndSyncSpec}
      onTranspose={() => {
        try {
          transposeDataset(prepared.subgroupLabels);
          setRolesAndSyncSpec({ spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: 'text:原列子组' });
          showToast('已转为行式子组工作表；原列名已保留为子组标签');
        } catch (e) { showToast((e as Error).message); }
      }}
    />
  );
  if (prepared.error && spcType !== 'p' && spcType !== 'c') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rolePanel}
        <Card style={{ padding: 24, borderColor: '#f0caca', color: '#a62b2b', lineHeight: 1.7 }}>
          <b>控制图未运行：</b>{prepared.error}<br />
          请在上方明确选择数据布局、测量值列和子组 ID。系统不会回退到“把所有数值列都当测量值”的旧口径。
        </Card>
      </div>
    );
  }
  const M = prepared.model ?? rawModel;
  const textCols = prepared.textCols;

  const means = M.subs.map((s) => s.mean);
  const subgroupLabels = prepared.subgroupLabels;
  const labelsFor = (length: number) => subgroupLabels.length === length ? subgroupLabels : undefined;

  // 分阶段：选择一个文本列作为阶段变量（仅 X̄-R,需 ≥2 段）
  const stageCol = spcStageCol == null ? -1 : textCols.findIndex((c) => c.name === spcStageCol);
  const stageLabels = stageCol >= 0 && stageCol < textCols.length ? textCols[stageCol].values : null;
  const canStage = M.hasSubgroups && textCols.length > 0;
  const stageError = stageLabels ? stageValidationError(stageLabels, M.k) : null;
  const staged =
    stageLabels && !stageError && M.hasSubgroups
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
  const variableName = prepared.variableName;
  const groupXLabel = prepared.xAxisLabel;
  const groupPointLabels = labelsFor(M.k);
  const indivPointLabels = labelsFor(M.indiv.length);
  const pMinN = pModel.pNs.reduce((value, n) => Math.min(value, n), Number.POSITIVE_INFINITY);
  const pMaxN = pModel.pNs.reduce((value, n) => Math.max(value, n), Number.NEGATIVE_INFINITY);
  const pMinUcl = pModel.pUcls.reduce((value, limit) => Math.min(value, limit), Number.POSITIVE_INFINITY);
  const pMaxUcl = pModel.pUcls.reduce((value, limit) => Math.max(value, limit), Number.NEGATIVE_INFINITY);
  const pMinLcl = pModel.pLcls.reduce((value, limit) => Math.min(value, limit), Number.POSITIVE_INFINITY);
  const pMaxLcl = pModel.pLcls.reduce((value, limit) => Math.max(value, limit), Number.NEGATIVE_INFINITY);
  const pNLabel = pModel.pVariableN ? `${pMinN}–${pMaxN}（逐批变化）` : String(pModel.pN);

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
        : stageCol >= 0 && stageError
          ? `分阶段未运行：${stageError}`
          : `子组大小 n = ${M.n} · 均值-极差`,
      disabled: !M.hasSubgroups,
      shewhart: true,
      coreViol: staged ? staged.x.viol : undefined,
      coreList: staged ? staged.x.list : undefined,
      charts: staged
        ? [
            {
              t: `${variableName} 的均值控制图 (X̄) · 分阶段`, main: true, dec: 3,
              props: {
                data: means, cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, clLabel: 'X̄', h: 250,
                xLabel: groupXLabel, yLabel: `${variableName} · 子组均值`, xLabels: groupPointLabels,
                clSeries: staged.x.clSeries, uclSeries: staged.x.uclSeries, lclSeries: staged.x.lclSeries,
                stepSeries: true, stageBoundaries: staged.x.boundaries,
                stageLabels: staged.x.segments.map((sg) => ({ at: Math.round((sg.start + sg.end) / 2), label: sg.label })),
              },
            },
            {
              t: `${variableName} 的极差控制图 (R) · 分阶段`, dec: 3,
              props: {
                data: M.subs.map((s) => s.range), cl: M.rbar, ucl: M.uclR, lcl: M.lclR, clLabel: 'R̄', h: 210,
                xLabel: groupXLabel, yLabel: `${variableName} · 子组极差`, xLabels: groupPointLabels,
                clSeries: staged.r.clSeries, uclSeries: staged.r.uclSeries, lclSeries: staged.r.lclSeries,
                stepSeries: true, stageBoundaries: staged.r.boundaries,
              },
            },
          ]
        : [
            { t: `${variableName} 的均值控制图 (X̄)`, main: true, dec: 3, props: { data: means, cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, clLabel: 'X̄', zones: true, h: 250, xLabel: groupXLabel, yLabel: `${variableName} · 子组均值`, xLabels: groupPointLabels } },
            { t: `${variableName} 的极差控制图 (R)`, dec: 3, props: { data: M.subs.map((s) => s.range), cl: M.rbar, ucl: M.uclR, lcl: M.lclR, clLabel: 'R̄', h: 210, xLabel: groupXLabel, yLabel: `${variableName} · 子组极差`, xLabels: groupPointLabels } },
          ],
    },
    'xbar-s': {
      sub: `子组大小 n = ${M.n} · 均值-标准差`,
      disabled: !M.hasSubgroups,
      shewhart: true,
      charts: [
        { t: `${variableName} 的均值控制图 (X̄)`, main: true, dec: 3, props: { data: means, cl: M.xbarbar, ucl: M.uclXs, lcl: M.lclXs, clLabel: 'X̄', zones: true, h: 250, xLabel: groupXLabel, yLabel: `${variableName} · 子组均值`, xLabels: groupPointLabels } },
        { t: `${variableName} 的标准差控制图 (S)`, dec: 4, props: { data: M.svals, cl: M.sbar, ucl: M.uclS, lcl: M.lclS, clLabel: 'S̄', h: 210, xLabel: groupXLabel, yLabel: `${variableName} · 子组标准差`, xLabels: groupPointLabels } },
      ],
    },
    'i-mr': {
      sub: M.isDemo ? '单值 - 移动极差 · 演示序列' : '单值 - 移动极差 · 全部观测',
      shewhart: true,
      charts: [
        { t: `${variableName} 的单值控制图 (I)`, main: true, dec: 3, props: { data: M.indiv, cl: M.indMean, ucl: M.iUcl, lcl: M.iLcl, clLabel: 'X̄', zones: true, h: 250, xLabel: prepared.layout === 'individuals' ? groupXLabel : '观测序号', yLabel: `${variableName} · 单值`, xLabels: indivPointLabels } },
        { t: `${variableName} 的移动极差图 (MR)`, dec: 3, props: { data: M.mr.slice(1) as number[], cl: M.mrbar, ucl: M.mrUcl, lcl: 0, clLabel: 'MR̄', h: 210, xIndexOffset: 1, xLabel: prepared.layout === 'individuals' ? groupXLabel : '观测序号（MR 从第 2 个观测开始）', yLabel: `${variableName} · 移动极差`, xLabels: indivPointLabels?.slice(1) } },
      ],
    },
    ewma: {
      sub: `EWMA · λ=0.2, L=2.7 · 对小漂移敏感`,
      shewhart: false,
      coreViol: ewma.viol,
      charts: [
        { t: `${variableName} 的 EWMA 控制图（指数加权移动平均）`, main: true, dec: 4, props: { data: ewma.z, cl: ewma.cl, ucl: ewma.ucl[ewma.ucl.length - 1], lcl: ewma.lcl[ewma.lcl.length - 1], uclSeries: ewma.ucl, lclSeries: ewma.lcl, clLabel: 'μ₀', h: 300, xLabel: M.hasSubgroups ? groupXLabel : '观测序号', yLabel: `${variableName} · EWMA`, xLabels: labelsFor(advData.length) } },
      ],
    },
    cusum: {
      sub: `CUSUM · k=0.5, h=${M.hasSubgroups ? 4 : 5} · 累积和`,
      shewhart: false,
      coreViol: cusum.viol,
      charts: [
        { t: `${variableName} 的 CUSUM 控制图（C⁺ 蓝 / C⁻ 品红）`, main: true, dec: 4, props: { data: cusum.cp, series2: cusum.cn, series2Label: 'C⁻', cl: 0, ucl: cusum.H, lcl: 0, clLabel: '0', h: 300, xLabel: M.hasSubgroups ? groupXLabel : '观测序号', yLabel: `${variableName} · 累积和`, xLabels: labelsFor(advData.length) } },
      ],
    },
    p: {
      sub: `不良率 · 样本量 n = ${pNLabel} · ${pModel.isDemo ? '演示数据' : pModel.name}`,
      shewhart: true,
      charts: [
        {
          t: `不良率控制图 (P) · ${pModel.name}`, main: true, dec: 3,
          props: {
            data: pModel.pprop, cl: pModel.pbar, ucl: pModel.pUcl, lcl: pModel.pLcl, clLabel: 'p̄',
            zones: !pModel.pVariableN,
            uclSeries: pModel.pVariableN ? pModel.pUcls : undefined,
            lclSeries: pModel.pVariableN ? pModel.pLcls : undefined,
            h: 300, xLabel: '样本序号', yLabel: '样本不良率',
          },
        },
      ],
    },
    c: {
      sub: `单位缺陷数 · ${cModel.isDemo ? '演示数据' : cModel.name}`,
      shewhart: true,
      charts: [
        { t: `缺陷数控制图 (C) · ${cModel.name}`, main: true, dec: 1, props: { data: cModel.cdata, cl: cModel.cbar, ucl: cModel.cUcl, lcl: cModel.cLcl, clLabel: 'c̄', zones: true, h: 300, xLabel: '检验单位序号', yLabel: '单位缺陷数' } },
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
    const r = effType === 'p'
      ? evalLimitedRules(main.props.data, main.props.cl, pModel.pUcls, pModel.pLcls, spcRules)
      : effType === 'c'
        ? evalLimitedRules(main.props.data, main.props.cl, main.props.ucl, main.props.lcl, spcRules)
      : evalRules(main.props.data, main.props.cl, (main.props.ucl - main.props.cl) / 3, spcRules);
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

  // 离散图(R/S/MR)按其适用的准则 1–4 判异。反馈要求"先看极差图":极差失控会使
  // X̄ 控制限失去解释前提,故离散图须显示完整适用信号并计入结论。
  // 分阶段模式下用段内判异结果 staged.r(否则会因固定控制限而漏判/误判)。
  const dispViolByChart = new Map<string, Set<number>>();
  const dispItems: SpcViolationItem[] = [];
  if (spec.shewhart) {
    for (const ch of spec.charts) {
      if (ch.main) continue;
      const chartLabel = effType === 'xbar-r' ? 'R' : effType === 'xbar-s' ? 'S' : effType === 'i-mr' ? 'MR' : ch.props.clLabel ?? '离散';
      if (staged && effType === 'xbar-r') {
        // 分阶段极差图:采用段内准则判异(否则整段被跳过、极差失控不显示)
        if (staged.r.viol.size) {
          dispViolByChart.set(ch.t, staged.r.viol);
          expandSpcRuleItems(staged.r.viol, staged.r.list, chartLabel).forEach((o) =>
            dispItems.push({ ...o, desc: `${chartLabel} 图：${o.desc}` }));
        }
      } else if (!spec.coreViol && ch.props.ucl != null) {
        const { ucl, lcl, data: cdata } = ch.props;
        const dr = evalLimitedRules(cdata as number[], ch.props.cl, ucl, lcl, spcRules);
        if (dr.viol.size) {
          dispViolByChart.set(ch.t, dr.viol);
          expandSpcRuleItems(dr.viol, dr.list, chartLabel).forEach((item) => {
            // MR 图数组索引 0 对应原始观测 2；结果列表统一映射回原观测索引。
            const i = effType === 'i-mr' ? item.i + 1 : item.i;
            dispItems.push({ ...item, i, desc: `${chartLabel} 图：${item.desc}` });
          });
        }
      }
    }
  }
  const mainChartLabel: Record<SpcType, string> = {
    'xbar-r': 'X̄', 'xbar-s': 'X̄', 'i-mr': 'I', ewma: 'EWMA', cusum: 'CUSUM', p: 'P', c: 'C',
  };
  const allViolItems = [
    ...expandSpcRuleItems(viol, violList, mainChartLabel[effType]),
    ...dispItems,
  ].sort((a, b) => a.i - b.i || a.chartLabel.localeCompare(b.chartLabel) || a.rule - b.rule);
  const uniqueViolCount = uniqueSpcPointCount(allViolItems);
  const uniqueViolPoints = new Set(allViolItems.map((o) => o.i));
  const variationChartLabel = effType === 'xbar-r' ? 'R' : effType === 'xbar-s' ? 'S' : effType === 'i-mr' ? 'MR' : null;
  const variationViolCount = uniqueSpcPointCount(dispItems);

  const sel = selSub != null && selSub < main.props.data.length ? selSub : null;
  const labWord = { 'xbar-r': '子组', 'xbar-s': '子组', 'i-mr': '观测', ewma: '点', cusum: '点', p: '样本', c: '单位' }[effType];
  const mainLabels = effType === 'p' || effType === 'c' ? undefined : labelsFor(main.props.data.length);
  const ptLab = (i: number) => effType === 'p'
    ? `${labWord} ${i + 1}（n=${pModel.pNs[i]}）`
    : labWord + ' ' + (mainLabels?.[i] ?? (i + 1));

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
    if (effType === 'p') {
      stats.length = 0;
      stats.push(
        { k: '中心线 p̄', v: nf(pModel.pbar, 4) },
        { k: '样本量 nᵢ', v: pNLabel },
        { k: 'UCL 范围', v: pModel.pVariableN ? `${nf(pMinUcl, 4)}–${nf(pMaxUcl, 4)}` : nf(pModel.pUcl, 4) },
        { k: 'LCL 范围', v: pModel.pVariableN ? `${nf(pMinLcl, 4)}–${nf(pMaxLcl, 4)}` : nf(pModel.pLcl, 4) },
        { k: '样本数', v: String(pModel.pprop.length) },
      );
    } else if (effType === 'xbar-r' && staged) {
      stats.length = 0;
      staged.x.segments.forEach((sg) => {
        stats.push({ k: `「${sg.label}」CL·UCL·LCL`, v: `${nf(sg.cl, 3)} / ${nf(sg.ucl, 3)} / ${nf(sg.lcl, 3)}` });
      });
      stats.push({ k: '段数', v: String(staged.x.segments.length) }, { k: '子组数', v: String(M.k) });
    } else if (effType === 'xbar-r') stats.push({ k: 'R̄', v: nf(M.rbar, 3) }, { k: 'σ̂ 组内', v: nf(M.sigmaWithin, 4) }, { k: '子组数', v: String(M.k) });
    else if (effType === 'xbar-s') stats.push({ k: 'S̄', v: nf(M.sbar, 4) }, { k: 'σ̂ (S̄/c₄)', v: nf(M.sbar / M.c4, 4) }, { k: '子组数', v: String(M.k) });
    else if (effType === 'i-mr') stats.push({ k: 'MR̄', v: nf(M.mrbar, 3) }, { k: 'σ̂ (MR̄/d₂)', v: nf(M.iSig, 4) }, { k: '观测数', v: String(M.indiv.length) });
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
        { k: '样本量', v: String(pModel.pNs[sel]) },
        { k: '不良率', v: nf(pModel.pprop[sel], 3) },
        { k: 'UCL / LCL', v: `${nf(pModel.pUcls[sel], 4)} / ${nf(pModel.pLcls[sel], 4)}` },
      ];
    } else {
      subRows = [{ k: '缺陷数', v: String(cModel.cdata[sel]) }];
    }
  }
  const selBad = sel != null && uniqueViolPoints.has(sel);

  const typeTabs: Array<[SpcType, string]> = [
    ['xbar-r', 'X̄-R'], ['xbar-s', 'X̄-S'], ['i-mr', 'I-MR'],
    ['ewma', 'EWMA'], ['cusum', 'CUSUM'], ['p', 'P 图'], ['c', 'C 图'],
  ];
  const ruleToggles = (['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'] as const).map((k) => [k, `准则 ${k.slice(1)}`] as const);

  const report = spcReport({
    violList: allViolItems, // 含 R/S/MR 离散图失控点——顶部结论卡与右侧列表口径一致
    k: main.props.data.length,
    n: effType === 'p' ? pModel.pNs : effType === 'c' ? 1 : M.n,
    hasSubgroups: effType === 'p' || effType === 'c' ? false : M.hasSubgroups,
    structure: effType === 'p' ? 'attribute-p' : effType === 'c' ? 'attribute-c' : M.hasSubgroups ? 'subgroup' : 'individual',
    typeLabel: typeTabs.find(([k]) => k === effType)?.[1] ?? effType,
    variationChartLabel,
    variationViolations: dispItems,
    variableName: effType === 'p' || effType === 'c' ? undefined : variableName,
    dataRole: effType === 'p'
      ? `每批不良数 / 实际检验数；${pModel.pVariableN ? '逐批 nᵢ 生成变控制限' : `固定 n=${pModel.pN}`}`
      : effType === 'c' ? undefined : prepared.note,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {effType !== 'p' && effType !== 'c' && rolePanel}
      <ReportCard data={report} />
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>控制图类型</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {typeTabs.map(([k, l]) => {
            const off = specs[k].disabled;
            return (
              <button
                type="button"
                key={k}
                title={off ? '单列数据无子组，不可用' : undefined}
                style={{ ...tabStyle(effType === k), ...(off ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                disabled={off}
                aria-pressed={effType === k}
                onClick={() => setSpcType(k)}
              >
                {l}
              </button>
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
                const unavailable = (effType === 'p' || effType === 'c') && Number(k.slice(1)) > 4;
                return (
                  <button
                    type="button"
                    key={k}
                    style={{ ...chipStyle(!unavailable && spcRules[k]), fontFamily: 'inherit', ...(unavailable ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
                    disabled={unavailable}
                    aria-pressed={!unavailable && spcRules[k]}
                    onClick={() => toggleRule(k)}
                    title={unavailable ? 'P/C 属性控制图仅适用准则 1–4' : `${d.def}(${d.points})· ${d.source}`}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: !unavailable && spcRules[k] ? '#1f6fb2' : '#c8cfd8' }} />
                    {l}
                  </button>
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
            <select
              style={stageSelStyle}
              value={stageCol}
              onChange={(e) => {
                const next = +e.target.value;
                setSpcStageCol(next >= 0 ? textCols[next]?.name ?? null : null);
              }}
            >
              <option value={-1}>不分阶段</option>
              {textCols.map((c, i) => <option key={c.name} value={i}>按 {c.name}</option>)}
            </select>
            {stageCol >= 0 && !staged && (
              <span role="alert" style={{ fontSize: 11.5, color: '#b65400' }}>阶段未启用：{stageError ?? '阶段列与控制图数据不匹配'}</span>
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
          <span style={{ color: '#a3abb5' }}>
            依据：Nelson (1984) / Minitab 特殊原因检验；R、S、MR、P、C 图仅适用准则 1–4，X̄/I 图适用 1–8
          </span>
        </div>
      )}

      {variationChartLabel && (
        <div style={{
          padding: '10px 16px', borderRadius: 5, border: `1px solid ${variationViolCount ? '#efc7c7' : '#cfe5d3'}`,
          background: variationViolCount ? '#fff6f6' : '#f5fbf6', color: variationViolCount ? '#a62b2b' : '#2c6b3c',
          fontSize: 12.5, lineHeight: 1.6,
        }}>
          <b>判读顺序：先看 {variationChartLabel} 图。</b>{' '}
          {variationViolCount > 0
            ? `${variationChartLabel} 图检出 ${variationViolCount} 个异常点，过程变异尚未受控；此时均值/单值图的控制限缺乏稳定变异前提，暂不解释其信号，先调查离散异常。`
            : `${variationChartLabel} 图未检出异常，过程变异受控；现在才可继续解释 ${effType === 'i-mr' ? 'I' : 'X̄'} 图。`}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {spec.charts.map((ch) => {
            const chartSelection = ch.main ? sel : effType === 'i-mr' ? (sel != null && sel > 0 ? sel - 1 : null) : sel;
            const selectChartPoint = (index: number) => setSelSub(effType === 'i-mr' && !ch.main ? index + 1 : index);
            return <Card key={ch.t}>
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
                  sel={chartSelection}
                  onPoint={selectChartPoint}
                  ptLabel={effType === 'i-mr' && !ch.main ? (i) => ptLab(i + 1) : ptLab}
                />
              </div>
            </Card>;
          })}
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
                <button
                  type="button"
                  onClick={() => useApp.getState().goTo('worksheet')}
                  style={{ width: '100%', marginTop: 10, padding: '6px 0', textAlign: 'center', border: '1px solid #bcd6ee', background: '#fff', color: '#1f6fb2', borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
                >
                  在工作表中查看此行 →
                </button>
              )}
            </div>
          )}
          <Card style={{ padding: '15px 16px' }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>控制限与参数</div>
            <KvRows rows={stats} />
          </Card>
          <div style={{ background: '#fff', border: '1px solid #f0d3d3', borderRadius: 5, padding: '15px 16px', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
            <div style={{ fontWeight: 600, color: '#c22f2f', marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              检验结果（按实际点去重）
              <span className="mono" style={{ marginLeft: 8, background: '#e23b3b', color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>{uniqueViolCount} 点</span>
            </div>
            {uniqueViolCount === 0 && (
              <div style={{ padding: '8px 0', fontSize: 12.5, color: '#2c8a45', fontWeight: 500 }}>✓ 未检出失控点，过程受控</div>
            )}
            {allViolItems.slice(0, 12).map((o) => (
              <div key={(o.chartLabel || 'main') + '-' + o.rule + '-' + o.i} style={{ padding: '8px 0', borderTop: '1px solid #f6eaea', fontSize: 12.5 }}>
                <div style={{ color: '#c22f2f', fontWeight: 600 }}>{o.chartLabel ? `${o.chartLabel} 图 · ` : ''}{ptLab(o.i)}{spec.shewhart ? ` · 准则 ${o.rule}` : ''}</div>
                <div style={{ color: '#8a929d', marginTop: 2 }}>{o.desc}</div>
              </div>
            ))}
            {allViolItems.length > 0 && (
              <div style={{ padding: '8px 0', fontSize: 12, color: '#9aa2ad', borderTop: '1px solid #f6eaea' }}>
                {allViolItems.length > 12 ? '… ' : ''}共 {uniqueViolCount} 个失控点 · {allViolItems.length} 个点-准则命中
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
