/** 过程能力分析 ★深度实现 — 可编辑规格限实时重算 + 直方图 + PPM 性能表。 */
import type React from 'react';
import { memo, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp } from '../../store/appStore';
import { suggestedSpec, rememberSpecForCapabilityMeasurement, syncSpecForCapabilityMeasurement, capabilitySpecKey, capabilitySubgroupSemantics } from '../../store/dataStore';
import {
  nf, fmtCap, capabilityInputError, capabilitySpecDistanceWarning, capabilityWarningFingerprint,
  computeCapability, andersonDarling, bestLambda, transformWithSpec, stdev, countCapabilityViolations, withSigmaMethod,
  spcMeasurementColumnNames, spcChartFamilyFor, capabilityStabilityCaliber, spcStabilityViewFromRoles,
} from '../../core';
import { ReportCard } from '../ReportCard';
import { capabilityReport } from '../reportData';
import { sameChartTokens, type ChartTokens } from '../tokens';
import { useCapabilityPrepared } from '../useCapabilityPrepared';
import { Card, CardHeader, KvRows, numInput, Badge } from '../common';
import { Histogram } from '../charts/Histogram';
import { NormalProbPlot } from '../charts/NormalProbPlot';

/** 子组大小输入:文本态 + 失焦/回车提交(受控即时校验会让 "10" 的首键 '1' 被拒,永远打不出两位数)。 */
function SubgroupSizeInput({ value, onCommit }: { value: number; onCommit: (z: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const v = Math.round(Number(text.trim()));
    if (text.trim() !== '' && Number.isFinite(v) && v >= 2 && v <= 10) onCommit(v);
    setText(String(useApp.getState().capSubgroupSize));
  };
  return (
    <input type="number" min={2} max={10} step={1} value={text} className="mono" aria-label="子组大小"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{ width: 58, padding: '4px 8px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5 }} />
  );
}

function CapabilityView({ T }: { T: ChartTokens }) {
  // fix2609i G14:按字段订阅(useShallow),toast/openMenu/varOpen 等纯 UI 字段不触发本页重渲染;
  // 文件末尾 React.memo 再挡住 App 父级因这些字段重渲染时的连带重算(与 Dashboard/Spc 同法)。
  // 这里逐一列出本页实际读取的 store 字段;resolver 读取的角色字段由 useCapabilityPrepared 订阅。
  const {
    lsl, usl, tgt, lslOn, uslOn, toggleSide, setSpec: setSpecRaw, spcRules, spcRuleK, spcType, spcSigmaMethod, spcStageCol, goTo,
    capabilityBins: bins, setCapabilityBins: setBins, capSubgroupMode, capSubgroupSize, capValueCol, capSubgroupIdCol,
    setCapabilitySubgroup, showToast, capabilityWarningAcknowledgement, acknowledgeCapabilityWarning,
  } = useApp(useShallow((s) => ({
    lsl: s.lsl, usl: s.usl, tgt: s.tgt, lslOn: s.lslOn, uslOn: s.uslOn, toggleSide: s.toggleSide, setSpec: s.setSpec,
    spcRules: s.spcRules, spcRuleK: s.spcRuleK, spcType: s.spcType, spcSigmaMethod: s.spcSigmaMethod, spcStageCol: s.spcStageCol,
    goTo: s.goTo, capabilityBins: s.capabilityBins, setCapabilityBins: s.setCapabilityBins,
    capSubgroupMode: s.capSubgroupMode, capSubgroupSize: s.capSubgroupSize, capValueCol: s.capValueCol, capSubgroupIdCol: s.capSubgroupIdCol,
    setCapabilitySubgroup: s.setCapabilitySubgroup, showToast: s.showToast,
    capabilityWarningAcknowledgement: s.capabilityWarningAcknowledgement, acknowledgeCapabilityWarning: s.acknowledgeCapabilityWarning,
  })));
  // fix2609i G14:prepared 与壳层/总览共用 useCapabilityPrepared(依赖清单唯一:能力子组口径 +
  // SPC 数据角色 + pendingCells)。此前本页漏了 spcDataLayout/spcValueCol/spcSubgroupCol/pendingCells,
  // 「重置界面偏好」等不经 SPC 页的角色写入后页面沿用旧测量列,与状态栏不同源。
  const { prepared, model: rawModel, textCols, pendingCells, roles } = useCapabilityPrepared();
  const M = prepared.model;
  // fix2609i G14:O(N) 的输入闸门、确认指纹、能力计算、AD 检验与 Box-Cox 链路整体记忆化,
  // 只随数据/口径(prepared 已随全部口径字段失效)、规格与确认值变化重算;toast/菜单/组数滑块不触发。
  // Hooks 必须在下方各提前 return 之前调用,因此按页面状态分支返回结果对象。
  const analysis = useMemo(() => {
    if (!M) return null;
    // 单侧规格：关闭的一侧传 null
    const spec = { lsl: lslOn ? lsl : null, tgt, usl: uslOn ? usl : null };
    // 1000σ 是可确认的强警告，不与真正的数学非法输入混在一起。确认字串绑定
    // 数据集+测量/子组角色+规格+有序观测 hash；任一项变化后旧确认自动失效。
    const inputError = capabilityInputError(M.all, M.sigmaWithin, spec, { allowDistantSpec: true });
    if (inputError) return { kind: 'input-error', inputError } as const;
    const specWarning = capabilitySpecDistanceWarning(M.all, M.sigmaWithin, spec);
    const warningFingerprint = capabilityWarningFingerprint(
      capabilitySpecKey(rawModel, textCols) ?? `${rawModel.name}:${prepared.variableName}`,
      M.all,
      M.sigmaWithin,
      spec,
      capabilitySubgroupSemantics(rawModel, textCols) ?? '',
    );
    const warningAcknowledged = specWarning != null && warningFingerprint != null
      && capabilityWarningAcknowledgement === warningFingerprint;
    if (specWarning && !warningAcknowledged) return { kind: 'awaiting-ack', specWarning, warningFingerprint } as const;
    const cap = computeCapability(M.all, M.sigmaWithin, spec, { allowDistantSpec: warningAcknowledged });
    // 正态性检验 + 非正态时的 Box-Cox 备选（需双侧规格）
    const ad = M.all.length >= 8 ? andersonDarling(M.all) : null;
    let boxcox: { lambda: number; ppk: number; adAfter: number } | null = null;
    if (ad && !ad.normal && lslOn && uslOn) {
      const bl = bestLambda(M.all);
      if (!('error' in bl)) {
        const tr = transformWithSpec(M.all, lsl, usl, bl.lambda);
        if (!('error' in tr)) {
          const tSd = stdev(tr.data, true);
          const tSpec = { lsl: tr.lsl, usl: tr.usl, tgt: (tr.lsl + tr.usl) / 2 };
          // 变换域也要先过输入闸门:负 λ 会把近零规格映射成巨值,量纲哨兵在变换域触发时
          // 只应跳过 Box-Cox 补充卡,不能让 computeCapability 抛异常炸掉整页(含规格编辑器)。
          if (capabilityInputError(tr.data, tSd, tSpec, { allowDistantSpec: warningAcknowledged }) === null) {
            const tCap = computeCapability(tr.data, tSd, tSpec, { allowDistantSpec: warningAcknowledged });
            boxcox = { lambda: bl.lambda, ppk: tCap.ppk, adAfter: andersonDarling(tr.data).p };
          }
        }
      }
    }
    return { kind: 'ok', specWarning, warningAcknowledged, cap, ad, boxcox } as const;
  }, [M, rawModel, textCols, prepared, lsl, usl, tgt, lslOn, uslOn, capabilityWarningAcknowledgement]);
  // 能力结论必须先同时检查位置图与离散图;计数逻辑收敛在 countCapabilityViolations(与保存记录/专项报告共用)。
  // 能力指标仍使用 M.sigmaWithin（classic R̄/d₂）；只有控制图稳定性跟随用户选定 σ̂。
  const stability = useMemo(() => {
    if (!M || analysis?.kind !== 'ok') return null;
    const capSpcModel = withSigmaMethod(M, spcSigmaMethod);
    const capabilityFamily = spcChartFamilyFor(capSpcModel, spcType);
    const spcViol = countCapabilityViolations(capSpcModel, spcRules, spcRuleK, capabilityFamily);
    // CORE-09/UI-12:能力稳定性有意不分阶段、按子组图评估;SPC 页视图不同(分阶段/I-MR 等)时写明口径。
    // fix2609k G20:视图/阶段取 SPC 页实际生效口径(与看板/记录/专项报告/Modals 同源)。
    const { spcViewType, spcStage } = spcStabilityViewFromRoles(rawModel, textCols, {
      layout: roles.spcDataLayout, valueColumn: roles.spcValueCol, subgroupColumn: roles.spcSubgroupCol, pendingCells,
    }, spcType, spcStageCol);
    const stabilityCaliber = capabilityStabilityCaliber({ capabilityFamily, spcViewType, spcStage });
    return { spcViol, stabilityCaliber };
  }, [M, analysis, spcSigmaMethod, spcType, spcRules, spcRuleK, spcStageCol, rawModel, textCols, pendingCells,
    roles.spcDataLayout, roles.spcValueCol, roles.spcSubgroupCol]);
  // 批次716-R2 P0:子组口径(模式/测量列/ID 列)变化 = 测量特性可能变化,规格必须跟随切换,
  // 否则沿用旧量纲规格会产出虚假 Cpk。有该特性的记忆规格用记忆,否则按新口径 μ±4σ 重建议。
  const updateSubgroup = (patch: Parameters<typeof setCapabilitySubgroup>[0]) => {
    // 只有口径键真的变化才同步规格:重复点击已选中的模式/同一测量列不得触发,
    // 否则历史回放刚恢复的快照规格会被今天的记忆/建议值冲掉(违反下方 91-93 行不变式)。
    const keyBefore = capabilitySpecKey(rawModel, textCols);
    setCapabilitySubgroup(patch);
    const keyAfter = capabilitySpecKey(rawModel, textCols);
    if (keyBefore !== keyAfter && syncSpecForCapabilityMeasurement()) {
      showToast('测量口径已变化,规格限已切换为该特性的记忆/建议值(μ±4σ),请确认后再判读 Cpk');
    }
  };
  // 批次716-N:能力页显式子组配置(对齐 Minitab 能力分析对话框的「子组大小」)。
  const modeTab = (on: boolean): React.CSSProperties => ({
    padding: '4px 11px', borderRadius: 4, fontSize: 12, cursor: 'pointer', border: 0, fontFamily: 'inherit',
    background: on ? '#1f6fb2' : '#eef1f4', color: on ? '#fff' : '#5b6472', fontWeight: on ? 600 : 500,
  });
  // 批次720-C1:「子组」提升为一级醒目控件(工厂二次反馈"没有子组项"——实为可发现性问题,引擎三模式不变)。
  const effectiveSubgroupNote = capSubgroupMode === 'spc'
    ? `当前生效:测量列「${prepared.variableName}」 · 沿用控制图数据角色 · 子组大小 = ${M ? M.n : '—'}`
    : capSubgroupMode === 'const'
      ? `当前生效:测量列「${prepared.variableName}」 · 按行序每 ${capSubgroupSize} 个观测为一个子组`
      : `当前生效:测量列「${prepared.variableName}」 · 按子组 ID 列分组`;
  const subgroupEditor = (
    <Card style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 14, color: '#33404f', fontWeight: 700 }}>子组</span>
      {([['const', '子组大小（使用常量）'], ['stacked', '使用子组 ID 列'], ['spc', '沿用 SPC 数据角色']] as const).map(([m, label]) => (
        <button key={m} type="button" style={modeTab(capSubgroupMode === m)}
          title={m === 'spc' ? '与控制图共用同一数据口径(默认)' : m === 'const' ? '按行序把单列测量值每 z 个分为一个子组(Minitab「子组大小(使用常量)」)' : '一列测量值 + 一列子组 ID(Minitab「使用 ID 列」)'}
          onClick={() => updateSubgroup({ capSubgroupMode: m })}>{label}</button>
      ))}
      <span style={{ fontSize: 11.5, color: '#697382', fontWeight: 600 }}>{effectiveSubgroupNote}</span>
      {capSubgroupMode !== 'spc' && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5b6472' }}>
          测量列
          {/* 只列业务测量列:设计元数据/分析输出列(标准序、运行序等)不得作为能力测量值 */}
          <select value={capValueCol ?? ''} onChange={(e) => updateSubgroup({ capValueCol: e.target.value || null })}
            style={{ padding: '4px 8px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12 }}>
            <option value="">(沿用 SPC 测量列)</option>
            {spcMeasurementColumnNames(rawModel).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      {capSubgroupMode === 'const' && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5b6472' }}>
          子组大小
          <SubgroupSizeInput key={capSubgroupSize} value={capSubgroupSize} onCommit={(z) => updateSubgroup({ capSubgroupSize: z })} />
          <span style={{ fontSize: 11, color: '#9aa2ad' }}>(2–10,按行序分组;末尾不足一组不参与)</span>
        </label>
      )}
      {capSubgroupMode === 'stacked' && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5b6472' }}>
          子组 ID 列
          {/* option 值使用 numeric:/text: 角色引用(与 SPC 页同约定),裸列名无法被 resolveRole 命中 */}
          <select value={capSubgroupIdCol ?? ''} onChange={(e) => updateSubgroup({ capSubgroupIdCol: e.target.value || null })}
            style={{ padding: '4px 8px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12 }}>
            <option value="">(未选择)</option>
            {rawModel.colNames.map((n) => <option key={'n:' + n} value={`numeric:${n}`}>{n}（数值）</option>)}
            {textCols.map((t) => <option key={'t:' + t.name} value={`text:${t.name}`}>{t.name}（文本）</option>)}
          </select>
        </label>
      )}
    </Card>
  );
  // 规格同步只在“导入/切换数据集”和“SPC 明确数据角色”两个入口发生。
  // 能力页不能再按数据集记忆自动覆盖规格，否则历史恢复（包括页面已挂载时）
  // 会把快照中的 LSL/Target/USL 改成今天的规格，导致同一记录回看出不同 Cpk。
  if (!M) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {subgroupEditor}
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
      </div>
    );
  }
  // 写规格限时同步记忆到当前数据集（切换数据集/重启后恢复）
  const setSpec = (patch: Partial<{ lsl: number; usl: number; tgt: number }>) => {
    setSpecRaw(patch);
    const s = useApp.getState();
    rememberSpecForCapabilityMeasurement(rawModel, textCols, {
      lsl: s.lsl, tgt: s.tgt, usl: s.usl, lslOn: s.lslOn, uslOn: s.uslOn,
    });
  };
  const toggleSpecSide = (side: 'lslOn' | 'uslOn') => {
    toggleSide(side);
    const s = useApp.getState();
    rememberSpecForCapabilityMeasurement(rawModel, textCols, {
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
              // Number.isFinite 而非 !isNaN:1e999 → Infinity 落盘会让 prefs 被判「损坏」,
              // 保存分析后整份历史在重启时被隔离(双审 P2)
              if (Number.isFinite(v)) setSpec({ [i.key]: v });
            }}
            style={{ ...numInput, ...(i.on ? {} : { background: '#f4f6f8', color: '#b6bdc6' }) }}
          />
        </label>
      ))}
      {!(lslOn && uslOn) && (
        <span style={{ fontSize: 11.5, color: '#d98324', fontWeight: 600 }}>
          单侧规格：Cpk = {lslOn ? 'CPL' : 'CPU'},Cp/Pp 不适用;Cpm 按启用侧距离(Minitab 单侧式)计算
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
  if (analysis?.kind === 'input-error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {subgroupEditor}
        <Card style={{ padding: '10px 16px', color: '#5b6472', fontSize: 12.5, lineHeight: 1.6 }}>
          <b style={{ color: '#33404f' }}>能力数据口径：</b>{prepared.note}；变量：{prepared.variableName}；实际观测 N={M.all.length}。
        </Card>
        {specEditor}
        <Card style={{ padding: '18px 20px', color: '#a62b2b', background: '#fff5f5', borderColor: '#f0caca', lineHeight: 1.7 }}>
          <b>过程能力分析未运行：</b>{analysis.inputError}。请修正规格限或补充有变异的实测数据；系统不会输出负能力指数、无穷 Cpk 或超过 100% 的预测缺陷率。
        </Card>
      </div>
    );
  }
  if (analysis?.kind === 'awaiting-ack') {
    const { specWarning, warningFingerprint } = analysis;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {subgroupEditor}
        <Card style={{ padding: '10px 16px', color: '#5b6472', fontSize: 12.5, lineHeight: 1.6 }}>
          <b style={{ color: '#33404f' }}>能力数据口径：</b>{prepared.note}；变量：{prepared.variableName}；实际观测 N={M.all.length}。
        </Card>
        {specEditor}
        <Card style={{ padding: '18px 20px', color: '#8a4f08', background: '#fff8e8', border: '1px solid #efc56f', lineHeight: 1.7 }}>
          <b>过程能力分析未运行（等待确认）：强警告——规格与当前测量数据的量纲可能不一致。</b><br />
          {specWarning.message}。系统在你确认前不会显示 Cpk/PPM，也不会把该结论导出到能力报告。
          <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setSpec(suggestedSpec(M))}
              style={{ padding: '6px 12px', border: '1px solid #d7a54e', borderRadius: 4, background: '#fff', color: '#8a4f08', cursor: 'pointer', fontWeight: 600 }}>
              按当前数据重新建议规格
            </button>
            <button type="button" onClick={() => acknowledgeCapabilityWarning(warningFingerprint)}
              style={{ padding: '6px 12px', border: 0, borderRadius: 4, background: '#b0620f', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
              我已核对测量角色与规格，继续计算
            </button>
          </div>
          <div style={{ marginTop: 9, fontSize: 11.5, color: '#9b6a2a' }}>
            此确认只对当前数据集、测量口径和 LSL/Target/USL 有效；改列、改规格或数据变化都会要求重新确认。
          </div>
        </Card>
      </div>
    );
  }
  if (analysis?.kind !== 'ok' || !stability) return null; // 不可达:M 存在时 analysis 必为上述三态之一
  const { specWarning, warningAcknowledged, cap, ad, boxcox } = analysis;
  const { spcViol, stabilityCaliber } = stability;
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

  const perf = [
    { k: '实测 (观测)', lsl: '—', usl: '—', ppm: Math.round(cap.ppm.observed).toLocaleString() },
    { k: '组内 (潜在)', lsl: cap.ppm.within.belowLsl == null ? '—' : Math.round(cap.ppm.within.belowLsl).toLocaleString(), usl: cap.ppm.within.aboveUsl == null ? '—' : Math.round(cap.ppm.within.aboveUsl).toLocaleString(), ppm: Math.round(cap.ppm.within.total).toLocaleString() },
    { k: '整体 (实际)', lsl: cap.ppm.overall.belowLsl == null ? '—' : Math.round(cap.ppm.overall.belowLsl).toLocaleString(), usl: cap.ppm.overall.aboveUsl == null ? '—' : Math.round(cap.ppm.overall.aboveUsl).toLocaleString(), ppm: Math.round(cap.ppm.overall.total).toLocaleString() },
  ];

  const report = capabilityReport({
    cpk: cap.cpk, verdict: cap.verdict,
    adP: ad ? ad.p : null, n: M.all.length, spcViolations: spcViol,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {subgroupEditor}
      <ReportCard data={report} />
      <Card style={{ padding: '10px 16px', color: '#5b6472', fontSize: 12.5, lineHeight: 1.6 }}>
        <b style={{ color: '#33404f' }}>能力数据口径：</b>{prepared.note}；变量：{prepared.variableName}；实际观测 N={M.all.length}。
        {stabilityCaliber && (
          <div style={{ marginTop: 4, color: '#8a4f08' }}>
            <b>稳定性口径：</b>{stabilityCaliber.text}（本页失控点 {spcViol} 个按此口径计数）。
          </div>
        )}
      </Card>
      {specEditor}
      {specWarning && warningAcknowledged && (
        <Card style={{ padding: '10px 16px', color: '#8a4f08', background: '#fff8e8', border: '1px solid #efc56f', fontSize: 12, lineHeight: 1.6 }}>
          <b>已显式确认超 1000σ 规格：</b>{specWarning.message}。本页和能力专项报告会保留该披露；任一规格或测量口径变化后确认自动失效。
          <button type="button" onClick={() => acknowledgeCapabilityWarning(null)}
            style={{ marginLeft: 10, padding: '3px 9px', border: '1px solid #d7a54e', borderRadius: 4, background: '#fff', color: '#8a4f08', cursor: 'pointer' }}>
            撤回确认
          </button>
        </Card>
      )}

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
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
            <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {big.map((c) => (
                <div key={c.k} style={{ background: '#f7f9fb', border: '1px solid #eaeef2', borderRadius: 4, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11.5, color: '#8a929d' }}>{c.k}</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: c.color, marginTop: 3 }}>{c.v}</div>
                </div>
              ))}
            </div>
            <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
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

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
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

/** fix2609i G14:与 Dashboard/Spc 同法,主题 tokens 按值比较,挡住 toast/菜单开合引起的父级重渲染。 */
export const Capability = memo(CapabilityView, (previous, next) => sameChartTokens(previous.T, next.T));
