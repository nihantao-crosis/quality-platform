/** 数据工作表 — Excel 式表格（双层 sticky 表头）+ 数据来源 + 列统计。 */
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import { nf, type DataModel } from '../../core';
import { Card, KvRows } from '../common';
import { Icon, type IconName } from '../icons';

const WS_COLS = [
  { code: 'C1', name: '子组' }, { code: 'C2', name: '直径1' }, { code: 'C3', name: '直径2' },
  { code: 'C4', name: '直径3' }, { code: 'C5', name: '直径4' }, { code: 'C6', name: '直径5' },
  { code: 'C7', name: '均值' }, { code: 'C8', name: '极差' }, { code: 'C9-T', name: '操作员' },
  { code: 'C10-D', name: '日期' }, { code: 'C11-T', name: '班次' },
];
const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

const numCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'right', color: '#2a333f' };
const txtCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'left', color: '#5b6472' };

export function Worksheet({ M }: { M: DataModel }) {
  const { openModal, setImportTab, showToast } = useApp();

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
                <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, background: '#eceff3', border: '1px solid #d7dbe1', width: 44 }} />
                {WS_COLS.map((c) => (
                  <th key={c.code} style={{ position: 'sticky', top: 0, zIndex: 2, background: '#eceff3', border: '1px solid #d7dbe1', color: '#7a828d', fontWeight: 600, padding: '5px 12px', textAlign: 'left', minWidth: 78 }}>{c.code}</th>
                ))}
              </tr>
              <tr>
                <th style={{ position: 'sticky', top: 26, left: 0, zIndex: 3, background: '#f4f6f8', border: '1px solid #d7dbe1' }} />
                {WS_COLS.map((c) => (
                  <th key={c.code} style={{ position: 'sticky', top: 26, zIndex: 2, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#2a333f', fontWeight: 600, padding: '5px 12px', textAlign: 'left', fontFamily: 'IBM Plex Sans' }}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {M.subs.map((s, i) => {
                const oocMean = M.oocX.includes(s.i);
                return (
                  <tr key={s.i}>
                    <td style={{ position: 'sticky', left: 0, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#9aa2ad', textAlign: 'center', padding: '5px 6px', fontWeight: 600 }}>{s.i}</td>
                    <td style={{ ...numCell, color: '#9aa2ad' }}>{s.i}</td>
                    {s.vals.map((v, j) => (
                      <td key={j} style={numCell}>{nf(v, 3)}</td>
                    ))}
                    <td style={{ ...numCell, fontWeight: 600, ...(oocMean ? { background: '#fdecec', color: '#c22f2f' } : { color: '#1f6fb2' }) }}>{nf(s.mean, 3)}</td>
                    <td style={numCell}>{nf(s.range, 3)}</td>
                    <td style={txtCell}>{OPS[i % 3]}</td>
                    <td style={txtCell}>{'2026-06-' + String((i % 28) + 1).padStart(2, '0')}</td>
                    <td style={txtCell}>{SHIFTS[i % 3]}</td>
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
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>列统计 · C2 直径</div>
          <KvRows
            valueWeight={500}
            rows={[
              { k: '样本量 N', v: '125' },
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
