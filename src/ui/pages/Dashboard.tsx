/** 质量总览 — KPI / X̄ 趋势 / 帕累托 / 分析记录 / 告警，全部指标实时计算。 */
import { useMemo } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import {
  nf, DEFECTS, evalRules, evalLimitedRules, capabilityInputError, computeCapability, oneWayAnova, anovaGroups, andersonDarling,
  prepareSpcData,
} from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, Badge } from '../common';
import { ControlChart } from '../charts/ControlChart';
import { ParetoChart } from '../charts/misc';
import { useAnalyses } from '../../store/analyses';
import { paretoReport } from '../reportData';

export function Dashboard({ T }: { T: ChartTokens }) {
  const {
    goTo, lsl, usl, tgt, lslOn, uslOn, spcRules, spcRuleK, spcDataLayout, spcValueCol, spcSubgroupCol,
    paretoMergeOther, paretoThreshold,
  } = useApp();
  const { model: M, textCols, pendingCells } = useData();
  const prepared = prepareSpcData(M, textCols, {
    layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
    pendingCells,
  });
  const SM = prepared.model;
  const capSpec = { lsl: lslOn ? lsl : null, tgt, usl: uslOn ? usl : null };
  const capError = SM ? capabilityInputError(SM.all, SM.sigmaWithin, capSpec) : prepared.error ?? 'SPC 数据角色有歧义';
  const cap = SM && capError == null ? computeCapability(SM.all, SM.sigmaWithin, capSpec) : null;
  const anova = useMemo(() => oneWayAnova(anovaGroups().map((g) => g.vals)), []);

  // 与 SPC 页共用数据角色和判异口径。离散图失控时先告警，不把均值图单独解释为“受控”。
  const means = SM?.subs.map((s) => s.mean) ?? [];
  const dispersion = !SM ? null : SM.hasSubgroups
    ? evalLimitedRules(SM.subs.map((s) => s.range), SM.rbar, SM.uclR, SM.lclR, spcRules, spcRuleK)
    : evalLimitedRules(SM.mr.slice(1) as number[], SM.mrbar, SM.mrUcl, 0, spcRules, spcRuleK);
  const mainRules = !SM ? null : SM.hasSubgroups
    ? evalRules(means, SM.xbarbar, (SM.uclX - SM.xbarbar) / 3, spcRules, spcRuleK)
    : evalRules(SM.indiv, SM.indMean, SM.iSig, spcRules, spcRuleK);
  const spcAlerts = (dispersion?.list.length
    ? dispersion.list.map((v) => ({
        color: '#c22f2f',
        title: `${SM?.hasSubgroups ? 'R' : 'MR'} 图点 ${v.i + (SM?.hasSubgroups ? 1 : 2)} 违反准则 ${v.rule}`,
        desc: `${v.desc}；离散图未稳定，暂不解释${SM?.hasSubgroups ? ' X̄' : ' I'} 图。`,
        page: 'spc' as const,
      }))
    : (mainRules?.list ?? []).map((v) => ({
        color: '#c22f2f',
        title: `${SM?.hasSubgroups ? 'X̄ 图子组' : 'I 图观测'} ${v.i + 1} 违反准则 ${v.rule}`,
        desc: v.desc,
        page: 'spc' as const,
      })));
  // 设备 ANOVA 是随安装包提供的演示研究，只能在演示数据集上形成告警。
  const anovaAlerts = M.isDemo && anova.significant
    ? [{ color: '#e0902a', title: '演示研究：设备间均值差异显著', desc: `演示 ANOVA 显示设备间差异显著 (P=${nf(anova.pValue, 3)})`, page: 'anova' as const }]
    : [];
  const alerts = [
    ...spcAlerts,
    ...anovaAlerts,
  ];

  const cpkGood = cap != null && cap.cpk >= 1.33;
  // P0-4:过程失控/非正态时 Cpk 卡不得给绿色「达标」——与能力页/保存记录同一口径。
  const dashSpcViol = (dispersion?.viol.size ?? 0) + (mainRules?.viol.size ?? 0);
  const cpkStable = dashSpcViol === 0;
  const dashAd = cap && SM && SM.all.length >= 8 ? andersonDarling(SM.all) : null;
  const dashNonNormal = dashAd != null && !dashAd.normal;
  const kpis = [
    {
      label: '过程能力 Cpk', value: cap ? nf(cap.cpk, 2) : '—',
      tag: cap ? (!cpkStable ? '不稳定' : dashNonNormal ? '非正态' : cpkGood ? '达标' : '预警') : '未运行',
      color: cap ? (!cpkStable || dashNonNormal ? '#e0902a' : cpkGood ? '#2c8a45' : '#e0902a') : '#8a929d',
      sub: cap
        ? (!cpkStable ? `控制图 ${dashSpcViol} 个失控点,Cpk 仅描述当前样本`
          : dashNonNormal ? '数据偏离正态,Cpk 需谨慎解释' : '目标 ≥ 1.33')
        : capError ?? '能力输入无效',
    },
    M.isDemo
      ? { label: '一次合格率', value: '98.6%', tag: '演示', color: '#2c8a45', sub: '内置看板示例，不代表当前生产批次' }
      : { label: '一次合格率', value: '—', tag: '', color: '#8a929d', sub: '当前工作表没有批次一次合格数据' },
    { label: '不良 PPM', value: cap ? Math.round(cap.ppm.overall.total).toLocaleString() : '—', tag: '', color: cap ? '#c22f2f' : '#8a929d', sub: cap ? '预计缺陷率' : capError ?? '能力输入无效' },
    {
      label: '未处理告警', value: String(alerts.length), tag: '', color: alerts.length > 0 ? '#e0902a' : '#2c8a45',
      sub: alerts.length > 0
        ? `${spcAlerts.length} SPC${anovaAlerts.length ? ` · ${anovaAlerts.length} 演示 ANOVA` : ''}`
        : SM ? '过程受控' : 'SPC 未运行',
    },
  ];

  const saved = useAnalyses((s) => s.saved);
  const paretoModel = useData((s) => s.paretoModel);
  const paretoRows = paretoModel && paretoModel.rows.length > 0
    ? paretoReport({
        rows: paretoModel.rows,
        mergeOther: paretoMergeOther,
        threshold: paretoThreshold,
      }).rows.map((row) => ({ name: row.name, count: row.count }))
    : null;
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {kpis.map((k) => (
          <Card key={k.label} style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12.5, color: '#8a929d', fontWeight: 500 }}>{k.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <div className="mono" style={{ fontSize: 30, fontWeight: 700, color: k.color, letterSpacing: '-0.02em' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: k.color, fontWeight: 600 }}>{k.tag}</div>
            </div>
            <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 6 }}>{k.sub}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f', fontSize: 13.5 }}>
              {SM?.hasSubgroups ? '过程均值趋势' : '过程单值趋势'} · {prepared.variableName}
            </div>
            <div className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>
              {SM ? `${SM.k} ${SM.hasSubgroups ? '子组' : '观测'}` : '待配置'}
            </div>
          </div>
          <div style={{ padding: '10px 14px 6px' }}>
            {!SM ? (
              <div style={{ height: 190, display: 'grid', placeItems: 'center', color: '#b05b2f', fontSize: 12.5, lineHeight: 1.7, textAlign: 'center' }}>
                SPC 数据角色存在歧义，请打开“控制图”选择测量值列和子组 ID。<br />
                本页不会把数值子组列静默混入测量。
              </div>
            ) : SM.hasSubgroups ? (
              <ControlChart
                T={T} data={means} cl={SM.xbarbar} ucl={SM.uclX} lcl={SM.lclX} clLabel="X̄" h={210}
                xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 子组均值`} xLabels={prepared.subgroupLabels}
              />
            ) : (
              <ControlChart
                T={T} data={SM.indiv} cl={SM.indMean} ucl={SM.iUcl} lcl={SM.iLcl} clLabel="X̄" h={210}
                xLabel={prepared.xAxisLabel} yLabel={`${prepared.variableName} · 单值`} xLabels={prepared.subgroupLabels}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16 }}>
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
            <span className="mono" style={{ marginLeft: 8, background: alerts.length > 0 ? '#e23b3b' : '#2c8a45', color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>{alerts.length}</span>
          </div>
          <div style={{ padding: '6px 0' }}>
            {alerts.length === 0 && (
              <div style={{ padding: '14px 16px', fontSize: 12.5, color: SM ? '#2c8a45' : '#8a929d', fontWeight: 500 }}>
                {SM ? '✓ 过程受控，暂无告警' : '尚未运行 SPC；完成数据角色配置后再判断过程状态'}
              </div>
            )}
            {alerts.slice(0, 8).map((a) => (
              <button type="button" key={a.title} className="hov-alert" onClick={() => goTo(a.page)} style={{ width: '100%', display: 'flex', gap: 11, padding: '10px 16px', border: 0, borderTop: '1px solid #f4f6f8', background: 'transparent', fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, marginTop: 5, flex: 'none' }} />
                <div>
                  <div style={{ fontSize: 12.5, color: '#33404f', fontWeight: 500 }}>{a.title}</div>
                  <div style={{ fontSize: 11.5, color: '#8a929d', marginTop: 2 }}>{a.desc}</div>
                </div>
              </button>
            ))}
            {alerts.length > 8 && (
              <div style={{ padding: '9px 16px', fontSize: 11.5, color: '#8a929d', borderTop: '1px solid #f4f6f8' }}>
                另有 {alerts.length - 8} 条告警，请进入控制图查看全部判异明细。
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
