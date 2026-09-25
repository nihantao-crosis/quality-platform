/** 质量总览 — KPI / X̄ 趋势 / 帕累托 / 分析记录 / 告警，全部指标实时计算。 */
import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp } from '../../store/appStore';
import { useData, resolveCapabilityMeasurementData, isCapabilityWarningAcknowledged } from '../../store/dataStore';
import {
  nf, DEFECTS, capabilityInputError, computeCapability, oneWayAnova, anovaGroups, andersonDarling,
  prepareSpcData, countCapabilityViolations, withSigmaMethod, spcChartFamilyFor, spcViewFamilyFor, SPC_FAMILY_LABEL,
  evaluateSpcChartRules, resolveSpcStage, capabilityStabilityCaliber,
} from '../../core';
import { STATUS_COLORS, sameChartTokens } from '../tokens';
import type { ChartTokens } from '../tokens';
import { Card, Badge } from '../common';
import { ControlChart } from '../charts/ControlChart';
import { ParetoChart } from '../charts/misc';
import { useAnalyses } from '../../store/analyses';
import { paretoReport } from '../reportData';

/** 告警区只渲染前 N 条；总数仍按完整判异明细计。 */
const DASHBOARD_ALERT_ROWS = 8;

function DashboardView({ T }: { T: ChartTokens }) {
  // GAP-10-22:按字段订阅(useShallow)。toast/openMenu/varOpen 等纯 UI 字段变化不再让本页重渲染;
  // 与文件末尾的 React.memo 一起挡住 App 父级因这些字段重渲染时的连带重算。
  const {
    goTo, lsl, usl, tgt, lslOn, uslOn, spcType, spcRules, spcRuleK, spcDataLayout, spcValueCol, spcSubgroupCol, spcSigmaMethod, spcStageCol,
    paretoThreshold, capSubgroupMode, capSubgroupSize, capValueCol, capSubgroupIdCol, capabilityWarningAcknowledgement,
  } = useApp(useShallow((s) => ({
    goTo: s.goTo, lsl: s.lsl, usl: s.usl, tgt: s.tgt, lslOn: s.lslOn, uslOn: s.uslOn,
    spcType: s.spcType, spcRules: s.spcRules, spcRuleK: s.spcRuleK,
    spcDataLayout: s.spcDataLayout, spcValueCol: s.spcValueCol, spcSubgroupCol: s.spcSubgroupCol, spcSigmaMethod: s.spcSigmaMethod,
    spcStageCol: s.spcStageCol,
    paretoThreshold: s.paretoThreshold, capSubgroupMode: s.capSubgroupMode, capSubgroupSize: s.capSubgroupSize,
    capValueCol: s.capValueCol, capSubgroupIdCol: s.capSubgroupIdCol,
    capabilityWarningAcknowledgement: s.capabilityWarningAcknowledgement,
  })));
  const { model: M, textCols, pendingCells } = useData(useShallow((s) => ({
    model: s.model, textCols: s.textCols, pendingCells: s.pendingCells,
  })));
  // 记忆化(闭环审核 P2:与 App/Worksheet/SPC 同一约定,此前漏了本页与能力页)
  const prepared = useMemo(
    () => prepareSpcData(M, textCols, {
      layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
      pendingCells,
    }),
    [M, textCols, pendingCells, spcDataLayout, spcValueCol, spcSubgroupCol],
  );
  // 审查修复(720):总览与 SPC 页同口径——σ 估计方法一并套用,R 判异中心线用 rCl(pooled 时 ≠ R̄)
  const SM = useMemo(
    () => prepared.model ? withSigmaMethod(prepared.model, spcSigmaMethod) : null,
    [prepared, spcSigmaMethod],
  );
  // 批次716-R3:Cpk/PPM 卡改走能力口径解析(resolveCapabilityMeasurementData),与能力页/
  // 保存记录/专项报告同源;趋势图与 SPC 告警仍属 SPC 口径,继续使用上面的 prepared/SM。
  // resolver 从 store 内部读取以下口径/角色字段,依赖需手工列全以便口径变化时失效。
  const capPrepared = useMemo(
    () => resolveCapabilityMeasurementData(M, textCols),
    [M, textCols, pendingCells, capSubgroupMode, capSubgroupSize, capValueCol, capSubgroupIdCol, spcDataLayout, spcValueCol, spcSubgroupCol], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const CM = capPrepared.model;
  // GAP-10-22:确认指纹(内部再解析能力口径 + 全量指纹)与能力计算都是 O(N),一并记忆化;
  // capPrepared 已随全部能力口径字段失效,依赖它即覆盖 resolver 从 store 读取的字段。
  const { capError, cap } = useMemo(() => {
    const capSpec = { lsl: lslOn ? lsl : null, tgt, usl: uslOn ? usl : null };
    const capWarningAcknowledged = CM != null && isCapabilityWarningAcknowledged(
      M, textCols, CM, capSpec, capabilityWarningAcknowledgement,
    );
    const capError = CM
      ? capabilityInputError(CM.all, CM.sigmaWithin, capSpec, { allowDistantSpec: capWarningAcknowledged })
      : capPrepared.error ?? '能力数据角色有歧义';
    const cap = CM && capError == null
      ? computeCapability(CM.all, CM.sigmaWithin, capSpec, { allowDistantSpec: capWarningAcknowledged })
      : null;
    return { capError, cap };
  }, [M, textCols, capPrepared, CM, lsl, usl, tgt, lslOn, uslOn, capabilityWarningAcknowledgement]);
  const anova = useMemo(() => oneWayAnova(anovaGroups().map((g) => g.vals)), []);

  // 与 SPC 页共用数据角色、图型(spcViewFamilyFor:子组数据选 I-MR 时同样按全部单值)与阶段口径
  // (resolveSpcStage:分阶段时按段内控制限判异,阶段校验失败时同样拒绝出结论),判异走唯一原语
  // evaluateSpcChartRules(CORE-09/UI-12/PLATFORM-21)。离散图失控时先告警,不把均值图单独解释为“受控”。
  // GAP-10-22:判异(含明细)整体记忆化,只随数据/图型/准则/K/阶段变化重跑。告警计数仍取完整
  // 明细条数(口径不变),文案对象只构造实际渲染的前 8 条。
  const spcView = useMemo(() => {
    if (!SM) return null;
    const family = spcViewFamilyFor(SM, spcType);
    const stage = resolveSpcStage({
      stageColumn: spcStageCol, textCols: prepared.textCols, spcType, hasSubgroups: SM.hasSubgroups, pointCount: SM.k,
    });
    if (stage.state === 'invalid') return { family, stageError: stage.reason, evaluation: null } as const;
    return { family, stageError: null, evaluation: evaluateSpcChartRules(SM, spcRules, spcRuleK, family, true, stage) } as const;
  }, [SM, prepared, spcType, spcStageCol, spcRules, spcRuleK]);
  const spcFamily = spcView?.family ?? 'xbar-r';
  const spcIndividual = spcFamily === 'i-mr';
  const spcStageError = spcView?.stageError ?? null;
  const spcStaged = spcView?.evaluation?.staged ?? null;
  const dispersionLabel = spcIndividual ? 'MR' : spcFamily === 'xbar-s' ? 'S' : 'R';
  const dispersion = spcView?.evaluation?.dispersion ?? null;
  const mainRules = spcView?.evaluation?.location ?? null;
  const { alerts, alertCount, spcAlertCount, anovaAlertCount } = useMemo(() => {
    const dispersionFirst = Boolean(dispersion?.list.length);
    const spcSource = dispersionFirst ? dispersion!.list : mainRules?.list ?? [];
    const spcAlerts = spcSource.slice(0, DASHBOARD_ALERT_ROWS).map((v) => (dispersionFirst
      ? {
          color: STATUS_COLORS.bad,
          title: `${dispersionLabel} 图点 ${v.i + (spcIndividual ? 2 : 1)} 违反准则 ${v.rule}`,
          desc: `${v.desc}；离散图未稳定，暂不解释${spcIndividual ? ' I' : ' X̄'} 图。`,
          page: 'spc' as const,
        }
      : {
          color: STATUS_COLORS.bad,
          title: `${spcIndividual ? 'I 图观测' : 'X̄ 图子组'} ${v.i + 1} 违反准则 ${v.rule}`,
          desc: v.desc,
          page: 'spc' as const,
        }));
    // 设备 ANOVA 是随安装包提供的演示研究，只能在演示数据集上形成告警。
    const anovaAlerts = M.isDemo && anova.significant
      ? [{ color: STATUS_COLORS.warn, title: '演示研究：设备间均值差异显著', desc: `演示 ANOVA 显示设备间差异显著 (P=${nf(anova.pValue, 3)})`, page: 'anova' as const }]
      : [];
    return {
      alerts: [...spcAlerts, ...anovaAlerts].slice(0, DASHBOARD_ALERT_ROWS),
      alertCount: spcSource.length + anovaAlerts.length,
      spcAlertCount: spcSource.length,
      anovaAlertCount: anovaAlerts.length,
    };
  }, [dispersion, mainRules, dispersionLabel, spcIndividual, M.isDemo, anova]);

  const cpkGood = cap != null && cap.cpk >= 1.33;
  // P0-4:过程失控/非正态时 Cpk 卡不得给绿色「达标」——与能力页/保存记录同一口径。
  // 716-R3:失控计数与正态性检验同步切到能力口径模型(countCapabilityViolations 与能力页/保存记录共用)。
  // 能力 Cpk 继续使用 resolver 的 sigmaWithin；稳定性则必须复用当前 SPC 的 σ̂ 方法，
  // 否则 pooled 控制限下看板会仍按 classic 计数而与能力页/导出分裂。
  // CORE-09/UI-12:能力稳定性有意不分阶段、按子组图评估(与 Minitab 能力分析一致);与 SPC 视图
  // 不同时卡片小字写明口径,避免与上方 SPC 告警结论并排矛盾而无说明。
  const { dashSpcViol, capStabilityCaliber } = useMemo(() => {
    const capSpcModel = CM ? withSigmaMethod(CM, spcSigmaMethod) : null;
    if (!capSpcModel) return { dashSpcViol: 0, capStabilityCaliber: null };
    const capabilityFamily = spcChartFamilyFor(capSpcModel, spcType);
    return {
      dashSpcViol: countCapabilityViolations(capSpcModel, spcRules, spcRuleK, capabilityFamily),
      capStabilityCaliber: capabilityStabilityCaliber({ capabilityFamily, spcType, spcStageCol }),
    };
  }, [CM, spcSigmaMethod, spcRules, spcRuleK, spcType, spcStageCol]);
  const cpkStable = dashSpcViol === 0;
  const hasCap = cap != null;
  const dashAd = useMemo(
    () => hasCap && CM && CM.all.length >= 8 ? andersonDarling(CM.all) : null,
    [hasCap, CM],
  );
  const dashNonNormal = dashAd != null && !dashAd.normal;
  // 716-R3:能力口径与 SPC 口径不同时,小字注明当前口径,让用户知道这个 Cpk 属于哪份数据。
  const capCaliberNote = capSubgroupMode === 'const'
    ? `能力口径:单列「${capPrepared.variableName}」×子组${capSubgroupSize}`
    : capSubgroupMode === 'stacked'
      ? `能力口径:单列「${capPrepared.variableName}」+子组 ID`
      : null;
  const capStatusText = (!cpkStable ? `控制图 ${dashSpcViol} 个失控点,Cpk 仅描述当前样本`
    : dashNonNormal ? '数据偏离正态,Cpk 需谨慎解释' : '目标 ≥ 1.33')
    + (capStabilityCaliber ? ` · ${capStabilityCaliber.short}` : '');
  const kpis = [
    {
      label: '过程能力 Cpk', value: cap ? nf(cap.cpk, 2) : '—',
      tag: cap ? (!cpkStable ? '不稳定' : dashNonNormal ? '非正态' : cpkGood ? '达标' : '预警') : '未运行',
      color: cap ? (!cpkStable || dashNonNormal ? STATUS_COLORS.warn : cpkGood ? STATUS_COLORS.ok : STATUS_COLORS.warn) : STATUS_COLORS.muted,
      sub: cap
        ? (capCaliberNote ? `${capStatusText} · ${capCaliberNote}` : capStatusText)
        : `${capError ?? '能力输入无效'}${capCaliberNote ? ` · ${capCaliberNote}` : ''}`,
    },
    M.isDemo
      ? { label: '一次合格率', value: '98.6%', tag: '演示', color: STATUS_COLORS.ok, sub: '内置看板示例，不代表当前生产批次' }
      : { label: '一次合格率', value: '—', tag: '', color: STATUS_COLORS.muted, sub: '当前工作表没有批次一次合格数据' },
    { label: '不良 PPM', value: cap ? Math.round(cap.ppm.overall.total).toLocaleString() : '—', tag: '', color: cap ? STATUS_COLORS.bad : STATUS_COLORS.muted, sub: cap ? '预计缺陷率' : capError ?? '能力输入无效' },
    {
      label: '未处理告警', value: String(alertCount), tag: '', color: alertCount > 0 ? STATUS_COLORS.warn : STATUS_COLORS.ok,
      sub: spcStageError
        ? `SPC 分阶段未运行${anovaAlertCount ? ` · ${anovaAlertCount} 演示 ANOVA` : ''}`
        : alertCount > 0
          ? `${spcAlertCount} SPC${anovaAlertCount ? ` · ${anovaAlertCount} 演示 ANOVA` : ''}${spcStaged ? ` · 分阶段 ${spcStaged.x.segments.length} 段` : ''}`
          : SM ? `过程受控${spcStaged ? `(分阶段 ${spcStaged.x.segments.length} 段)` : ''}` : 'SPC 未运行',
    },
  ];

  const saved = useAnalyses((s) => s.saved);
  const paretoModel = useData((s) => s.paretoModel);
  const paretoRows = useMemo(() => paretoModel && paretoModel.rows.length > 0
    ? paretoReport({
        rows: paretoModel.rows,
        mergeOther: false,
        threshold: paretoThreshold,
      }).rows.map((row) => ({ name: row.name, count: row.count }))
    : null, [paretoModel, paretoThreshold]);
  const paretoName = paretoModel?.name ?? '';
  const restore = useAnalyses((s) => s.restore);
  const fmtTime = (t: number) => {
    const d = new Date(t);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="responsive-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {kpis.map((k) => (
          <Card key={k.label} style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12.5, color: STATUS_COLORS.muted, fontWeight: 500 }}>{k.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <div className="mono" style={{ fontSize: 30, fontWeight: 700, color: k.color, letterSpacing: '-0.02em' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: k.color, fontWeight: 600 }}>{k.tag}</div>
            </div>
            <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 6 }}>{k.sub}</div>
          </Card>
        ))}
      </div>

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>
              {spcIndividual ? '过程单值趋势' : '过程均值趋势'} · {prepared.variableName}
            </div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: STATUS_COLORS.muted }}>
              {SM
                ? `${SPC_FAMILY_LABEL[spcFamily]}${spcStaged ? ` · 分阶段 ${spcStaged.x.segments.length} 段` : ''} · ${spcIndividual ? SM.indiv.length : SM.k} ${spcIndividual ? '观测' : '子组'}`
                : '待配置'}
            </div>
          </div>
          <div style={{ padding: '10px 14px 6px' }}>
            {!SM ? (
              <div style={{ height: 190, display: 'grid', placeItems: 'center', color: '#b05b2f', fontSize: 12.5, lineHeight: 1.7, textAlign: 'center' }}>
                SPC 数据角色存在歧义，请打开“控制图”选择测量值列和子组 ID。<br />
                本页不会把数值子组列静默混入测量。
              </div>
            ) : spcStageError ? (
              <div style={{ height: 190, display: 'grid', placeItems: 'center', color: '#b05b2f', fontSize: 12.5, lineHeight: 1.7, textAlign: 'center' }}>
                X̄-R 分阶段未运行：{spcStageError}<br />
                与控制图页、保存记录和导出同口径拒绝出结论；请在“控制图”修正阶段列或改为“不分阶段”。
              </div>
            ) : !spcIndividual ? (
              <ControlChart
                T={T} data={SM.subs.map((sub) => sub.mean)} cl={SM.xbarbar}
                ucl={spcFamily === 'xbar-s' ? SM.uclXs : SM.uclX} lcl={spcFamily === 'xbar-s' ? SM.lclXs : SM.lclX} clLabel="X̄" h={210}
                violations={mainRules?.viol}
                {...(spcStaged ? {
                  clSeries: spcStaged.x.clSeries, uclSeries: spcStaged.x.uclSeries, lclSeries: spcStaged.x.lclSeries,
                  stepSeries: true, stageBoundaries: spcStaged.x.boundaries,
                } : {})}
                xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组均值`} xLabels={prepared.subgroupLabels}
              />
            ) : (
              <ControlChart
                T={T} data={SM.indiv} cl={SM.indMean} ucl={SM.iUcl} lcl={SM.iLcl} clLabel="X̄" h={210}
                violations={mainRules?.viol}
                xLabel={SM.hasSubgroups ? '观测序号' : prepared.xAxisLabel} yLabel={`${prepared.variableName} · 单值`}
                xLabels={prepared.subgroupLabels.length === SM.indiv.length ? prepared.subgroupLabels : undefined}
              />
            )}
          </div>
        </Card>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>
              缺陷帕累托 · {paretoRows ? paretoName : '示例'}
            </div>
          </div>
          <div style={{ padding: '10px 14px 6px' }}>
            <ParetoChart T={T} rows={paretoRows ?? DEFECTS} w={520} h={210} />
          </div>
        </Card>
      </div>

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 13.5, display: 'flex', alignItems: 'center' }}>
            近期分析记录
            {saved.length > 0 && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: '#9aa2ad' }}>{saved.length} 项</span>}
          </div>
          {saved.length === 0 ? (
            <div style={{ padding: '22px 16px', fontSize: 12.5, color: '#9aa2ad', lineHeight: 1.7 }}>
              暂无已保存的分析。打开任一分析模块（SPC / 过程能力 / ANOVA…）后,点右上角
              <b style={{ color: '#1f6fb2' }}> 保存到项目 </b>
              即把该次分析记录在此。普通分析可恢复当时的数据集与参数；AQL 保存的是连续检验流的历史摘要，点击只返回当前 AQL，不会回滚活跃批次状态。
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
                  <th style={{ padding: '9px 16px', fontWeight: 600 }}>分析</th>
                  <th style={{ padding: '9px 8px', fontWeight: 600 }}>数据集</th>
                  <th style={{ padding: '9px 8px', fontWeight: 600 }}>关键指标</th>
                  <th style={{ padding: '9px 8px', fontWeight: 600 }}>状态</th>
                  <th style={{ padding: '9px 16px', fontWeight: 600 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {saved.slice(0, 6).map((r) => (
                  <tr
                    key={r.id}
                    className="hov-row"
                    role="button"
                    tabIndex={0}
                    title={r.kind === 'aql' ? '历史摘要：点击返回当前 AQL；不会覆盖当前抽样参数、状态或责任账本' : '点击恢复此分析的数据集与参数'}
                    onClick={() => restore(r.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        restore(r.id);
                      }
                    }}
                    style={{ borderTop: '1px solid #f0f2f5', cursor: 'pointer' }}
                  >
                    <td style={{ padding: '9px 16px', color: '#33404f', fontWeight: 500 }}>{r.title}</td>
                    <td className="mono" style={{ padding: '9px 8px', color: '#5b6472', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.datasetName}</td>
                    <td className="mono" style={{ padding: '9px 8px', color: '#5b6472' }}>{r.metric}</td>
                    <td style={{ padding: '9px 8px' }}><Badge bg={r.statusBg} color={r.statusColor}>{r.status}</Badge></td>
                    <td className="mono" style={{ padding: '9px 16px', color: '#9aa2ad' }}>{fmtTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #edf0f3', fontWeight: 600, color: '#33404f', fontSize: 13.5, display: 'flex', alignItems: 'center' }}>
            告警
            <span className="mono" style={{ marginLeft: 8, background: alertCount > 0 ? STATUS_COLORS.bad : STATUS_COLORS.ok, color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>{alertCount}</span>
          </div>
          <div style={{ padding: '6px 0' }}>
            {alertCount === 0 && (
              <div style={{ padding: '14px 16px', fontSize: 12.5, color: SM ? STATUS_COLORS.ok : STATUS_COLORS.muted, fontWeight: 500 }}>
                {SM ? '✓ 过程受控，暂无告警' : '尚未运行 SPC；完成数据角色配置后再判断过程状态'}
              </div>
            )}
            {alerts.map((a) => (
              <button type="button" key={a.title} className="hov-alert" onClick={() => goTo(a.page)} style={{ width: '100%', display: 'flex', gap: 11, padding: '10px 16px', border: 0, borderTop: '1px solid #f4f6f8', background: 'transparent', fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, marginTop: 5, flex: 'none' }} />
                <div>
                  <div style={{ fontSize: 12.5, color: '#33404f', fontWeight: 500 }}>{a.title}</div>
                  <div style={{ fontSize: 11.5, color: STATUS_COLORS.muted, marginTop: 2 }}>{a.desc}</div>
                </div>
              </button>
            ))}
            {alertCount > DASHBOARD_ALERT_ROWS && (
              <div style={{ padding: '9px 16px', fontSize: 11.5, color: STATUS_COLORS.muted, borderTop: '1px solid #f4f6f8' }}>
                另有 {alertCount - DASHBOARD_ALERT_ROWS} 条告警，请进入控制图查看全部判异明细。
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** 主题 tokens 按值比较:App 每次渲染新建 T 对象,不应因此让总览整页重算。 */
export const Dashboard = memo(DashboardView, (previous, next) => sameChartTokens(previous.T, next.T));
