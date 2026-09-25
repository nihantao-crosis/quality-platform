/** 抽样检验 AQL—正式主表、实际批判定、责任追溯与第 9.3/9.4 条转移规则。 */
import { useMemo, useState } from 'react';
import { useApp } from '../../store/appStore';
import {
  rqlForResult, producerRiskPct, masterPlanByState, CODE_LETTER_TABLE, MAX_LOT_SIZE, TABLE_BY_STATE,
  AQL_PERCENT_COLS, AQL_PER100_COLS, maxNonconforming,
  decideLot, recordInspection, plansByState, normalizeSwitchStatus,
  AQL_TRACE_LIMITS,
  restoreNormalInspection, resumeTightenedInspection, setSwitchConditions, switchConditionsTransition,
  isAqlTransitionRecord, aqlTransitionActionLabel, aqlTransitionConditionText, auditAqlLedger,
  type InspectionLevel, type InspState, type NonconformingDisposition, type SwitchStatus,
} from '../../core';
import { parseStrictInteger } from '../../core/numberInput';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, tabStyle } from '../common';
import { OcCurveChart } from '../charts/OcCurveChart';
import { OcCurvePer100 } from '../charts/OcCurvePer100';

const STATE_META: Record<InspState, { label: string; bg: string; color: string }> = {
  normal: { label: '正常检验', bg: '#e7f0f9', color: '#1f6fb2' },
  tightened: { label: '加严检验', bg: '#fdecec', color: '#c22f2f' },
  reduced: { label: '放宽检验', bg: '#e8f4ea', color: '#2c8a45' },
};

// 百分不合格品允许 AQL≤10；每百单位不合格数允许完整 26 档（含 AQL≤10）。
const AQL_QUICK = [0.65, 1.0, 1.5, 2.5, 4.0, 6.5];
const DISPOSITION_LABEL: Record<NonconformingDisposition, string> = {
  none: '无不合格品', unrecorded: '未记录处置状态', pending: '已隔离，待负责部门处置', reworked: '已返工并按要求复验',
  replaced: '已替换不合格品', scrapped: '已报废不合格品', concession: '已取得让步接收批准',
};
type PositiveDisposition = Exclude<NonconformingDisposition, 'none' | 'unrecorded'>;
type SwitchConditions = Pick<SwitchStatus, 'productionSteady' | 'reducedApproved'>;
const fmtLot = (lo: number, hi: number) => (hi === Infinity ? `${lo.toLocaleString()}+` : `${lo.toLocaleString()}–${hi.toLocaleString()}`);

/** 按表 1 + 选定的正式主表生成批量范围 → 最终执行方案。 */
function planTableRows(level: InspectionLevel, aqlPct: number, lot: number, state: InspState) {
  const mk = (lo: number, hi: number, initialCode: string) => {
    const plan = masterPlanByState(state, initialCode, aqlPct);
    if (!plan) throw new Error(`正式表 ${TABLE_BY_STATE[state]} 缺少 ${initialCode} / AQL ${aqlPct}`);
    const active = lot >= lo && lot <= hi;
    return { label: fmtLot(lo, hi), initialCode, ...plan, active, fullInspect: active && plan.n >= lot };
  };
  return CODE_LETTER_TABLE.map((r) => mk(r.lo, r.hi, r[level]));
}

