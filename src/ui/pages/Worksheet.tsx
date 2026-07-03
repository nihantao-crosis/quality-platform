/** 数据工作表 — Excel 式表格（双层 sticky 表头）+ 数据来源 + 列统计。
 * 演示数据显示原型的 11 列布局；导入数据显示动态测量列 + 均值/极差。 */
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { nf, evalRules } from '../../core';
import { Card, KvRows } from '../common';
import { Icon, type IconName } from '../icons';

const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

const numCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'right', color: '#2a333f' };
const txtCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'left', color: '#5b6472' };
const thTop: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, background: '#eceff3', border: '1px solid #d7dbe1', color: '#7a828d', fontWeight: 600, padding: '5px 12px', textAlign: 'left', minWidth: 78 };
const thName: CSSProperties = { position: 'sticky', top: 26, zIndex: 2, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#2a333f', fontWeight: 600, padding: '5px 12px', textAlign: 'left', fontFamily: 'IBM Plex Sans' };

export function Worksheet() {
  const { openModal, setImportTab, showToast, spcRules } = useApp();
  const { model: M } = useData();

  // 均值失控行高亮（与 SPC 主图一致：准则引擎）
  const means = M.subs.map((s) => s.mean);
  const sig = (M.uclX - M.xbarbar) / 3;
  const { viol } = M.hasSubgroups
    ? evalRules(means, M.xbarbar, sig, spcRules)
    : { viol: new Set<number>() };

  // 列头：C1 子组 + 测量列 + 均值/极差 +（演示）操作员/日期/班次
  const cols: { code: string; name: string }[] = [{ code: 'C1', name: '子组' }];
  M.colNames.forEach((n, i) => cols.push({ code: `C${i + 2}`, name: n }));
  const extra: Array<[string, string]> = [
    ...(M.hasSubgroups ? ([['', '均值'], ['', '极差']] as Array<[string, string]>) : []),
    ...(M.isDemo ? ([['-T', '操作员'], ['-D', '日期'], ['-T', '班次']] as Array<[string, string]>) : []),
  ];
  extra.forEach(([suffix, name], i) =>
    cols.push({ code: `C${M.colNames.length + 2 + i}${suffix}`, name }),
  );

  const sources: Array<{ icon: IconName; iconColor: string; label: string; status: string; statusColor: string; onClick: () => void }> = [
    { icon: 'grid', iconColor: '#2c8a45', label: 'Excel / CSV 导入', status: '已连接', statusColor: '#2c8a45', onClick: () => { setImportTab('csv'); openModal('import'); } },
    { icon: 'table', iconColor: '#2c8a45', label: '手工录入', status: '启用', statusColor: '#2c8a45', onClick: () => showToast('已切换到手工录入模式') },
    { icon: 'gauge', iconColor: '#1f6fb2', label: 'MES 自动采集', status: '实时', statusColor: '#1f6fb2', onClick: () => { setImportTab('mes'); openModal('import'); } },
    { icon: 'check', iconColor: '#8a929d', label: '扫码录入', status: '待配置', statusColor: '#8a929d', onClick: () => showToast('扫码录入待配置') },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 268px', gap: 16 }}>
      <div style={{ background: '#fff', border: '1px solid #d7dbe1', borderRadius: 5, overflow: 'hidden', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
          <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 12.5, whiteSpace: 'nowrap', minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...thTop, left: 0, zIndex: 3, width: 44, minWidth: 44 }} />
                {cols.map((c) => (
                  <th key={c.code} style={thTop}>{c.code}</th>
                ))}
              </tr>
              <tr>
                <th style={{ ...thName, left: 0, zIndex: 3, border: '1px solid #d7dbe1' }} />
                {cols.map((c) => (
                  <th key={c.code} style={thName}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {M.subs.map((s, i) => {
                const ooc = viol.has(i);
                // content-visibility: 大数据集时浏览器跳过屏外行渲染（低成本虚拟化）
                return (
                  <tr key={s.i} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 30px' } as React.CSSProperties}>
                    <td style={{ position: 'sticky', left: 0, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#9aa2ad', textAlign: 'center', padding: '5px 6px', fontWeight: 600 }}>{s.i}</td>
                    <td style={{ ...numCell, color: '#9aa2ad' }}>{s.i}</td>
                    {s.vals.map((v, j) => (
                      <td key={j} style={numCell}>{nf(v, 3)}</td>
                    ))}
                    {M.hasSubgroups && (
                      <>
                        <td style={{ ...numCell, fontWeight: 600, ...(ooc ? { background: '#fdecec', color: '#c22f2f' } : { color: '#1f6fb2' }) }}>{nf(s.mean, 3)}</td>
                        <td style={numCell}>{nf(s.range, 3)}</td>
                      </>
                    )}
                    {M.isDemo && (
                      <>
                        <td style={txtCell}>{OPS[i % 3]}</td>
                        <td style={txtCell}>{'2026-06-' + String((i % 28) + 1).padStart(2, '0')}</td>
                        <td style={txtCell}>{SHIFTS[i % 3]}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>数据来源</div>
          {sources.map((s) => (
            <div key={s.label} className="hov-source" onClick={s.onClick} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', margin: '0 -8px', borderRadius: 5, borderTop: '1px solid #f2f4f6', cursor: 'pointer' }}>
              <span style={{ display: 'inline-flex' }}><Icon name={s.icon} color={s.iconColor} /></span>
              <span style={{ fontSize: 12.5, color: '#3a4350' }}>{s.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: s.statusColor, fontWeight: 600 }}>{s.status}</span>
            </div>
          ))}
        </Card>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>列统计 · {M.isDemo ? 'C2 直径' : '全部测量'}</div>
          <KvRows
            valueWeight={500}
            rows={[
              { k: '样本量 N', v: String(M.all.length) },
              { k: '均值', v: nf(M.oMean, 4) },
              { k: '标准差', v: nf(M.oSd, 4) },
              { k: '最小值', v: nf(Math.min(...M.all), 3) },
              { k: '最大值', v: nf(Math.max(...M.all), 3) },
              { k: '极差', v: nf(Math.max(...M.all) - Math.min(...M.all), 3) },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
