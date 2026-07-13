/** 数据工作表 — Excel 式表格（双层 sticky 表头）+ 手工录入编辑 + 数据来源 + 列统计。
 * 演示数据显示原型的 11 列布局；导入数据显示动态测量列 + 均值/极差。
 * 测量单元格双击可编辑（编辑演示集自动转「副本」），支持添加子组与删行。 */
import { useState, useEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { nf, evalRules, parseMatrix, arrMin, arrMax } from '../../core';
import { Card, KvRows } from '../common';
import { Icon, type IconName } from '../icons';

const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

/** 行虚拟化:超过该行数只渲染可视窗口(±OVERSCAN 行),其余用等高占位撑开滚动条 */
const VIRTUAL_AT = 400;
const ROW_H = 30;
const OVERSCAN = 12;

const numCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'right', color: '#2a333f' };
const txtCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'left', color: '#5b6472' };
const thTop: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, background: '#eceff3', border: '1px solid #d7dbe1', color: '#7a828d', fontWeight: 600, padding: '5px 12px', textAlign: 'left', minWidth: 78 };
const thName: CSSProperties = { position: 'sticky', top: 26, zIndex: 2, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#2a333f', fontWeight: 600, padding: '5px 12px', textAlign: 'left', fontFamily: 'IBM Plex Sans' };

/** 双击进入编辑态的测量单元格。dp=按数据量级自适应的小数位;悬停显示全精度原值。 */
function EditableCell({ value, dp, onCommit }: { value: number; dp: number; onCommit: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!editing) {
    return (
      <td
        style={{ ...numCell, cursor: 'cell' }}
        title={`${value}(双击编辑)`}
        onDoubleClick={() => {
          setDraft(String(value));
          setEditing(true);
        }}
      >
        {nf(value, dp)}
      </td>
    );
  }
  const commit = () => {
    const v = parseFloat(draft);
    if (Number.isFinite(v)) onCommit(v);
    setEditing(false);
  };
  return (
    <td style={{ ...numCell, padding: 0 }}>
      <input
        autoFocus
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="mono"
        style={{ width: 78, border: '2px solid #1f6fb2', borderRadius: 2, padding: '3px 8px', fontSize: 12.5, textAlign: 'right', outline: 'none', boxSizing: 'border-box' }}
      />
    </td>
  );
}

/** 双击测量列名进入编辑;悬停显示删除按钮 */
function HeaderCell({ name, canDelete, onRename, onDelete }: {
  name: string; canDelete: boolean; onRename: (v: string) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (editing) {
    const commit = () => { onRename(draft); setEditing(false); };
    return (
      <th style={{ ...thName, padding: 0 }}>
        <input
          autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          style={{ width: 78, border: '2px solid #1f6fb2', borderRadius: 2, padding: '3px 8px', fontSize: 12.5, fontFamily: 'IBM Plex Sans', outline: 'none', boxSizing: 'border-box' }}
        />
      </th>
    );
  }
  return (
    <th
      className="col-head"
      style={{ ...thName, cursor: 'cell' }}
      title="双击重命名此列"
      onDoubleClick={() => { setDraft(name); setEditing(true); }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span>{name}</span>
        {canDelete && (
          <span
            className="col-del"
            title="删除此测量列"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{ color: '#c22f2f', fontWeight: 700, cursor: 'pointer' }}
          >
            ×
          </span>
        )}
      </span>
    </th>
  );
}

export function Worksheet() {
  const { openModal, setImportTab, showToast, spcRules, selSub } = useApp();
  const { model: M, updateCell, addSubgroupRow, deleteRow, renameColumn, deleteColumn, insertColumn } = useData();

  const importMatrix = useData((s) => s.importMatrix);

  // 行虚拟化(大数据集):跟踪滚动位置,只渲染可视窗口
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const virtual = useData((s) => s.model.k) > VIRTUAL_AT;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewH(el.clientHeight || 600);
  }, [virtual]);

  // SPC 点选联动：进入工作表时滚动到选中子组
  useEffect(() => {
    if (selSub == null) return;
    if (virtual && scrollRef.current) {
      scrollRef.current.scrollTop = Math.max(0, selSub * ROW_H - (scrollRef.current.clientHeight - ROW_H) / 2);
    } else {
      document.getElementById(`ws-row-${selSub}`)?.scrollIntoView({ block: 'center' });
    }
  }, [selSub, virtual]);

  // 在工作表页直接 Ctrl/Cmd+V 粘贴表格 → 导入为新数据集（编辑单元格时不劫持）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (text.trim() === '') return;
      const r = parseMatrix(text);
      if ('error' in r) {
        showToast('粘贴导入失败：' + r.error);
        return;
      }
      e.preventDefault();
      importMatrix('剪贴板数据', r.colNames, r.rows, r.textCols);
      const note = r.textCols.length > 0 ? ` · 含 ${r.textCols.length} 个分组列` : '';
      showToast(`已粘贴导入 · ${r.rows.length} 子组 × ${r.colNames.length} 测量列${note}`);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importMatrix, showToast]);

  // 均值失控行高亮（与 SPC 主图一致：准则引擎）
  const means = M.subs.map((s) => s.mean);
  const sig = (M.uclX - M.xbarbar) / 3;
  const { viol } = M.hasSubgroups
    ? evalRules(means, M.xbarbar, sig, spcRules)
    : { viol: new Set<number>() };

  // 列统计(大数组安全 min/max)
  const allMin = arrMin(M.all);
  const allMax = arrMax(M.all);

  // 显示精度:按「列」量级自适应(3–6 位)——混合量纲数据(如 过盈量 0.0675 与 压入力 1350 同表)
  // 不能用全局 σ,否则小量纲列被压到 3 位显示成 0.068,造成"数据被改"的误解
  const colDp = useMemo(() => M.colNames.map((_, j) => {
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const sub of M.subs) { const v = sub.vals[j]; if (v < lo) lo = v; if (v > hi) hi = v; sum += Math.abs(v); }
    const scale = Math.max(hi - lo, sum / M.k * 0.01, 1e-9); // 列内变差,退化时用量级的 1%
    return Math.max(3, Math.min(6, 2 - Math.floor(Math.log10(scale))));
  }), [M]);
  const meanDp = colDp.length ? Math.max(...colDp) : 3;

  // 虚拟窗口边界
  const winStart = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const winEnd = virtual ? Math.min(M.k, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN) : M.k;
  const visibleSubs = virtual ? M.subs.slice(winStart, winEnd) : M.subs;

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
    { icon: 'table', iconColor: '#2c8a45', label: '手工录入', status: '启用', statusColor: '#2c8a45', onClick: () => showToast('双击测量单元格即可编辑 · 右侧可添加子组') },
    { icon: 'gauge', iconColor: '#1f6fb2', label: 'MES 自动采集', status: '实时', statusColor: '#1f6fb2', onClick: () => { setImportTab('mes'); openModal('import'); } },
    { icon: 'check', iconColor: '#8a929d', label: '扫码录入', status: '待配置', statusColor: '#8a929d', onClick: () => showToast('扫码录入待配置') },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 268px', gap: 16 }}>
      <div style={{ background: '#fff', border: '1px solid #d7dbe1', borderRadius: 5, overflow: 'hidden', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
        <div
          ref={scrollRef}
          onScroll={virtual ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop) : undefined}
          style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}
        >
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
                {cols.map((c, ci) => {
                  // cols[0]=子组;cols[1..M.n]=测量列(可重命名/删除)
                  const measIdx = ci - 1;
                  const isMeasure = measIdx >= 0 && measIdx < M.colNames.length;
                  return isMeasure ? (
                    <HeaderCell
                      key={c.code}
                      name={c.name}
                      canDelete={M.n > 1}
                      onRename={(v) => renameColumn(measIdx, v)}
                      onDelete={() => { deleteColumn(measIdx); showToast(`已删除测量列「${c.name}」`); }}
                    />
                  ) : (
                    <th key={c.code} style={thName}>{c.name}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {virtual && winStart > 0 && <tr style={{ height: winStart * ROW_H }} />}
              {visibleSubs.map((s, vi) => {
                const i = winStart + vi;
                const ooc = viol.has(i);
                // 小数据集用 content-visibility 低成本跳渲染;大数据集由上方窗口化接管
                return (
                  <tr
                    key={s.i}
                    id={`ws-row-${i}`}
                    className="ws-row"
                    style={{
                      ...(virtual
                        ? { height: ROW_H }
                        : { contentVisibility: 'auto', containIntrinsicSize: 'auto 30px' }),
                      ...(selSub === i ? { outline: '2px solid #1f6fb2', outlineOffset: -2 } : {}),
                    } as React.CSSProperties}
                  >
                    <td
                      className="ws-rownum"
                      title={M.k > 2 ? '点击 × 删除此行' : undefined}
                      style={{ position: 'sticky', left: 0, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#9aa2ad', textAlign: 'center', padding: '5px 6px', fontWeight: 600 }}
                    >
                      <span className="ws-num">{s.i}</span>
                      {M.k > 2 && (
                        <span
                          className="ws-del"
                          onClick={() => { deleteRow(i); showToast(`已删除子组 ${s.i}`); }}
                          style={{ cursor: 'pointer', color: '#c22f2f', fontWeight: 700 }}
                        >
                          ×
                        </span>
                      )}
                    </td>
                    <td style={{ ...numCell, color: '#9aa2ad' }}>{s.i}</td>
                    {s.vals.map((v, j) => (
                      <EditableCell key={j} value={v} dp={colDp[j]} onCommit={(nv) => updateCell(i, j, nv)} />
                    ))}
                    {M.hasSubgroups && (
                      <>
                        <td title={String(s.mean)} style={{ ...numCell, fontWeight: 600, ...(ooc ? { background: '#fdecec', color: '#c22f2f' } : { color: '#1f6fb2' }) }}>{nf(s.mean, meanDp)}</td>
                        <td title={String(s.range)} style={numCell}>{nf(s.range, meanDp)}</td>
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
              {virtual && winEnd < M.k && <tr style={{ height: (M.k - winEnd) * ROW_H }} />}
            </tbody>
          </table>
        </div>
        {virtual && (
          <div style={{ padding: '5px 12px', fontSize: 11, color: '#98a1ac', borderTop: '1px solid #eef0f3' }}>
            大数据集已启用行虚拟化 · 共 {M.k.toLocaleString()} 行,仅渲染可视窗口({winStart + 1}–{winEnd})
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>手工录入</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div
              onClick={() => { addSubgroupRow(); showToast('已添加子组（复制末行,双击单元格修改）'); }}
              style={{ flex: 1, padding: '7px 0', textAlign: 'center', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              ＋ 子组
            </div>
            <div
              onClick={() => {
                if (M.n >= 10) { showToast('测量列已达上限 10'); return; }
                insertColumn();
                showToast('已插入测量列（双击列名可重命名）');
              }}
              title={M.n >= 10 ? '控制图常数表上限为 10' : '在末尾插入一个测量列'}
              style={{ flex: 1, padding: '7px 0', textAlign: 'center', border: '1px solid #cfd5dd', color: '#3a4350', background: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', ...(M.n >= 10 ? { opacity: 0.5 } : {}) }}
            >
              ＋ 测量列
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 8, lineHeight: 1.5 }}>
            双击测量单元格编辑值、双击列名重命名;悬停行号删行、悬停列名删列。{M.isDemo ? '编辑演示集将另存为「质检数据 (副本)」。' : '修改即时保存。'}
          </div>
        </Card>
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
              { k: '最小值', v: nf(allMin, 3) },
              { k: '最大值', v: nf(allMax, 3) },
              { k: '极差', v: nf(allMax - allMin, 3) },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
