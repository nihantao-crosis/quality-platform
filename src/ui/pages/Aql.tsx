/** 抽样检验 AQL—正式主表、实际批判定、责任追溯与第 9.3/9.4 条转移规则。 */
import { Fragment, useState } from 'react';
import { useApp } from '../../store/appStore';
import {
  rqlForResult, producerRiskPct, masterPlanByState, CODE_LETTER_TABLE, MAX_LOT_SIZE, TABLE_BY_STATE, AQL_COLS,
  aqlRegime, ocPa, maxNonconforming,
  decideLot, recordInspection, plansByState, normalizeSwitchStatus,
  AQL_TRACE_LIMITS,
  restoreNormalInspection, resumeTightenedInspection, setSwitchConditions,
  type InspectionLevel, type InspState, type NonconformingDisposition, type SamplingPlan,
} from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, CardHeader, KvRows, tabStyle } from '../common';
import { OcCurveChart } from '../charts/OcCurveChart';
import { Svg, Ln, Txt } from '../charts/primitives';

const STATE_META: Record<InspState, { label: string; bg: string; color: string }> = {
  normal: { label: '正常检验', bg: '#e7f0f9', color: '#1f6fb2' },
  tightened: { label: '加严检验', bg: '#fdecec', color: '#c22f2f' },
  reduced: { label: '放宽检验', bg: '#e8f4ea', color: '#2c8a45' },
};

// K2:下拉覆盖全部 26 档(0.010–10 百分不合格品 + 15–1000 每百单位不合格数);常用 6 档保留为快捷芯片不变。
const AQL_QUICK = [0.65, 1.0, 1.5, 2.5, 4.0, 6.5];

/**
 * per100 体系专用 OC 曲线:Pa(λ) = poissonCdf(Ac, n·λ/100),横轴为「每百单位不合格数 λ」。
 * 既有 OcCurveChart 内部固定二项 CDF 与「批不良率」横轴(K2 不在其文件属权内),
 * 故 per100 在本页用同一套 SVG 基元内联绘制,视觉风格与其保持一致。
 */
