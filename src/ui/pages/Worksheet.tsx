/** 数据工作表 — Excel 式表格（双层 sticky 表头）+ 手工录入编辑 + 数据来源 + 列统计。
 * 演示数据显示原型的 11 列布局；导入数据显示动态测量列 + 均值/极差。
 * 测量单元格双击可编辑（编辑演示集自动转「副本」），支持添加子组与删行。 */
import { useState, useEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { nf, evalRules, parseMatrix, arrMin, arrMax, prepareSpcData, columnDisplayDp } from '../../core';
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
function EditableCell({ value, dp, pending = false, onCommit }: { value: number; dp: number; pending?: boolean; onCommit: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!editing) {
    return (
      <td
        style={{ ...numCell, cursor: 'cell', ...(pending ? { background: '#fff6e6', color: '#a46b00', fontFamily: 'IBM Plex Sans', fontStyle: 'italic' } : {}) }}
        title={pending ? '尚未录入；双击输入实测值（实测为 0 也请确认录入）' : `${value}(双击编辑)`}
        onDoubleClick={() => {
          setDraft(pending ? '' : String(value));
          setEditing(true);
        }}
      >
        {pending ? '待录入' : nf(value, dp)}
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
          <button
            type="button"
            className="col-del"
            aria-label={`删除测量列：${name}`}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{ border: 0, padding: 0, background: 'transparent', color: '#c22f2f', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
          >
            ×
          </button>
        )}
      </span>
    </th>
  );
}

export function Worksheet() {
  const {
    openModal, setImportTab, showToast, spcRules, spcRuleK, selSub,
    spcDataLayout, spcValueCol, spcSubgroupCol,
  } = useApp();
  const { model: M, textCols, pendingCells, updateCell, addSubgroupRow, deleteRow, renameColumn, deleteColumn, insertColumn } = useData();
  const prepared = prepareSpcData(M, textCols, {
    layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
    pendingCells,
  });
  // 只有行式转换与原工作表行一一对齐，才能把均值/极差安全回显到原行。
  const rowSpc = !prepared.error && prepared.layout === 'rows'
    && prepared.model?.hasSubgroups && prepared.model.k === M.k
    ? prepared.model
    : null;

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
      const outcome = importMatrix('剪贴板数据', r.colNames, r.rows, r.textCols);
      const note = r.textCols.length > 0 ? ` · 含 ${r.textCols.length} 个分组列` : '';
      if (outcome.persisted || outcome.archiving) {
        showToast(`已粘贴导入 · ${r.rows.length} 行 × ${r.colNames.length} 个数值列${note}`);
      } else {
        showToast('⚠ 粘贴数据已导入到内存,但浏览器存储空间不足,尚未持久化——刷新将丢失！请立即「文件 → 导出项目」备份');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importMatrix, showToast]);

  // 均值失控行高亮（与 SPC 主图一致：准则引擎）
  const means = rowSpc?.subs.map((s) => s.mean) ?? [];
  const sig = rowSpc ? (rowSpc.uclX - rowSpc.xbarbar) / 3 : Number.NaN;
  const { viol } = rowSpc
    ? evalRules(means, rowSpc.xbarbar, sig, spcRules, spcRuleK)
    : { viol: new Set<number>() };

  // 列统计(大数组安全 min/max)
  const analysisValues = prepared.model?.all ?? [];
  const allMin = analysisValues.length ? arrMin(analysisValues) : Number.NaN;
  const allMax = analysisValues.length ? arrMax(analysisValues) : Number.NaN;

  // 显示精度:按「列」量级自适应(3–6 位;全整数列如部件/操作员 ID 显示 0 位,即 1/2/3 而非 1.000)
  // 逻辑抽为纯函数 columnDisplayDp(core/gageData),可单测;悬停提示仍显示全精度原值
  const colDp = useMemo(
    () => M.colNames.map((_, j) => columnDisplayDp(M.subs.map((sub) => sub.vals[j]))),
    [M],
  );
  // 均值/极差列保持 ≥3 位:整数 ID 列的 dp=0 不应连带压缩统计列精度
  const meanDp = colDp.length ? Math.max(3, ...colDp) : 3;
  const pendingSet = useMemo(() => new Set(pendingCells.map((p) => `${p.row}:${p.col}`)), [pendingCells]);

  // 虚拟窗口边界
  const winStart = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const winEnd = virtual ? Math.min(M.k, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN) : M.k;
  const visibleSubs = virtual ? M.subs.slice(winStart, winEnd) : M.subs;

  // 公式引擎的 C1/C2…只指真实数值列；隐含子组标签不能占用 C1。
  const cols: { code: string; name: string }[] = [{ code: 'ID', name: '子组' }];
  M.colNames.forEach((n, i) => cols.push({ code: `C${i + 1}`, name: n }));
  textCols.forEach((column, i) => cols.push({ code: `T${i + 1}`, name: column.name }));
  const extra: Array<[string, string]> = [
    ...(rowSpc ? ([['', '均值'], ['', '极差']] as Array<[string, string]>) : []),
    ...(M.isDemo ? ([['-T', '操作员'], ['-D', '日期'], ['-T', '班次']] as Array<[string, string]>) : []),
  ];
  extra.forEach(([suffix, name], i) => cols.push({ code: `S${i + 1}${suffix}`, name }));

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
                        <button
                          type="button"
                          className="ws-del"
                          aria-label={`删除子组 ${s.i}`}
                          onClick={() => { deleteRow(i); showToast(`已删除子组 ${s.i}`); }}
                          style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', color: '#c22f2f', fontWeight: 700, fontFamily: 'inherit' }}
                        >
                          ×
                        </button>
                      )}
                    </td>
                    <td style={{ ...numCell, color: '#9aa2ad' }}>{s.i}</td>
                    {s.vals.map((v, j) => (
                      <EditableCell key={j} value={v} dp={colDp[j]} pending={pendingSet.has(`${i}:${j}`)} onCommit={(nv) => updateCell(i, j, nv)} />
                    ))}
                    {textCols.map((column) => <td key={column.name} style={txtCell}>{column.values[i] ?? ''}</td>)}
                    {rowSpc && (
                      <>
                        <td title={String(rowSpc.subs[i].mean)} style={{ ...numCell, fontWeight: 600, ...(ooc ? { background: '#fdecec', color: '#c22f2f' } : { color: '#1f6fb2' }) }}>{nf(rowSpc.subs[i].mean, meanDp)}</td>
                        <td title={String(rowSpc.subs[i].range)} style={numCell}>{nf(rowSpc.subs[i].range, meanDp)}</td>
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
            <button
              type="button"
              onClick={() => { addSubgroupRow(); showToast('已添加子组（复制末行,双击单元格修改）'); }}
              style={{ flex: 1, border: 0, padding: '7px 0', textAlign: 'center', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              ＋ 子组
            </button>
            <button
              type="button"
              onClick={() => { insertColumn(); showToast('已插入数值列（双击列名可重命名）'); }}
              title="在末尾插入一个数值列；SPC 会按数据角色校验真正子组大小"
              style={{ flex: 1, padding: '7px 0', textAlign: 'center', border: '1px solid #cfd5dd', color: '#3a4350', background: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              ＋ 数值列
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 8, lineHeight: 1.5 }}>
            双击测量单元格编辑值、双击列名重命名;悬停行号删行、悬停列名删列。{M.isDemo ? '编辑演示集将另存为「质检数据 (副本)」。' : '修改即时保存。'}
          </div>
        </Card>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>数据来源</div>
          {sources.map((s) => (
            <button type="button" key={s.label} className="hov-source" onClick={s.onClick} style={{ width: 'calc(100% + 16px)', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', margin: '0 -8px', border: 0, borderTop: '1px solid #f2f4f6', background: 'transparent', borderRadius: 5, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ display: 'inline-flex' }}><Icon name={s.icon} color={s.iconColor} /></span>
              <span style={{ fontSize: 12.5, color: '#3a4350' }}>{s.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: s.statusColor, fontWeight: 600 }}>{s.status}</span>
            </button>
          ))}
        </Card>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>列统计 · {prepared.error ? '角色待配置' : prepared.variableName}</div>
          {prepared.model ? (
            <KvRows
              valueWeight={500}
              rows={[
                { k: '样本量 N', v: String(analysisValues.length) },
                { k: '均值', v: nf(prepared.model.oMean, 4) },
                { k: '标准差', v: nf(prepared.model.oSd, 4) },
                { k: '最小值', v: nf(allMin, 3) },
                { k: '最大值', v: nf(allMax, 3) },
                { k: '极差', v: nf(allMax - allMin, 3) },
              ]}
            />
          ) : (
            <div style={{ fontSize: 12, color: '#b05b2f', lineHeight: 1.6 }}>数值列角色存在歧义，请在 SPC 页选择测量值与子组 ID；这里不显示混算统计。</div>
          )}
        </Card>
      </div>
    </div>
  );
}