export function Aql({ T }: { T: ChartTokens }) {
  const { aqlLot, aqlLevel, aqlAQL, aqlRegime: regime, aqlSwitch: storedSwitch, aqlLedgerFault, setAql, setAqlSwitch: setSw } = useApp();
  // STORE-09:账本损坏期间登记/转移只能进内存且无法导出，整页停写并常驻恢复指引。
  const ledgerLocked = aqlLedgerFault !== null;
  const sw = normalizeSwitchStatus(storedSwitch);
  // G19 尾巴:记录链审计为 legacy(旧账本按兼容规则推定)时，页面与专项报告同样提示 notes。
  const ledgerAudit = useMemo(() => auditAqlLedger(storedSwitch), [storedSwitch]);
  const [lotDraft, setLotDraft] = useState<string | null>(null);
  const [lotError, setLotError] = useState<string | null>(null);
  const [nonconformingDraft, setNonconformingDraft] = useState('0');
  const [batchId, setBatchId] = useState('');
  const [inspector, setInspector] = useState('');
  const [originalInspection, setOriginalInspection] = useState(true);
  const [nonconformingDisposition, setNonconformingDisposition] = useState<PositiveDisposition | ''>('');
  const [batchError, setBatchError] = useState<string | null>(null);
  const [referenceState, setReferenceState] = useState<InspState>('normal');
  // S-2:勾选管理条件会使正常→放宽时先武装,再次点击确认才写入(复用项目的二次点击确认模式)。
  const [relaxArmed, setRelaxArmed] = useState<SwitchConditions | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const statePlans = plansByState(aqlLot, aqlLevel, aqlAQL);
  const plan = statePlans[sw.state];
  const per100 = regime === 'per100';
  const aqlP = aqlAQL / 100;
  const rql = rqlForResult(plan, 0.1, undefined, regime);
  const rqlP = rql.status === 'found' ? rql.p : undefined;
  const prodRisk = producerRiskPct(plan, aqlAQL, regime);
  const meta = STATE_META[sw.state];
  // per100 体系录入上限放宽到 n×100(计点,d 可大于样本量);percent 仍以 n 为上限
  const dMax = maxNonconforming(plan, regime);
  // 手工数值统一严格解析(type=text):「1,000」「3件」「0x1」给出可见原因，不再被 type=number 静默清空/截断。
  const nonconformingParsed = parseStrictInteger(nonconformingDraft, { min: 0, max: dMax });
  const batchValid = nonconformingParsed.ok;
  const nonconforming = nonconformingParsed.ok ? nonconformingParsed.value : Number.NaN;
  const nonconformingReason = !nonconformingParsed.ok && !nonconformingParsed.empty ? nonconformingParsed.reason : null;
  const decision = batchValid ? decideLot(plan, nonconforming, regime) : null;
  const dispositionRequired = plan.fullInspect && batchValid && nonconforming > 0;
  const batchReady = batchValid && batchId.trim().length > 0 && inspector.trim().length > 0
    && (!dispositionRequired || nonconformingDisposition !== '') && !sw.suspended && !ledgerLocked;
  const schemeLocked = sw.state !== 'normal';

  const submitInspection = () => {
    if (ledgerLocked) {
      setBatchError('AQL 责任账本已损坏，批次登记已暂停；请按页首提示恢复账本');
      return;
    }
    if (!batchValid) {
      setBatchError(per100
        ? `不合格数必须是 0–${dMax} 的整数(每百单位体系允许大于样本量 n=${plan.n})`
        : `不合格品数必须是 0–${plan.n} 的整数`);
      return;
    }
    if (!batchId.trim()) {
      setBatchError('请填写批次号，以便追溯质量判定');
      return;
    }
    if (!inspector.trim()) {
      setBatchError('请填写检验人，以便追溯质量责任');
      return;
    }
    if (dispositionRequired && !nonconformingDisposition) {
      setBatchError('100% 全检发现不合格品时，请记录隔离或后续处置状态');
      return;
    }
    try {
      setSw(recordInspection(sw, {
        lot: aqlLot,
        level: aqlLevel,
        aql: aqlAQL,
        regime,
        nonconforming,
        batchId,
        inspector,
        originalInspection,
        nonconformingDisposition: nonconformingDisposition || undefined,
      }));
      setNonconformingDraft('0');
      setBatchId('');
      setNonconformingDisposition('');
      setBatchError(null);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '无法记录本批检验结果');
    }
  };

  // 人工状态转移的操作人沿用「检验人」字段;转移记录由 core 写入责任账本。
  const operator = inspector.trim();
  // 武装态只在「按当前账本仍会转放宽」时有效(另一窗口/批次登记已改变状态时自动失效)。
  const relaxPending = relaxArmed !== null && switchConditionsTransition(sw, relaxArmed) === 'conditions-met'
    ? relaxArmed : null;
  const applySwitch = (make: () => SwitchStatus) => {
    try {
      setSw(make());
      setSwitchError(null);
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : '无法更新检验状态');
    }
  };
  const changeCondition = (key: keyof SwitchConditions, checked: boolean) => {
    const base: SwitchConditions = relaxPending ?? { productionSteady: sw.productionSteady, reducedApproved: sw.reducedApproved };
    const candidate: SwitchConditions = { ...base, [key]: checked };
    setSwitchError(null);
    if (switchConditionsTransition(sw, candidate) === 'conditions-met') {
      setRelaxArmed(candidate);
      return;
    }
    setRelaxArmed(null);
    applySwitch(() => setSwitchConditions(sw, candidate, { operator }));
  };
  const confirmRelax = () => {
    if (!relaxPending) return;
    if (!operator) {
      setSwitchError('请先填写检验人（作为本次转入放宽检验的操作人），再确认');
      return;
    }
    setRelaxArmed(null);
    applySwitch(() => setSwitchConditions(sw, relaxPending, { operator }));
  };

  const aqlOptions = per100 ? AQL_PER100_COLS : AQL_PERCENT_COLS;
  const fmtAql = (a: number) => 'AQL ' + (a >= 15 ? String(a) : a < 0.1 ? String(a) : a.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {ledgerLocked && (
        <div role="alert" style={{ padding: '11px 14px', background: '#fdecec', border: '1px solid #f1b8b8', borderRadius: 6, fontSize: 12.5, color: '#8f2323', lineHeight: 1.7 }}>
          <b>AQL 责任账本已损坏，批次登记已暂停。</b>
          {aqlLedgerFault === 'quarantined'
            ? '本机的连续检验账本未通过校验（常见于新旧版本混用或写入中断），原文已复制到隔离区且未被覆盖。'
            : '本机的连续检验账本未通过校验，且隔离区写入失败，原文只保留在原位置。'}
          此期间登记的批次、检验状态转移都无法落盘，刷新即丢失，也无法随项目备份导出，因此已停止记录；方案参数可临时查表，但同样不会保存。
          <br />
          {aqlLedgerFault === 'quarantined'
            ? <>恢复方法：①「文件 → 打开…」导入一份有效的项目备份（.qproj，会覆盖当前本地数据）；②或「工具 → 选项 / 本地数据 → 清除数据并恢复演示」清除全部业务数据后重新开始（隔离区原文会一并清除）。在恢复前，工作表与分析结论可先用「导出报表」留底。</>
            : <>恢复方法：「文件 → 打开…」导入一份有效的项目备份（.qproj）。请勿清除数据——那会销毁账本仅存的原文。在恢复前，工作表与分析结论可先用「导出报表」留底。</>}
          {/* M5:AQL 专项报表在账本损坏期间会被拒绝生成(否则是一份伪造的空追溯账本);受限状态按隔离语义不原地解除。 */}
          AQL 报表不在留底范围内：账本损坏期间它无法反映历史批次记录，导出会被拒绝。若已在其他窗口完成恢复，请刷新本窗口。
        </div>
      )}
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5b6472' }}>
            批量 N
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              aria-label="批量 N"
              value={lotDraft ?? String(aqlLot)}
              onFocus={() => { setLotDraft(String(aqlLot)); setLotError(null); }}
              onBlur={() => { if (!lotError) setLotDraft(null); }}
              onChange={(e) => {
                const raw = e.target.value;
                setLotDraft(raw);
                const parsed = parseStrictInteger(raw, { min: 2, max: MAX_LOT_SIZE });
                if (!parsed.ok) {
                  const range = `请输入 2–${MAX_LOT_SIZE.toLocaleString()} 的整数（当前仍使用 ${aqlLot.toLocaleString()}）`;
                  setLotError(parsed.empty ? range : `${parsed.reason}；${range}`);
                  return;
                }
                setLotError(null);
                setAql({ aqlLot: parsed.value });
              }}
              aria-invalid={lotError != null}
              className="mono"
              style={{ width: 132, padding: '6px 9px', border: `1px solid ${lotError ? '#c22f2f' : '#cfd5dd'}`, borderRadius: 4, fontSize: 12.5, color: '#2a333f' }}
            />
          </label>
          {lotError && <div role="alert" style={{ maxWidth: 360, marginTop: 4, fontSize: 11, color: '#c22f2f' }}>{lotError}</div>}
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>质量表示</span>
        <div role="group" aria-label="AQL 质量表示" style={{ display: 'flex', gap: 6 }}>
          {([
            ['percent', '百分不合格品'],
            ['per100', '每百单位不合格数'],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              key={value}
              disabled={schemeLocked}
              title={schemeLocked ? '须恢复正常检验后才能更改质量表示' : undefined}
              style={{ ...tabStyle(regime === value), border: 0, opacity: schemeLocked ? 0.55 : 1, cursor: schemeLocked ? 'not-allowed' : 'pointer' }}
              onClick={() => setAql(value === 'percent'
                ? { aqlRegime: value, aqlAQL: Math.min(aqlAQL, 10) }
                : { aqlRegime: value })}
            >{label}</button>
          ))}
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>检验水平</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'] as InspectionLevel[]).map((l, idx) => (
            <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {idx === 4 && <span style={{ width: 1, height: 16, background: '#e5e9ee' }} />}
              <button
                type="button"
                disabled={schemeLocked}
                title={schemeLocked ? '须按正式转移规则恢复正常检验后才能更改检验体系' : (idx < 4 ? '特殊检验水平(小样本,判别力较低)' : '一般检验水平')}
                style={{ ...tabStyle(aqlLevel === l), border: 0, opacity: schemeLocked ? 0.55 : 1, cursor: schemeLocked ? 'not-allowed' : 'pointer' }}
                onClick={() => setAql({ aqlLevel: l })}
              >{idx < 4 ? l : `水平 ${l}`}</button>
            </span>
          ))}
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>AQL</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {AQL_QUICK.map((a) => (
            <button
              type="button"
              key={a}
              disabled={schemeLocked}
              title={schemeLocked ? '须按正式转移规则恢复正常检验后才能更改检验体系' : undefined}
              style={{ ...tabStyle(aqlAQL === a), border: 0, opacity: schemeLocked ? 0.55 : 1, cursor: schemeLocked ? 'not-allowed' : 'pointer' }}
              onClick={() => setAql({ aqlAQL: a })}
            >{fmtAql(a)}</button>
          ))}
          <select
            aria-label="全部 AQL 档位"
            disabled={schemeLocked}
            title={schemeLocked ? '须按正式转移规则恢复正常检验后才能更改检验体系' : (per100 ? '计点制全部 26 档 AQL（0.010–1000）' : '百分不合格品 AQL（0.010–10）')}
            value={aqlAQL}
            onChange={(e) => setAql({ aqlAQL: Number(e.target.value) })}
            style={{ padding: '5px 8px', border: `1px solid ${AQL_QUICK.includes(aqlAQL) ? '#cfd5dd' : '#1f6fb2'}`, borderRadius: 4, fontSize: 12, color: AQL_QUICK.includes(aqlAQL) ? '#5b6472' : '#1f6fb2', background: '#fff', cursor: schemeLocked ? 'not-allowed' : 'pointer' }}
          >
            <optgroup label={per100 ? '每百单位不合格数（泊松）' : '百分不合格品（二项）'}>
              {aqlOptions.map((a) => <option key={a} value={a}>{fmtAql(a)}</option>)}
            </optgroup>
          </select>
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ padding: '5px 9px', borderRadius: 4, background: '#eef5fb', color: '#1f6fb2', fontSize: 11.5, fontWeight: 600 }}>
          GB/T 2828.1-2012 · 表 1 + {TABLE_BY_STATE[sw.state]}
        </span>
        {/* K2 体系徽标:per100 时明确提示计数口径变化(d 可大于 n) */}
        <span style={{ padding: '5px 9px', borderRadius: 4, background: per100 ? '#f3eefb' : '#f2f4f7', color: per100 ? '#7a4fb5' : '#5b6472', fontSize: 11.5, fontWeight: 600 }}>
          {per100 ? '每百单位不合格数 · 泊松（d 可大于 n）' : '百分不合格品 · 二项'}
        </span>
        {schemeLocked && (
          <span role="status" style={{ fontSize: 11.5, color: sw.suspended ? '#8a6414' : '#6b7480' }}>
            当前{sw.suspended ? '暂停' : meta.label}期间，质量表示、检验水平与 AQL 已锁定
          </span>
        )}
      </Card>

      <div className="responsive-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {[
          { k: plan.fullInspect ? '参考字码' : '样本字码', v: plan.code },
          { k: plan.fullInspect ? '全检数量 N' : '样本量 n', v: String(plan.n) },
          // per100:Ac 是「不合格数」(计点)门槛,可大于样本量 n
          { k: plan.fullInspect ? '允许不合格 Ac' : per100 ? '接收数 Ac(不合格数,可大于样本量)' : '接收数 Ac', v: String(plan.ac) },
          { k: plan.fullInspect ? '拒收门槛 Re' : '拒收数 Re', v: String(plan.re) },
        ].map((c) => (
          <Card key={c.k} style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: '#8a929d' }}>{c.k}</div>
            <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: '#1f6fb2', marginTop: 4 }}>{c.v}</div>
          </Card>
        ))}
      </div>

      {plan.fullInspect && (
        <div style={{ padding: '10px 14px', background: '#fff6e6', border: '1px solid #f0d69a', borderRadius: 6, fontSize: 12.5, color: '#8a6414', lineHeight: 1.5 }}>
          ⚠ <b>100% 全检</b>：按 GB/T 2828.1，查表样本量已 ≥ 批量 N（{aqlLot.toLocaleString()}），因此对整批逐件检验。下方“接收/不接收”仍按当前 Ac/Re 形成批判定；发现的每一件不合格品仍须隔离并按负责部门要求返工、替换、报废或批准处置，<b>批接收不等于放行不合格品</b>。抽样 OC、RQL 及 α/β 风险指标不适用，因此不展示。
        </div>
      )}

      {!plan.fullInspect && (
        <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
          <Card>
            <CardHeader title={per100 ? 'OC 特性曲线 · 接收概率 vs 每百单位不合格数 λ' : 'OC 特性曲线 · 接收概率 vs 批质量'} />
            <div style={{ padding: '14px 16px 6px' }}>
              {per100
                ? <OcCurvePer100 T={T} plan={plan} aql={aqlAQL} rqlLambda={rqlP} />
                : <OcCurveChart T={T} n={plan.n} ac={plan.ac} pmax={Math.min(1, Math.max(0.1, (rqlP ?? 0.4) * 1.25))} aqlP={aqlP} rqlP={rqlP} />}
            </div>
          </Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Card style={{ padding: 16 }}>
              <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>风险指标</div>
              <KvRows
                rows={per100 ? [
                  // per100:AQL/RQL 单位都是「每百单位不合格数 λ」,不是百分数
                  { k: 'AQL (每百单位不合格数)', v: String(aqlAQL) },
                  { k: '生产方风险 α', v: prodRisk.toFixed(1) + '%' },
                  { k: 'RQL / LTPD (Pa≤10%)', v: rql.status === 'found' ? `λ=${rql.p.toFixed(1)} /100 单位` : `未达到（λ≤${rql.searchMax.toFixed(0)}）` },
                  { k: '使用方风险 β@RQL', v: rql.status === 'found' ? (rql.pa * 100).toFixed(2) + '%' : `>${(rql.targetPa * 100).toFixed(1)}%` },
                ] : [
                  { k: 'AQL (可接收质量)', v: (aqlP * 100).toFixed(2) + '%' },
                  { k: '生产方风险 α', v: prodRisk.toFixed(1) + '%' },
                  { k: 'RQL / LTPD (Pa≤10%)', v: rql.status === 'found' ? (rql.p * 100).toFixed(2) + '%' : `未达到（p≤${(rql.searchMax * 100).toFixed(0)}%）` },
                  { k: '使用方风险 β@RQL', v: rql.status === 'found' ? (rql.pa * 100).toFixed(2) + '%' : `>${(rql.targetPa * 100).toFixed(1)}%` },
                ]}
              />
              <div style={{ marginTop: 12, padding: 11, background: '#f7f9fb', border: '1px solid #eef1f4', borderRadius: 4, fontSize: 11.5, color: '#6b7480', lineHeight: 1.55 }}>
                {per100
                  ? <>每百单位不合格数体系:Pa(λ) = PoissonCDF(Ac, n·λ/100),λ 为每百单位不合格数,可大于 100(即平均每单位超过 1 个不合格)。绿线为 AQL 点；{rql.status === 'found' ? '红线为计算得到的 RQL 点,右侧 β 为该点的实际接收概率。' : '在搜索范围内未达到目标接收概率,因此不绘制伪 RQL 标记。'}</>
                  : <>OC 曲线描述在不同批质量 p 下该抽样方案的接收概率 Pa。绿线为 AQL 点；{rql.status === 'found' ? '红线为计算得到的 RQL 点，右侧 β 为该点的实际接收概率。' : '在搜索范围内未达到目标接收概率，因此不绘制伪 RQL 标记。'}</>}
              </div>
            </Card>
          </div>
        </div>
      )}

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
            <div style={{ fontWeight: 600, color: '#33404f' }}>批次判定与正式转移规则</div>
            <div style={{ marginLeft: 'auto', padding: '2px 10px', borderRadius: 11, fontSize: 12, fontWeight: 700, background: sw.suspended ? '#fff6e6' : meta.bg, color: sw.suspended ? '#8a6414' : meta.color }}>
              {sw.suspended ? '抽样检验已暂停' : `${meta.label}${plan.fullInspect ? ' · 全检' : ''}`}
            </div>
          </div>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: '#5b6472', marginBottom: 12, lineHeight: 1.55 }}>{sw.note}</div>

            {sw.suspended ? (
              <div role="alert" style={{ padding: 12, background: '#fff6e6', border: '1px solid #f0d69a', borderRadius: 5, fontSize: 12.5, color: '#8a6414', lineHeight: 1.65 }}>
                加严检验已累计 5 批不接收。按 GB/T 2828.1 第 9.4 条，只有供方完成纠正且负责部门确认有效后，才能以加严检验重新开始。
                <label style={{ display: 'block', marginTop: 10, fontSize: 11.5, color: '#6b7480' }}>
                  确认人（检验人）
                  <input aria-label="恢复加严确认人" maxLength={AQL_TRACE_LIMITS.inspector} value={inspector} onChange={(e) => { setInspector(e.target.value); setSwitchError(null); }} placeholder="姓名 / 工号，写入责任账本" style={{ display: 'block', width: '100%', maxWidth: 260, boxSizing: 'border-box', marginTop: 4, padding: '6px 8px', border: '1px solid #cfd5dd', borderRadius: 4 }} />
                </label>
                {/* 解除暂停是人工责任决定：与其他人工转移一样写入 resume-tightened 转移记录(操作人未填写时如实记「未填写」)。 */}
                <button type="button" disabled={ledgerLocked} onClick={() => applySwitch(() => resumeTightenedInspection(sw, { operator }))} style={{ display: 'block', marginTop: 10, padding: '6px 12px', border: 0, borderRadius: 4, background: '#8a6414', color: '#fff', cursor: ledgerLocked ? 'not-allowed' : 'pointer', opacity: ledgerLocked ? 0.55 : 1 }}>
                  已确认纠正有效，恢复加严检验
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 9 }}>
                  <label style={{ fontSize: 11.5, color: '#6b7480' }}>
                    批次号 *
                    <input aria-label="批次号" maxLength={AQL_TRACE_LIMITS.batchId} value={batchId} onChange={(e) => { setBatchId(e.target.value); setBatchError(null); }} placeholder="例：LOT-20260714-01" style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '6px 8px', border: '1px solid #cfd5dd', borderRadius: 4 }} />
                  </label>
                  <label style={{ fontSize: 11.5, color: '#6b7480' }}>
                    检验人 *
                    <input aria-label="检验人" maxLength={AQL_TRACE_LIMITS.inspector} value={inspector} onChange={(e) => { setInspector(e.target.value); setBatchError(null); }} placeholder="姓名 / 工号" style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '6px 8px', border: '1px solid #cfd5dd', borderRadius: 4 }} />
                  </label>
                  <label style={{ fontSize: 11.5, color: '#6b7480' }}>
                    {/* per100 体系录入的是「不合格数」(计点),可大于样本量;max 相应放宽到 dMax */}
                    {plan.fullInspect ? (per100 ? '全检不合格数(计点)' : '全检不合格品数') : per100 ? '样本中不合格数(计点,可大于 n)' : '样本中不合格品数'} *
                    <input aria-label="实际不合格品数" type="text" inputMode="numeric" autoComplete="off" spellCheck={false} aria-invalid={!batchValid} aria-describedby={nonconformingReason ? 'aql-nonconforming-reason' : undefined} value={nonconformingDraft} onChange={(e) => { setNonconformingDraft(e.target.value); setNonconformingDisposition(''); setBatchError(null); }} className="mono" style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '6px 8px', border: `1px solid ${batchValid ? '#cfd5dd' : '#c22f2f'}`, borderRadius: 4 }} />
                    {nonconformingReason && <span id="aql-nonconforming-reason" role="alert" style={{ display: 'block', marginTop: 3, fontSize: 11, color: '#c22f2f' }}>{nonconformingReason}</span>}
                  </label>
                  <div style={{ padding: '7px 10px', alignSelf: 'end', borderRadius: 4, background: decision === 'accepted' ? '#e8f4ea' : decision === 'rejected' ? '#fdecec' : '#f7f9fb', color: decision === 'accepted' ? '#2c8a45' : decision === 'rejected' ? '#c22f2f' : '#8a929d', fontWeight: 700, fontSize: 12.5 }}>
                    自动判定：{decision === 'accepted' ? `接收（d=${nonconforming} ≤ Ac=${plan.ac}）` : decision === 'rejected' ? `不接收（d=${nonconforming} ≥ Re=${plan.re}）` : '请输入有效整数'}
                  </div>
                </div>
                {dispositionRequired && (
                  <label style={{ display: 'block', marginTop: 10, fontSize: 11.5, color: '#6b7480' }}>
                    不合格品处置 *
                    <select
                      aria-label="不合格品处置"
                      value={nonconformingDisposition}
                      onChange={(e) => { setNonconformingDisposition(e.target.value as PositiveDisposition | ''); setBatchError(null); }}
                      style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: `1px solid ${nonconformingDisposition ? '#cfd5dd' : '#c22f2f'}`, borderRadius: 4, background: '#fff', color: '#33404f' }}
                    >
                      <option value="">请选择已执行或已确认的处置状态</option>
                      {(Object.keys(DISPOSITION_LABEL) as NonconformingDisposition[]).filter((value): value is PositiveDisposition => value !== 'none' && value !== 'unrecorded').map((value) => (
                        <option key={value} value={value}>{DISPOSITION_LABEL[value]}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 11.5, color: '#6b7480' }}>
                  <input type="checkbox" checked={originalInspection} onChange={(e) => setOriginalInspection(e.target.checked)} />
                  初次检验（只有初次检验批计入正式转移规则；取消勾选时作为复验留痕）
                </label>
                {batchError && <div role="alert" style={{ marginTop: 8, fontSize: 11.5, color: '#c22f2f' }}>{batchError}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
                  <button type="button" disabled={!batchReady} onClick={submitInspection} style={{ padding: '6px 14px', border: 0, background: batchReady ? (decision === 'accepted' ? '#2c8a45' : '#c22f2f') : '#c7ccd2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: batchReady ? 'pointer' : 'not-allowed' }}>
                    记录本批并执行转移判定
                  </button>
                  {sw.state === 'reduced' && (
                    <button type="button" disabled={ledgerLocked} onClick={() => applySwitch(() => restoreNormalInspection(sw, '负责部门因其他条件决定恢复正常检验', { operator }))} style={{ padding: '6px 12px', border: '1px solid #cfd5dd', background: '#fff', color: '#5b6472', borderRadius: 5, cursor: ledgerLocked ? 'not-allowed' : 'pointer' }}>
                      因其他条件恢复正常检验
                    </button>
                  )}
                </div>
              </>
            )}

            <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 14 }}>
              <div style={{ padding: '8px 10px', border: '1px solid #edf0f3', borderRadius: 4, fontSize: 11.5, color: '#6b7480' }}>转移得分 <b className="mono" style={{ float: 'right', color: '#33404f' }}>{sw.switchingScore}/30</b></div>
              <div style={{ padding: '8px 10px', border: '1px solid #edf0f3', borderRadius: 4, fontSize: 11.5, color: '#6b7480' }}>加严不接收 <b className="mono" style={{ float: 'right', color: '#33404f' }}>{sw.tightenedRejections}/5</b></div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#5b6472' }}>
                <input type="checkbox" disabled={ledgerLocked} checked={relaxPending?.productionSteady ?? sw.productionSteady} onChange={(e) => changeCondition('productionSteady', e.target.checked)} />
                生产稳定
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#5b6472' }}>
                <input type="checkbox" disabled={ledgerLocked} checked={relaxPending?.reducedApproved ?? sw.reducedApproved} onChange={(e) => changeCondition('reducedApproved', e.target.checked)} />
                负责部门同意放宽
              </label>
            </div>
            {relaxPending && (
              <div role="alert" style={{ marginTop: 10, padding: '9px 11px', background: '#e8f4ea', border: '1px solid #b9dcc2', borderRadius: 5, fontSize: 11.5, color: '#245f33', lineHeight: 1.65 }}>
                转移得分 {sw.switchingScore} ≥ 30，且「生产稳定」「负责部门同意放宽」均已勾选：确认后立即转入放宽检验（表 2-C），并以检验人「{operator || '未填写'}」作为操作人写入责任账本。
                {!operator && <div style={{ color: '#c22f2f' }}>请先在上方填写检验人，作为本次转移的操作人。</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button type="button" disabled={!operator || ledgerLocked} onClick={confirmRelax} style={{ padding: '5px 12px', border: 0, borderRadius: 4, background: !operator || ledgerLocked ? '#c7ccd2' : '#2c8a45', color: '#fff', cursor: !operator || ledgerLocked ? 'not-allowed' : 'pointer' }}>
                    再次点击确认转入放宽检验
                  </button>
                  <button type="button" onClick={() => { setRelaxArmed(null); setSwitchError(null); }} style={{ padding: '5px 12px', border: '1px solid #cfd5dd', borderRadius: 4, background: '#fff', color: '#5b6472', cursor: 'pointer' }}>
                    取消
                  </button>
                </div>
              </div>
            )}
            {switchError && <div role="alert" style={{ marginTop: 8, fontSize: 11.5, color: '#c22f2f' }}>{switchError}</div>}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minHeight: 18, marginTop: 12 }}>
              {sw.history.slice(-30).map((result, i) => (
                <span key={`${i}-${result}`} title={result === 'A' ? '初次检验批接收' : '初次检验批不接收'} style={{ width: 14, height: 14, borderRadius: 3, background: result === 'A' ? '#2c8a45' : '#c22f2f', display: 'inline-block' }} />
              ))}
              {sw.history.length === 0 && <span style={{ fontSize: 11.5, color: '#9aa2ad' }}>当前检验体系下尚无初次检验批</span>}
            </div>
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #edf0f3', fontSize: 11.5, color: '#7b8490', lineHeight: 1.65 }}>
              正常→加严：5 批或少于 5 批初次检验中有 2 批不接收。<br />
              正常→放宽：转移得分≥30，且生产稳定、负责部门同意；Ac≥2 时，仅当严一档 AQL 的样本量与本批相同且仍接收才 +3，否则清零；Ac=0/1 且本批接收时 +2。<br />
              加严→正常：连续 5 批接收；加严累计 5 批不接收时暂停抽样检验。<br />
              放宽→正常：任一批不接收、生产不稳定/延误，或其他条件需要。复验批只留痕，不计入以上转移计数。
            </div>

            {ledgerAudit.status === 'legacy' && ledgerAudit.notes.length > 0 && (
              <div role="note" aria-label="责任账本记录链核对" style={{ marginTop: 14, padding: '7px 10px', background: '#fff6e6', border: '1px solid #f0d69a', borderRadius: 4, fontSize: 11.5, color: '#8a6414', lineHeight: 1.6 }}>
                <b>记录链核对：旧账本按兼容规则接受（一致性核对，不是防篡改签名）。</b>
                {ledgerAudit.notes.map((note) => <div key={note}>· {note}</div>)}
              </div>
            )}
            {sw.records.length > 0 && (
              <div style={{ marginTop: 14, overflowX: 'auto' }}>
                <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#33404f' }}>最近批次与状态转移追溯记录</div>
                <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ color: '#8a929d', textAlign: 'left' }}>
                    <th style={{ padding: '5px 4px' }}>批次</th><th style={{ padding: '5px 4px' }}>N/水平/AQL/表示</th><th style={{ padding: '5px 4px' }}>类型</th><th style={{ padding: '5px 4px' }}>方案</th><th style={{ padding: '5px 4px' }}>d</th><th style={{ padding: '5px 4px' }}>判定</th><th style={{ padding: '5px 4px' }}>不合格品处置</th><th style={{ padding: '5px 4px' }}>检验人</th>
                  </tr></thead>
                  <tbody>{sw.records.slice(-8).reverse().map((record) => isAqlTransitionRecord(record) ? (
                    <tr key={record.id} style={{ borderTop: '1px solid #f0f2f5', background: '#f7f9fb' }}>
                      <td style={{ padding: '5px 4px', color: '#33404f' }}>状态转移</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>{STATE_META[record.stateBefore].label}→{STATE_META[record.stateAfter].label}</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>人工转移</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>{aqlTransitionActionLabel(record.action)}</td>
                      <td className="mono" style={{ padding: '5px 4px' }}>—</td>
                      <td className="mono" style={{ padding: '5px 4px', color: '#6b7480' }}>得分 {record.switchingScoreBefore}→{record.switchingScoreAfter}</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>{aqlTransitionConditionText(record)}</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>{record.inspector}</td>
                    </tr>
                  ) : (
                    <tr key={record.id} style={{ borderTop: '1px solid #f0f2f5' }}>
                      <td style={{ padding: '5px 4px', color: '#33404f' }}>{record.batchId}</td>
                      <td className="mono" style={{ padding: '5px 4px', color: '#6b7480' }}>{record.lot}/{record.level}/{record.aql}/{record.regime === 'per100' ? '计点' : '百分'}</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>{record.originalInspection ? '初次' : '复验'}</td>
                      <td className="mono" style={{ padding: '5px 4px', color: '#6b7480' }}>{record.sourceTable} {record.initialCode}→{record.finalCode}/{record.fullInspection ? '全检' : `n${record.sampleSize}`}/Ac{record.acceptanceNumber}/Re{record.rejectionNumber}</td>
                      <td className="mono" style={{ padding: '5px 4px' }}>{record.nonconforming}</td>
                      <td style={{ padding: '5px 4px', color: record.result === 'A' ? '#2c8a45' : '#c22f2f', fontWeight: 600 }}>{record.result === 'A' ? '接收' : '不接收'}</td>
                      <td style={{ padding: '5px 4px', color: record.nonconformingDisposition === 'pending' || record.nonconformingDisposition === 'unrecorded' ? '#8a6414' : '#6b7480' }}>{DISPOSITION_LABEL[record.nonconformingDisposition]}</td>
                      <td style={{ padding: '5px 4px', color: '#6b7480' }}>{record.inspector}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="三种检验状态的方案对比（当前批量与 AQL）" />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
                <th style={{ padding: '9px 16px', fontWeight: 600 }}>状态</th>
                <th style={{ padding: '9px 8px', fontWeight: 600 }}>字码</th>
                <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>n</th>
                <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>Ac</th>
                <th style={{ padding: '9px 16px', fontWeight: 600, textAlign: 'right' }}>Re</th>
              </tr>
            </thead>
            <tbody>
              {(['normal', 'tightened', 'reduced'] as InspState[]).map((st) => {
                const p = statePlans[st];
                const m2 = STATE_META[st];
                const active = st === sw.state;
                return (
                  <tr key={st} style={{ borderTop: '1px solid #f0f2f5', ...(active ? { background: m2.bg } : {}) }}>
                    <td style={{ padding: '8px 16px', color: m2.color, fontWeight: active ? 700 : 500 }}>{m2.label}{active ? ' ←' : ''}</td>
                    <td className="mono" style={{ padding: '8px 8px', color: '#5b6472' }}>{p.code}</td>
                    <td className="mono" style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600, color: '#2a333f' }}>{p.n}{p.fullInspect ? ' 全检' : ''}</td>
                    <td className="mono" style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 600, color: '#2c8a45' }}>{p.ac}</td>
                    <td className="mono" style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, color: '#c22f2f' }}>{p.re}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', fontSize: 11.5, color: '#9aa2ad', lineHeight: 1.55 }}>
            三列分别直接查 GB/T 2828.1-2012 表 2-A / 2-B / 2-C，箭头已解析为最终执行字码、n、Ac 和 Re。表 2-C 使用自身的字码—样本量关系，未使用“降两档”近似。
          </div>
        </Card>
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>{STATE_META[referenceState].label}参考方案表（当前检验水平与 AQL）</div>
          <div style={{ display: 'flex', gap: 5, marginLeft: 'auto' }}>
            {(['normal', 'tightened', 'reduced'] as InspState[]).map((state) => (
              <button type="button" key={state} aria-pressed={referenceState === state} style={tabStyle(referenceState === state)} onClick={() => setReferenceState(state)}>{TABLE_BY_STATE[state]}</button>
            ))}
          </div>
        </div>
        <div style={{ padding: '8px 16px', background: '#f7f9fb', borderBottom: '1px solid #edf0f3', fontSize: 11.5, color: '#6b7480' }}>
          依据 GB/T 2828.1-2012 表 1 + 表 {TABLE_BY_STATE[referenceState]}；“初始字码”来自表 1，“执行字码”为主表箭头解析后的最终字码。高亮行为当前批量。
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'left' }}>
              <th style={{ padding: '9px 16px', fontWeight: 600 }}>批量范围 N</th>
              <th style={{ padding: '9px 8px', fontWeight: 600 }}>初始字码</th>
              <th style={{ padding: '9px 8px', fontWeight: 600 }}>执行字码</th>
              <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>样本量 n</th>
              <th style={{ padding: '9px 8px', fontWeight: 600, textAlign: 'right' }}>Ac 接收</th>
              <th style={{ padding: '9px 16px', fontWeight: 600, textAlign: 'right' }}>Re 拒收</th>
            </tr>
          </thead>
          <tbody>
            {planTableRows(aqlLevel, aqlAQL, aqlLot, referenceState).map((row) => (
              <tr key={row.label} style={{ borderTop: '1px solid #f0f2f5', ...(row.active ? { background: '#e7f0f9' } : {}) }}>
                <td className="mono" style={{ padding: '8px 16px', color: '#33404f' }}>{row.label}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#5b6472' }}>{row.initialCode}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#5b6472' }}>{row.code}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#2a333f', textAlign: 'right', fontWeight: 600 }}>{row.fullInspect ? `${aqlLot} 全检` : row.n}</td>
                <td className="mono" style={{ padding: '8px 8px', color: '#2c8a45', textAlign: 'right', fontWeight: 600 }}>{row.ac}</td>
                <td className="mono" style={{ padding: '8px 16px', color: '#c22f2f', textAlign: 'right', fontWeight: 600 }}>{row.re}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
