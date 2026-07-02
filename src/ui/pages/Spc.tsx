/** SPC 控制图 ★深度实现 — 五种图型切换 / Nelson 判异开关 / 点选明细。 */
import { useApp, type SpcType } from '../../store/appStore';
import { nf, evalRules, type DataModel } from '../../core';
import type { ChartTokens } from '../tokens';
import { Card, KvRows, tabStyle, chipStyle } from '../common';
import { ControlChart } from '../charts/ControlChart';

interface ChartSpec {
  t: string;
  data: number[];
  cl: number;
  ucl: number;
  lcl: number;
  cll: string;
  main?: boolean;
  dec: number;
}

export function Spc({ M, T }: { M: DataModel; T: ChartTokens }) {
  const { spcType, setSpcType, spcRules, toggleRule, selSub, setSelSub } = useApp();

  const specs: Record<SpcType, { sub: string; charts: ChartSpec[] }> = {
    'xbar-r': {
      sub: '子组大小 n = 5 · 均值-极差',
      charts: [
        { t: '均值控制图 (X̄)', data: M.means, cl: M.xbarbar, ucl: M.uclX, lcl: M.lclX, cll: 'X̄', main: true, dec: 3 },
        { t: '极差控制图 (R)', data: M.ranges, cl: M.rbar, ucl: M.uclR, lcl: M.lclR, cll: 'R̄', dec: 3 },
      ],
    },
    'xbar-s': {
      sub: '子组大小 n = 5 · 均值-标准差',
      charts: [
        { t: '均值控制图 (X̄)', data: M.means, cl: M.xbarbar, ucl: M.uclXs, lcl: M.lclXs, cll: 'X̄', main: true, dec: 3 },
        { t: '标准差控制图 (S)', data: M.svals, cl: M.sbar, ucl: M.uclS, lcl: M.lclS, cll: 'S̄', dec: 4 },
      ],
    },
    'i-mr': {
      sub: '单值 - 移动极差',
      charts: [
        { t: '单值控制图 (I)', data: M.indiv, cl: M.indMean, ucl: M.iUcl, lcl: M.iLcl, cll: 'X̄', main: true, dec: 3 },
        { t: '移动极差图 (MR)', data: M.mr.slice(1) as number[], cl: M.mrbar, ucl: M.mrUcl, lcl: 0, cll: 'MR̄', dec: 3 },
      ],
    },
    p: {
      sub: '不良率 · 样本量 n = 50',
      charts: [{ t: '不良率控制图 (P)', data: M.pprop, cl: M.pbar, ucl: M.pUcl, lcl: M.pLcl, cll: 'p̄', main: true, dec: 3 }],
    },
    c: {
      sub: '单位缺陷数',
      charts: [{ t: '缺陷数控制图 (C)', data: M.cdata, cl: M.cbar, ucl: M.cUcl, lcl: M.cLcl, cll: 'c̄', main: true, dec: 1 }],
    },
  };

  const spec = specs[spcType];
  const main = spec.charts.find((c) => c.main)!;
  const sig = (main.ucl - main.cl) / 3;
  const { viol, list } = evalRules(main.data, main.cl, sig, spcRules);
  const sel = selSub != null && selSub < main.data.length ? selSub : null;
  const labWord = { 'xbar-r': '子组', 'xbar-s': '子组', 'i-mr': '观测', p: '样本', c: '单位' }[spcType];
  const ptLab = (i: number) => labWord + ' ' + (i + 1);

  const stats: { k: string; v: string }[] = [
    { k: '中心线 ' + main.cll, v: nf(main.cl, main.dec) },
    { k: 'UCL', v: nf(main.ucl, main.dec) },
    { k: 'LCL', v: nf(main.lcl, main.dec) },
  ];
  if (spcType === 'xbar-r') stats.push({ k: 'R̄', v: nf(M.rbar, 3) }, { k: 'σ̂ 组内', v: nf(M.sigmaWithin, 4) }, { k: '子组数', v: '25' });
  else if (spcType === 'xbar-s') stats.push({ k: 'S̄', v: nf(M.sbar, 4) }, { k: 'σ̂ (S̄/c₄)', v: nf(M.sbar / 0.94, 4) }, { k: '子组数', v: '25' });
  else if (spcType === 'i-mr') stats.push({ k: 'MR̄', v: nf(M.mrbar, 3) }, { k: 'σ̂ (MR̄/d₂)', v: nf(M.iSig, 4) }, { k: '观测数', v: '25' });
  else if (spcType === 'p') stats.push({ k: 'p̄', v: nf(M.pbar, 4) }, { k: '样本量 n', v: '50' }, { k: '样本数', v: '25' });
  else stats.push({ k: 'c̄', v: nf(M.cbar, 3) }, { k: '单位数', v: '25' });

  let subRows: { k: string; v: string }[] = [];
  if (sel != null) {
    if (spcType === 'xbar-r' || spcType === 'xbar-s') {
      const sg = M.subs[sel];
      subRows = sg.vals.map((v, j) => ({ k: '测量 ' + (j + 1), v: nf(v, 3) }));
      subRows.push({ k: '均值', v: nf(sg.mean, 3) }, { k: '极差', v: nf(sg.range, 3) }, { k: '标准差', v: nf(M.svals[sel], 4) });
    } else if (spcType === 'i-mr') {
      subRows = [{ k: '观测值', v: nf(M.indiv[sel], 3) }];
      if (sel > 0) subRows.push({ k: '移动极差', v: nf(M.mr[sel] as number, 3) });
    } else if (spcType === 'p') {
      subRows = [
        { k: '不良数', v: String(M.pdef[sel]) },
        { k: '样本量', v: '50' },
        { k: '不良率', v: nf(M.pprop[sel], 3) },
      ];
    } else {
      subRows = [{ k: '缺陷数', v: String(M.cdata[sel]) }];
    }
  }
  const selBad = sel != null && viol.has(sel);

  const typeTabs: Array<[SpcType, string]> = [['xbar-r', 'X̄-R'], ['xbar-s', 'X̄-S'], ['i-mr', 'I-MR'], ['p', 'P 图'], ['c', 'C 图']];
  const ruleToggles: Array<['r1' | 'r2' | 'r3' | 'r4', string]> = [['r1', '准则 1'], ['r2', '准则 2'], ['r3', '准则 3'], ['r4', '准则 4']];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>控制图类型</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {typeTabs.map(([k, l]) => (
            <div key={k} style={tabStyle(spcType === k)} onClick={() => setSpcType(k)}>{l}</div>
          ))}
        </div>
        <span style={{ width: 1, height: 22, background: '#e5e9ee' }} />
        <span style={{ fontSize: 12, color: '#8a929d', fontWeight: 600 }}>判异准则</span>
        <div style={{ display: 'flex', gap: 7 }}>
          {ruleToggles.map(([k, l]) => (
            <div key={k} style={chipStyle(spcRules[k])} onClick={() => toggleRule(k)}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: spcRules[k] ? '#1f6fb2' : '#c8cfd8' }} />
              {l}
            </div>
          ))}
        </div>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8a929d' }}>{spec.sub}</span>
      </Card>

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
                  data={ch.data}
                  cl={ch.cl}
                  ucl={ch.ucl}
                  lcl={ch.lcl}
                  clLabel={ch.cll}
                  dec={ch.dec}
                  h={ch.main ? 250 : 210}
                  zones={!!ch.main}
                  violations={ch.main ? viol : undefined}
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
            </div>
          )}
          <Card style={{ padding: '15px 16px' }}>
            <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>控制限与参数</div>
            <KvRows rows={stats} />
          </Card>
          <div style={{ background: '#fff', border: '1px solid #f0d3d3', borderRadius: 5, padding: '15px 16px', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
            <div style={{ fontWeight: 600, color: '#c22f2f', marginBottom: 6, display: 'flex', alignItems: 'center' }}>
              检验结果
              <span className="mono" style={{ marginLeft: 8, background: '#e23b3b', color: '#fff', fontSize: 11, padding: '1px 7px', borderRadius: 9 }}>{list.length}</span>
            </div>
            {list.length === 0 && (
              <div style={{ padding: '8px 0', fontSize: 12.5, color: '#2c8a45', fontWeight: 500 }}>✓ 未检出失控点，过程受控</div>
            )}
            {list.map((o) => (
              <div key={o.rule + '-' + o.i} style={{ padding: '8px 0', borderTop: '1px solid #f6eaea', fontSize: 12.5 }}>
                <div style={{ color: '#c22f2f', fontWeight: 600 }}>点 {o.i + 1} · 准则 {o.rule}</div>
                <div style={{ color: '#8a929d', marginTop: 2 }}>{o.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