function OcCurvePer100({ T, plan, aql, rqlLambda }: { T: ChartTokens; plan: SamplingPlan; aql: number; rqlLambda?: number }) {
  const W = 960;
  const H = 330;
  const m = { t: 24, r: 34, b: 50, l: 56 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  // 横轴上限:覆盖 AQL 点与 RQL 点并留边;RQL 未达到时以 3×AQL 展示曲线形状
  const lmax = Math.max(aql * 1.6, (rqlLambda ?? aql * 3) * 1.25);
  const X = (l: number) => m.l + (l / lmax) * pw;
  const Y = (pa: number) => m.t + (1 - pa) * ph;
  const fmtL = (l: number) => (lmax >= 100 ? l.toFixed(0) : l.toFixed(1));
  const pts: string[] = [];
  for (let i = 0; i <= 140; i++) {
    const l = (lmax * i) / 140;
    pts.push(X(l) + ',' + Y(ocPa(plan, l, 'per100')));
  }
  const mark = (l: number, col: string, lab: string) => {
    const pa = ocPa(plan, l, 'per100');
    return (
      <Fragment key={lab}>
        <Ln x1={X(l)} y1={m.t} x2={X(l)} y2={m.t + ph} stroke={col} sw={1.3} dash="4 3" />
        <Ln x1={m.l} y1={Y(pa)} x2={X(l)} y2={Y(pa)} stroke={col} sw={1.3} dash="4 3" />
        <circle cx={X(l)} cy={Y(pa)} r={T.r + 1.5} fill={col} />
        <Txt x={X(l) + 6} y={Y(pa) - 9} s={lab + ' ' + (pa * 100).toFixed(0) + '%'} fill={col} size={10.5} weight={700} />
      </Fragment>
    );
  };
  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {Array.from({ length: 6 }, (_, g) => {
        const yy = m.t + (g / 5) * ph;
        return (
          <Fragment key={'g' + g}>
            <Ln x1={m.l} y1={yy} x2={m.l + pw} y2={yy} stroke={T.grid} sw={1} />
            <Txt x={m.l - 8} y={yy} s={100 - g * 20 + '%'} fill={T.axis} size={10} anchor="end" />
          </Fragment>
        );
      })}
      {Array.from({ length: 7 }, (_, g) => {
        const l = (lmax * g) / 6;
        return <Txt key={'x' + g} x={X(l)} y={H - 18} s={fmtL(l)} fill={T.axis} size={10} anchor="middle" />;
      })}
      <polyline points={pts.join(' ')} fill="none" stroke={T.point} strokeWidth={T.sw + 1} />
      {/* AQL 点语义是「绿线」(与二项版一致),不跟随主题中心线色 */}
      {mark(aql, '#1a8a3a', 'AQL')}
      {rqlLambda != null && mark(rqlLambda, T.limit, 'RQL')}
      <Txt x={m.l} y={m.t - 9} s="接收概率 Pa(泊松)" fill={T.text} size={11} weight={600} />
      <Txt x={m.l + pw} y={H - 2} s="每百单位不合格数 λ →" fill={T.axis} size={10} anchor="end" />
      <Ln x1={m.l} y1={m.t + ph} x2={m.l + pw} y2={m.t + ph} stroke={T.axis} sw={1} />
      <Ln x1={m.l} y1={m.t} x2={m.l} y2={m.t + ph} stroke={T.axis} sw={1} />
    </Svg>
  );
}
const DISPOSITION_LABEL: Record<NonconformingDisposition, string> = {
  none: '无不合格品', unrecorded: '未记录处置状态', pending: '已隔离，待负责部门处置', reworked: '已返工并按要求复验',
  replaced: '已替换不合格品', scrapped: '已报废不合格品', concession: '已取得让步接收批准',
};
type PositiveDisposition = Exclude<NonconformingDisposition, 'none' | 'unrecorded'>;
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
  const { aqlLot, aqlLevel, aqlAQL, aqlSwitch: storedSwitch, setAql, setAqlSwitch: setSw } = useApp();
  const sw = normalizeSwitchStatus(storedSwitch);
  const [lotDraft, setLotDraft] = useState<string | null>(null);
  const [lotError, setLotError] = useState<string | null>(null);
  const [nonconformingDraft, setNonconformingDraft] = useState('0');
  const [batchId, setBatchId] = useState('');
  const [inspector, setInspector] = useState('');
  const [originalInspection, setOriginalInspection] = useState(true);
  const [nonconformingDisposition, setNonconformingDisposition] = useState<PositiveDisposition | ''>('');
  const [batchError, setBatchError] = useState<string | null>(null);
  const [referenceState, setReferenceState] = useState<InspState>('normal');
  const statePlans = plansByState(aqlLot, aqlLevel, aqlAQL);
  const plan = statePlans[sw.state];
  // K2 体系分流:≤10 百分不合格品(二项,d≤n);≥15 每百单位不合格数(泊松,d 可大于 n)
  const regime = aqlRegime(aqlAQL);
  const per100 = regime === 'per100';
  const aqlP = aqlAQL / 100;
  const rql = rqlForResult(plan, 0.1, undefined, regime);
  const rqlP = rql.status === 'found' ? rql.p : undefined;
  const prodRisk = producerRiskPct(plan, aqlAQL);
  const meta = STATE_META[sw.state];
  const nonconforming = Number(nonconformingDraft);
  const hasNonconforming = nonconformingDraft.trim() !== '';
  // per100 体系录入上限放宽到 n×100(计点,d 可大于样本量);percent 仍以 n 为上限
  const dMax = maxNonconforming(plan, regime);
  const batchValid = hasNonconforming
    && Number.isSafeInteger(nonconforming) && nonconforming >= 0 && nonconforming <= dMax;
  const decision = batchValid ? decideLot(plan, nonconforming, regime) : null;
  const dispositionRequired = plan.fullInspect && batchValid && nonconforming > 0;
  const batchReady = batchValid && batchId.trim().length > 0 && inspector.trim().length > 0
    && (!dispositionRequired || nonconformingDisposition !== '') && !sw.suspended;
  const schemeLocked = sw.state !== 'normal';

  const submitInspection = () => {
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

  // per100 十档均为整数(15–1000),直接原样显示;percent 档维持既有格式不变
  const fmtAql = (a: number) => 'AQL ' + (a >= 15 ? String(a) : a < 0.1 ? String(a) : a.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5b6472' }}>
            批量 N
            <input
              type="number"
              min={2}
              max={MAX_LOT_SIZE}
              step={1}
              value={lotDraft ?? aqlLot}
              onFocus={() => { setLotDraft(String(aqlLot)); setLotError(null); }}
              onBlur={() => { if (!lotError) setLotDraft(null); }}
              onChange={(e) => {
                const raw = e.target.value;
                setLotDraft(raw);
                const v = Number(raw);
                if (raw.trim() === '' || !Number.isSafeInteger(v) || v < 2 || v > MAX_LOT_SIZE) {
                  setLotError(`请输入 2–${MAX_LOT_SIZE.toLocaleString()} 的整数（当前仍使用 ${aqlLot.toLocaleString()}）`);
                  return;
                }
                setLotError(null);
                setAql({ aqlLot: v });
              }}
              aria-invalid={lotError != null}
              className="mono"
              style={{ width: 132, padding: '6px 9px', border: `1px solid ${lotError ? '#c22f2f' : '#cfd5dd'}`, borderRadius: 4, fontSize: 12.5, color: '#2a333f' }}
            />
          </label>
          {lotError && <div role="alert" style={{ maxWidth: 360, marginTop: 4, fontSize: 11, color: '#c22f2f' }}>{lotError}</div>}
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
            title={schemeLocked ? '须按正式转移规则恢复正常检验后才能更改检验体系' : '全部 26 档 AQL(0.010–10 百分不合格品;15–1000 每百单位不合格数)'}
            value={aqlAQL}
            onChange={(e) => setAql({ aqlAQL: Number(e.target.value) })}
            style={{ padding: '5px 8px', border: `1px solid ${AQL_QUICK.includes(aqlAQL) ? '#cfd5dd' : '#1f6fb2'}`, borderRadius: 4, fontSize: 12, color: AQL_QUICK.includes(aqlAQL) ? '#5b6472' : '#1f6fb2', background: '#fff', cursor: schemeLocked ? 'not-allowed' : 'pointer' }}
          >
            <optgroup label="百分不合格品(AQL ≤ 10,二项)">
              {AQL_COLS.filter((a) => aqlRegime(a) === 'percent').map((a) => <option key={a} value={a}>{fmtAql(a)}</option>)}
            </optgroup>
            <optgroup label="每百单位不合格数(AQL 15–1000,泊松)">
              {AQL_COLS.filter((a) => aqlRegime(a) === 'per100').map((a) => <option key={a} value={a}>{fmtAql(a)}</option>)}
            </optgroup>
          </select>
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ padding: '5px 9px', borderRadius: 4, background: '#eef5fb', color: '#1f6fb2', fontSize: 11.5, fontWeight: 600 }}>
          GB/T 2828.1-2012 · 表 1 + {TABLE_BY_STATE[sw.state]}
        </span>
        {/* K2 体系徽标:per100 时明确提示计数口径变化(d 可大于 n) */}
        <span style={{ padding: '5px 9px', borderRadius: 4, background: per100 ? '#f3eefb' : '#f2f4f7', color: per100 ? '#7a4fb5' : '#5b6472', fontSize: 11.5, fontWeight: 600 }}>
          {per100 ? '每百单位不合格数体系 · 泊松(d 可大于 n)' : '百分不合格品体系 · 二项'}
        </span>
        {schemeLocked && (
          <span role="status" style={{ fontSize: 11.5, color: sw.suspended ? '#8a6414' : '#6b7480' }}>
            当前{sw.suspended ? '暂停' : meta.label}期间，检验水平与 AQL 已锁定
          </span>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
                <button type="button" onClick={() => setSw(resumeTightenedInspection(sw))} style={{ display: 'block', marginTop: 10, padding: '6px 12px', border: 0, borderRadius: 4, background: '#8a6414', color: '#fff', cursor: 'pointer' }}>
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
                    <input aria-label="实际不合格品数" type="number" min={0} max={dMax} step={1} value={nonconformingDraft} onChange={(e) => { setNonconformingDraft(e.target.value); setNonconformingDisposition(''); setBatchError(null); }} className="mono" style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '6px 8px', border: `1px solid ${batchValid ? '#cfd5dd' : '#c22f2f'}`, borderRadius: 4 }} />
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
                    <button type="button" onClick={() => setSw(restoreNormalInspection(sw, '负责部门因其他条件决定恢复正常检验'))} style={{ padding: '6px 12px', border: '1px solid #cfd5dd', background: '#fff', color: '#5b6472', borderRadius: 5, cursor: 'pointer' }}>
                      因其他条件恢复正常检验
                    </button>
                  )}
                </div>
              </>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 14 }}>
              <div style={{ padding: '8px 10px', border: '1px solid #edf0f3', borderRadius: 4, fontSize: 11.5, color: '#6b7480' }}>转移得分 <b className="mono" style={{ float: 'right', color: '#33404f' }}>{sw.switchingScore}/30</b></div>
              <div style={{ padding: '8px 10px', border: '1px solid #edf0f3', borderRadius: 4, fontSize: 11.5, color: '#6b7480' }}>加严不接收 <b className="mono" style={{ float: 'right', color: '#33404f' }}>{sw.tightenedRejections}/5</b></div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#5b6472' }}>
                <input type="checkbox" checked={sw.productionSteady} onChange={(e) => setSw(setSwitchConditions(sw, { productionSteady: e.target.checked }))} />
                生产稳定
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#5b6472' }}>
                <input type="checkbox" checked={sw.reducedApproved} onChange={(e) => setSw(setSwitchConditions(sw, { reducedApproved: e.target.checked }))} />
                负责部门同意放宽
              </label>
            </div>
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

            {sw.records.length > 0 && (
              <div style={{ marginTop: 14, overflowX: 'auto' }}>
                <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#33404f' }}>最近批次追溯记录</div>
                <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ color: '#8a929d', textAlign: 'left' }}>
                    <th style={{ padding: '5px 4px' }}>批次</th><th style={{ padding: '5px 4px' }}>N/水平/AQL</th><th style={{ padding: '5px 4px' }}>类型</th><th style={{ padding: '5px 4px' }}>方案</th><th style={{ padding: '5px 4px' }}>d</th><th style={{ padding: '5px 4px' }}>判定</th><th style={{ padding: '5px 4px' }}>不合格品处置</th><th style={{ padding: '5px 4px' }}>检验人</th>
                  </tr></thead>
                  <tbody>{sw.records.slice(-8).reverse().map((record) => (
                    <tr key={record.id} style={{ borderTop: '1px solid #f0f2f5' }}>
                      <td style={{ padding: '5px 4px', color: '#33404f' }}>{record.batchId}</td>
                      <td className="mono" style={{ padding: '5px 4px', color: '#6b7480' }}>{record.lot}/{record.level}/{record.aql}</td>
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
