/** 数据工作表 — Excel 式表格（双层 sticky 表头）+ 手工录入编辑 + 数据来源 + 列统计。
 * Minitab 式布局:左侧 sticky 行号槽(含删行按钮)+ 业务数据列,无重复的 ID/行 数据列(716-R3 P1-1);
 * 导入数据显示动态测量列,行式子组口径追加 均值/极差或标准差。
 * 测量单元格可双击或按 Enter/F2 编辑（编辑演示集自动转「副本」），支持添加子组与删行。 */
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import { PROJECT_BACKUP_HINT, datasetWriteNotes, useData } from '../../store/dataStore';
import { nf, evalRules, evalLimitedRules, parseMatrix, arrMin, arrMax, prepareSpcData, columnDisplayDp, worksheetDisplayOrder, withSigmaMethod } from '../../core';
import { errText } from '../../platform/adapter';
import { assertClipboardImportText } from '../../platform/importLimits';
import { Card, KvRows } from '../common';
import { Icon, type IconName } from '../icons';
import { isImeComposing } from '../imeGuard';
import { parseStrictNumber } from '../../core/numberInput';

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

/** 双击或从键盘进入编辑态的测量单元格。dp=按数据量级自适应的小数位;悬停显示全精度原值。 */
function EditableCell({ value, dp, pending = false, label, gridRow, gridCol, active, onActivate, onNavigate, onCommit }: {
  value: number;
  dp: number;
  pending?: boolean;
  label: string;
  gridRow: number;
  gridCol: number;
  active: boolean;
  onActivate: (row: number, col: number) => void;
  onNavigate: (event: React.KeyboardEvent<HTMLElement>, row: number, col: number) => void;
  onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const cellRef = useRef<HTMLTableCellElement>(null);
  const restoreFocus = useRef(false);
  const beginEditing = () => {
    setDraft(pending ? '' : String(value));
    setEditing(true);
  };
  const finishEditing = (save: boolean, refocus: boolean, badInput = false) => {
    if (save) {
      // GAP-8-4 同族:严格解析,不再用 parseFloat 前缀截断(「12.5mm」→12.5)。拒绝时明确提示,
      // 不静默丢弃;type=number 被浏览器净化为空串的非法输入(badInput)同样提示。
      const parsed = parseStrictNumber(draft);
      if (parsed.ok) onCommit(parsed.value);
      else if (!parsed.empty || badInput) {
        useApp.getState().showToast(`未修改${label}：${parsed.empty ? '输入的内容不是有效数值' : parsed.reason}`);
      }
    }
    restoreFocus.current = refocus;
    setEditing(false);
  };
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      cellRef.current?.focus();
    }
  }, [editing]);
  if (!editing) {
    return (
      <td
        ref={cellRef}
        role="gridcell"
        tabIndex={active ? 0 : -1}
        data-grid-row={gridRow}
        data-grid-col={gridCol}
        className="worksheet-editable-cell"
        aria-label={`${label}${pending ? '，待录入' : `，当前值 ${value}`}；按 Enter 或 F2 编辑`}
        style={{ ...numCell, cursor: 'cell', ...(pending ? { background: '#fff6e6', color: '#a46b00', fontFamily: 'IBM Plex Sans', fontStyle: 'italic' } : {}) }}
        title={pending ? '尚未录入；双击或按 Enter/F2 输入实测值（实测为 0 也请确认录入）' : `${value}（双击或按 Enter/F2 编辑）`}
        onDoubleClick={beginEditing}
        onFocus={() => onActivate(gridRow, gridCol)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            beginEditing();
            return;
          }
          onNavigate(event, gridRow, gridCol);
        }}
      >
        {pending ? '待录入' : nf(value, dp)}
      </td>
    );
  }
  return (
    <td
      ref={cellRef}
      role="gridcell"
      data-grid-row={gridRow}
      data-grid-col={gridCol}
      aria-label={`${label}，编辑中`}
      style={{ ...numCell, padding: 0 }}
    >
      <input
        autoFocus
        aria-label={`编辑${label}`}
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => finishEditing(true, false, e.currentTarget.validity?.badInput === true)}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            finishEditing(true, true, e.currentTarget.validity?.badInput === true);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finishEditing(false, true);
          }
        }}
        className="mono"
        style={{ width: 78, border: '2px solid #1f6fb2', borderRadius: 2, padding: '3px 8px', fontSize: 12.5, textAlign: 'right', outline: 'none', boxSizing: 'border-box' }}
      />
    </td>
  );
}

/** 双击或按 Enter/F2 重命名测量列；hover/focus 显示删除按钮。 */
function HeaderCell({ name, canDelete, gridCol, active, onActivate, onRequestFocus, onNavigate, onRename, onDelete }: {
  name: string;
  canDelete: boolean;
  gridCol: number;
  active: boolean;
  onActivate: (row: number, col: number) => void;
  onRequestFocus: (row: number, col: number) => void;
  onNavigate: (event: React.KeyboardEvent<HTMLElement>, row: number, col: number) => void;
  onRename: (v: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const headerRef = useRef<HTMLTableCellElement>(null);
  const restoreFocus = useRef(false);
  const beginEditing = () => { setDraft(name); setEditing(true); };
  const finishEditing = (save: boolean, refocus: boolean) => {
    if (save) onRename(draft);
    restoreFocus.current = refocus;
    setEditing(false);
  };
  const deleteColumnFromHeader = () => {
    onDelete();
    onRequestFocus(0, Math.max(0, gridCol - 1));
  };
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      headerRef.current?.focus();
    }
  }, [editing]);
  if (editing) {
    return (
      <th
        ref={headerRef}
        role="columnheader"
        data-grid-row={0}
        data-grid-col={gridCol}
        aria-label={`列 ${name}，重命名中`}
        style={{ ...thName, padding: 0 }}
      >
        <input
          autoFocus aria-label={`重命名列：${name}`} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishEditing(true, false)}
          onKeyDown={(e) => {
            // GAP-8-5:组字期间的 Enter/Esc 属于输入法(上屏拼音/关闭候选框),不得提交或退出重命名。
            if (isImeComposing(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              finishEditing(true, true);
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finishEditing(false, true);
            }
          }}
          style={{ width: 78, border: '2px solid #1f6fb2', borderRadius: 2, padding: '3px 8px', fontSize: 12.5, fontFamily: 'IBM Plex Sans', outline: 'none', boxSizing: 'border-box' }}
        />
      </th>
    );
  }
  return (
    <th
      ref={headerRef}
      role="columnheader"
      scope="col"
      tabIndex={active ? 0 : -1}
      data-grid-row={0}
      data-grid-col={gridCol}
      aria-keyshortcuts={canDelete ? 'Enter F2 Delete' : 'Enter F2'}
      aria-label={`列 ${name}；按 Enter 或 F2 重命名${canDelete ? '，按 Delete 删除列' : ''}`}
      className="col-head"
      style={{ ...thName, cursor: 'cell', ...(canDelete ? { padding: '5px 28px 5px 12px' } : {}) }}
      title="双击或按 Enter/F2 重命名此列"
      onDoubleClick={beginEditing}
      onFocus={() => onActivate(0, gridCol)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          beginEditing();
          return;
        }
        if (event.key === 'Delete' && canDelete) {
          event.preventDefault();
          deleteColumnFromHeader();
          return;
        }
        onNavigate(event, 0, gridCol);
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span>{name}</span>
        {canDelete && (
          <button
            type="button"
            tabIndex={-1}
            className="col-del"
            aria-label={`删除测量列：${name}`}
            onClick={(e) => { e.stopPropagation(); deleteColumnFromHeader(); }}
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
    openModal, setImportTab, showToast, spcType, spcRules, spcRuleK, selSub,
    spcDataLayout, spcValueCol, spcSubgroupCol, spcSigmaMethod,
  } = useApp();
  const { model: M, textCols, pendingCells, updateCell, addSubgroupRow, deleteRow, renameColumn, deleteColumn, insertColumn } = useData();
  // 记忆化(双审 P2):大工作表滚动/击键时不重跑 O(N) 解析
  const prepared = useMemo(
    () => prepareSpcData(M, textCols, {
      layout: spcDataLayout, valueColumn: spcValueCol, subgroupColumn: spcSubgroupCol,
      pendingCells,
    }),
    [M, textCols, pendingCells, spcDataLayout, spcValueCol, spcSubgroupCol],
  );
  // 只有行式转换与原工作表行一一对齐，才能把均值/极差安全回显到原行。
  // 审查修复(720):行高亮判异随 SPC 页 σ 估计方法,两视图同口径
  const rowSpc = useMemo(() => !prepared.error && prepared.layout === 'rows'
    && prepared.model?.hasSubgroups && prepared.model.k === M.k
    ? withSigmaMethod(prepared.model, spcSigmaMethod)
    : null, [prepared, M.k, spcSigmaMethod]);

  const importMatrix = useData((s) => s.importMatrix);

  // 行虚拟化(大数据集):跟踪滚动位置,只渲染可视窗口
  const scrollRef = useRef<HTMLDivElement>(null);
  const worksheetRef = useRef<HTMLDivElement>(null);
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
      const app = useApp.getState();
      const target = e.target;
      // 粘贴只属于当前工作表；弹窗、事务遮罩及文本编辑保留各自行为。
      if (app.modal || app.busyOverlay || e.defaultPrevented
        || !(target instanceof Element) || !worksheetRef.current?.contains(target)
        || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (text.trim() === '') return;
      e.preventDefault();
      try {
        assertClipboardImportText(text);
        const r = parseMatrix(text);
        if ('error' in r) {
          showToast('粘贴导入失败：' + r.error);
          return;
        }
        // UI-04:固定名「剪贴板数据」走同名写入策略——已编辑过的上一份粘贴数据保留，新数据另存为「剪贴板数据 (2)」
        const outcome = importMatrix('剪贴板数据', r.colNames, r.rows, r.textCols, [], { onNameConflict: 'rename' });
        const name = outcome.name ?? '剪贴板数据';
        const note = r.textCols.length > 0 ? ` · 含 ${r.textCols.length} 个分组列` : '';
        // UI-04:改名/挤出提示按原数据集的实际位置生成(最近列表 / 本机库 / 已移出)，不写死
        const writeNotes = datasetWriteNotes('剪贴板数据', outcome).map((text) => ` · ${text}`).join('');
        if (outcome.persisted || outcome.archiving) {
          showToast(`已粘贴导入「${name}」· ${r.rows.length} 行 × ${r.colNames.length} 个数值列${note}${writeNotes}`);
        } else {
          showToast(`⚠ 粘贴数据已导入到内存,但浏览器存储空间不足,尚未持久化——刷新将丢失！请立即${PROJECT_BACKUP_HINT}备份${writeNotes}`);
        }
      } catch (error) {
        showToast('粘贴导入失败：' + errText(error));
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importMatrix, showToast]);

  // 均值失控行高亮（与 SPC 主图一致：准则引擎）
  const rowSpcUsesS = Boolean(rowSpc && spcType === 'xbar-s');
  const { meanViol, dispersionViol, dispersionValues } = useMemo(() => {
    if (!rowSpc) return { meanViol: new Set<number>(), dispersionViol: new Set<number>(), dispersionValues: [] as number[] };
    const means = rowSpc.subs.map((sub) => sub.mean);
    const sig = ((rowSpcUsesS ? rowSpc.uclXs : rowSpc.uclX) - rowSpc.xbarbar) / 3;
    const options = { collectDetails: false };
    const meanResult = evalRules(means, rowSpc.xbarbar, sig, spcRules, spcRuleK, options);
    const dispersionValues = rowSpcUsesS ? rowSpc.svals : rowSpc.subs.map((sub) => sub.range);
    const dispersionResult = rowSpcUsesS
      ? evalLimitedRules(dispersionValues, rowSpc.sCl, rowSpc.uclS, rowSpc.lclS, spcRules, spcRuleK, undefined, options)
      : evalLimitedRules(dispersionValues, rowSpc.rCl, rowSpc.uclR, rowSpc.lclR, spcRules, spcRuleK, undefined, options);
    return { meanViol: meanResult.viol, dispersionViol: dispersionResult.viol, dispersionValues };
  }, [rowSpc, rowSpcUsesS, spcRules, spcRuleK]);

  // 列统计(大数组安全 min/max)
  const { allMin, allMax } = useMemo(() => {
    const values = prepared.model?.all ?? [];
    return {
      allMin: values.length ? arrMin(values) : Number.NaN,
      allMax: values.length ? arrMax(values) : Number.NaN,
    };
  }, [prepared]);

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

  // 列显示顺序按导入原列序交错(TextColumn.sourceIndex)。Minitab 式代号按显示位置统一编号，
  // 文本列追加 -T：例如「部件/测试人/螺钉高度」显示 C1/C2-T/C3。
  // 批次716-R3 P1-1:删除与左侧 sticky 行号槽重复的「ID/行」数据列(人工审核 PPT 10 页)——
  // Minitab 式工作表只有行号槽 + 业务数据列;行号槽表头在行式子组口径下显示「子组」语义,其余留空。
  const displayOrder = worksheetDisplayOrder(M.colNames.length, textCols);
  const cols: { code: string; name: string; measIdx: number | null }[] = [];
  displayOrder.forEach((ref, displayIndex) => {
    if (ref.kind === 'numeric') cols.push({ code: `C${displayIndex + 1}`, name: M.colNames[ref.index], measIdx: ref.index });
    else cols.push({ code: `C${displayIndex + 1}-T`, name: textCols[ref.index].name, measIdx: null });
  });
  const extra: Array<[string, string]> = [
    ...(rowSpc ? ([['', '均值'], ['', rowSpcUsesS ? '标准差' : '极差']] as Array<[string, string]>) : []),
    ...(M.isDemo ? ([['-T', '操作员'], ['-D', '日期'], ['-T', '班次']] as Array<[string, string]>) : []),
  ];
  extra.forEach(([suffix, name], i) => cols.push({ code: `S${i + 1}${suffix}`, name, measIdx: null }));

  // ARIA grid 是复合组件：整张工作表在页面 Tab 顺序中只能有一个停靠点，
  // 进入后由方向键在列头、行号和全部数据格之间移动。逻辑 row=0 是唯一
  // 可访问表头行，row=1..k 是数据行；col=0 是行号槽。
  const [activeGridCell, setActiveGridCell] = useState({ row: 0, col: 1 });
  const [gridFocusRequest, setGridFocusRequest] = useState(0);
  const activateGridCell = (row: number, col: number) => {
    setActiveGridCell((previous) => previous.row === row && previous.col === col
      ? previous
      : { row, col });
  };
  const requestGridFocus = (row: number, col: number) => {
    const nextRow = Math.max(0, Math.min(M.k, row));
    const nextCol = Math.max(0, Math.min(cols.length, col));
    if (virtual && nextRow > 0 && scrollRef.current) {
      const dataIndex = nextRow - 1;
      const cellTop = dataIndex * ROW_H;
      const cellBottom = cellTop + ROW_H;
      const viewportTop = scrollRef.current.scrollTop;
      const viewportHeight = scrollRef.current.clientHeight || viewH;
      const viewportBottom = viewportTop + viewportHeight;
      let nextScrollTop = viewportTop;
      if (cellTop < viewportTop) nextScrollTop = cellTop;
      else if (cellBottom > viewportBottom) nextScrollTop = Math.max(0, cellBottom - viewportHeight);
      if (nextScrollTop !== viewportTop) {
        scrollRef.current.scrollTop = nextScrollTop;
        setScrollTop(nextScrollTop);
      }
    }
    setActiveGridCell({ row: nextRow, col: nextCol });
    setGridFocusRequest((revision) => revision + 1);
  };
  const navigateGrid = (event: React.KeyboardEvent<HTMLElement>, row: number, col: number) => {
    if (event.target !== event.currentTarget) return;
    let nextRow = row;
    let nextCol = col;
    if (event.ctrlKey && event.key === 'Home') {
      nextRow = 0;
      nextCol = 0;
    } else if (event.ctrlKey && event.key === 'End') {
      nextRow = M.k;
      nextCol = cols.length;
    } else if (event.key === 'ArrowLeft') nextCol -= 1;
    else if (event.key === 'ArrowRight') nextCol += 1;
    else if (event.key === 'ArrowUp') nextRow -= 1;
    else if (event.key === 'ArrowDown') nextRow += 1;
    else if (event.key === 'Home') nextCol = 0;
    else if (event.key === 'End') nextCol = cols.length;
    else return;
    event.preventDefault();
    requestGridFocus(nextRow, nextCol);
  };
  // 派生列变化时以钳制后的坐标渲染 roving 停靠点，不用 effect 抢焦点。
  const logicalActiveGridRow = Math.min(activeGridCell.row, M.k);
  // 鼠标/触控滚动可能把当前虚拟行卸载；此时把唯一 tab stop 钳到窗口边界，
  // 避免整张 grid 暂时从页面 Tab 顺序消失。聚焦后 onFocus 会同步逻辑坐标。
  const activeGridRow = virtual && logicalActiveGridRow > 0
    ? Math.max(winStart + 1, Math.min(winEnd, logicalActiveGridRow))
    : logicalActiveGridRow;
  const activeGridCol = Math.min(activeGridCell.col, cols.length);

  useLayoutEffect(() => {
    if (gridFocusRequest === 0) return;
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(
      `[data-grid-row="${activeGridRow}"][data-grid-col="${activeGridCol}"]`,
    );
    target?.focus();
  }, [activeGridRow, activeGridCol, gridFocusRequest, winStart, winEnd]);

  const sources: Array<{ icon: IconName; iconColor: string; label: string; status: string; statusColor: string; onClick: () => void }> = [
    { icon: 'grid', iconColor: '#2c8a45', label: 'Excel / CSV 导入', status: '已连接', statusColor: '#2c8a45', onClick: () => { setImportTab('csv'); openModal('import'); } },
    { icon: 'table', iconColor: '#2c8a45', label: '手工录入', status: '启用', statusColor: '#2c8a45', onClick: () => showToast('双击测量单元格，或聚焦后按 Enter/F2 编辑 · 右侧可添加子组') },
    { icon: 'gauge', iconColor: '#1f6fb2', label: 'MES 自动采集', status: '实时', statusColor: '#1f6fb2', onClick: () => { setImportTab('mes'); openModal('import'); } },
    { icon: 'check', iconColor: '#8a929d', label: '扫码录入', status: '待配置', statusColor: '#8a929d', onClick: () => showToast('扫码录入待配置') },
  ];

  return (
    <div ref={worksheetRef} className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 268px', gap: 16 }}>
      <div style={{ background: '#fff', border: '1px solid #d7dbe1', borderRadius: 5, overflow: 'hidden', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
        <div
          ref={scrollRef}
          onScroll={virtual ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop) : undefined}
          style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}
        >
          <table
            className="mono"
            role="grid"
            aria-label="数据工作表"
            aria-rowcount={M.k + 1}
            aria-colcount={cols.length + 1}
            style={{ borderCollapse: 'collapse', fontSize: 12.5, whiteSpace: 'nowrap', minWidth: '100%' }}
          >
            <thead>
              {/* C#/S# 代号仅为视觉辅助；可访问列标题由下方唯一表头行承担。 */}
              <tr role="presentation" aria-hidden="true">
                <th style={{ ...thTop, left: 0, zIndex: 3, width: 44, minWidth: 44 }} />
                {cols.map((c) => (
                  <th key={c.code} style={thTop}>{c.code}</th>
                ))}
              </tr>
              <tr role="row" aria-rowindex={1}>
                {/* 行号槽表头:Minitab 行号槽无标题;行式子组口径保留「子组」语义(716-R3 P1-1) */}
                <th
                  role="columnheader"
                  scope="col"
                  tabIndex={activeGridRow === 0 && activeGridCol === 0 ? 0 : -1}
                  data-grid-row={0}
                  data-grid-col={0}
                  aria-label={rowSpc ? '子组行号列' : '行号列'}
                  style={{ ...thName, left: 0, zIndex: 3, border: '1px solid #d7dbe1', textAlign: 'center' }}
                  onFocus={() => activateGridCell(0, 0)}
                  onKeyDown={(event) => navigateGrid(event, 0, 0)}
                >
                  {rowSpc ? '子组' : ''}
                </th>
                {cols.map((c, displayIndex) => {
                  const gridCol = displayIndex + 1;
                  // measIdx 非空 = 数值测量列(可重命名/删除);列已按导入原序交错,不能再用位置推断
                  return c.measIdx != null ? (
                    <HeaderCell
                      key={c.code}
                      name={c.name}
                      canDelete={M.n > 1}
                      gridCol={gridCol}
                      active={activeGridRow === 0 && activeGridCol === gridCol}
                      onActivate={activateGridCell}
                      onRequestFocus={requestGridFocus}
                      onNavigate={navigateGrid}
                      onRename={(v) => renameColumn(c.measIdx!, v)}
                      onDelete={() => { deleteColumn(c.measIdx!); showToast(`已删除测量列「${c.name}」`); }}
                    />
                  ) : (
                    <th
                      key={c.code}
                      role="columnheader"
                      scope="col"
                      tabIndex={activeGridRow === 0 && activeGridCol === gridCol ? 0 : -1}
                      data-grid-row={0}
                      data-grid-col={gridCol}
                      style={thName}
                      onFocus={() => activateGridCell(0, gridCol)}
                      onKeyDown={(event) => navigateGrid(event, 0, gridCol)}
                    >
                      {c.name}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {virtual && winStart > 0 && (
                <tr role="presentation" aria-hidden="true" className="worksheet-virtual-spacer" style={{ height: winStart * ROW_H }}>
                  <td colSpan={cols.length + 1} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
              {visibleSubs.map((s, vi) => {
                const i = winStart + vi;
                const gridRow = i + 1;
                const meanOoc = meanViol.has(i);
                const dispersionOoc = dispersionViol.has(i);
                // 小数据集用 content-visibility 低成本跳渲染;大数据集由上方窗口化接管
                return (
                  <tr
                    key={s.i}
                    id={`ws-row-${i}`}
                    role="row"
                    aria-rowindex={i + 2}
                    className="ws-row"
                    style={{
                      ...(virtual
                        ? { height: ROW_H }
                        : { contentVisibility: 'auto', containIntrinsicSize: 'auto 30px' }),
                      ...(selSub === i ? { outline: '2px solid #1f6fb2', outlineOffset: -2 } : {}),
                    } as React.CSSProperties}
                  >
                    <td
                      tabIndex={activeGridRow === gridRow && activeGridCol === 0 ? 0 : -1}
                      data-grid-row={gridRow}
                      data-grid-col={0}
                      role="rowheader"
                      aria-keyshortcuts={M.k > 2 ? 'Delete' : undefined}
                      aria-label={`第 ${s.i} 行${M.k > 2 ? '；按 Delete 删除此行' : ''}`}
                      className="ws-rownum"
                      title={M.k > 2 ? '点击 × 删除此行' : undefined}
                      style={{ position: 'sticky', left: 0, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#9aa2ad', textAlign: 'center', padding: '5px 6px', fontWeight: 600 }}
                      onFocus={() => activateGridCell(gridRow, 0)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Delete' && M.k > 2) {
                          event.preventDefault();
                          deleteRow(i);
                          showToast(`已删除${rowSpc ? '子组' : '行'} ${s.i}`);
                          requestGridFocus(Math.min(gridRow, M.k - 1), 0);
                          return;
                        }
                        navigateGrid(event, gridRow, 0);
                      }}
                    >
                      <span className="ws-num">{s.i}</span>
                      {M.k > 2 && (
                        <button
                          type="button"
                          tabIndex={-1}
                          className="ws-del"
                          aria-label={`删除${rowSpc ? '子组' : '行'} ${s.i}`}
                          onClick={() => {
                            deleteRow(i);
                            showToast(`已删除${rowSpc ? '子组' : '行'} ${s.i}`);
                            requestGridFocus(Math.min(gridRow, M.k - 1), 0);
                          }}
                          style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', color: '#c22f2f', fontWeight: 700, fontFamily: 'inherit' }}
                        >
                          ×
                        </button>
                      )}
                    </td>
                    {displayOrder.map((ref, displayIndex) => ref.kind === 'numeric' ? (
                      <EditableCell
                        key={'n' + ref.index}
                        value={s.vals[ref.index]}
                        dp={colDp[ref.index]}
                        pending={pendingSet.has(`${i}:${ref.index}`)}
                        label={`${M.colNames[ref.index]}，第 ${s.i} 行`}
                        gridRow={gridRow}
                        gridCol={displayIndex + 1}
                        active={activeGridRow === gridRow && activeGridCol === displayIndex + 1}
                        onActivate={activateGridCell}
                        onNavigate={navigateGrid}
                        onCommit={(nv) => updateCell(i, ref.index, nv)}
                      />
                    ) : (
                      <td
                        key={'t' + ref.index}
                        role="gridcell"
                        tabIndex={activeGridRow === gridRow && activeGridCol === displayIndex + 1 ? 0 : -1}
                        data-grid-row={gridRow}
                        data-grid-col={displayIndex + 1}
                        style={txtCell}
                        onFocus={() => activateGridCell(gridRow, displayIndex + 1)}
                        onKeyDown={(event) => navigateGrid(event, gridRow, displayIndex + 1)}
                      >
                        {textCols[ref.index].values[i] ?? ''}
                      </td>
                    ))}
                    {rowSpc && (
                      <>
                        <td
                          role="gridcell"
                          tabIndex={activeGridRow === gridRow && activeGridCol === displayOrder.length + 1 ? 0 : -1}
                          data-grid-row={gridRow}
                          data-grid-col={displayOrder.length + 1}
                          title={String(rowSpc.subs[i].mean)}
                          style={{ ...numCell, fontWeight: 600, ...(meanOoc ? { background: '#fdecec', color: '#c22f2f' } : { color: '#1f6fb2' }) }}
                          onFocus={() => activateGridCell(gridRow, displayOrder.length + 1)}
                          onKeyDown={(event) => navigateGrid(event, gridRow, displayOrder.length + 1)}
                        >
                          {nf(rowSpc.subs[i].mean, meanDp)}
                        </td>
                        <td
                          role="gridcell"
                          tabIndex={activeGridRow === gridRow && activeGridCol === displayOrder.length + 2 ? 0 : -1}
                          data-grid-row={gridRow}
                          data-grid-col={displayOrder.length + 2}
                          title={String(dispersionValues[i])}
                          style={{ ...numCell, ...(dispersionOoc ? { background: '#fdecec', color: '#c22f2f', fontWeight: 600 } : {}) }}
                          onFocus={() => activateGridCell(gridRow, displayOrder.length + 2)}
                          onKeyDown={(event) => navigateGrid(event, gridRow, displayOrder.length + 2)}
                        >
                          {nf(dispersionValues[i], meanDp)}
                        </td>
                      </>
                    )}
                    {M.isDemo && (
                      <>
                        {[OPS[i % 3], '2026-06-' + String((i % 28) + 1).padStart(2, '0'), SHIFTS[i % 3]].map((value, extraIndex) => {
                          const gridCol = displayOrder.length + (rowSpc ? 2 : 0) + extraIndex + 1;
                          return (
                            <td
                              key={gridCol}
                              role="gridcell"
                              tabIndex={activeGridRow === gridRow && activeGridCol === gridCol ? 0 : -1}
                              data-grid-row={gridRow}
                              data-grid-col={gridCol}
                              style={txtCell}
                              onFocus={() => activateGridCell(gridRow, gridCol)}
                              onKeyDown={(event) => navigateGrid(event, gridRow, gridCol)}
                            >
                              {value}
                            </td>
                          );
                        })}
                      </>
                    )}
                  </tr>
                );
              })}
              {virtual && winEnd < M.k && (
                <tr role="presentation" aria-hidden="true" className="worksheet-virtual-spacer" style={{ height: (M.k - winEnd) * ROW_H }}>
                  <td colSpan={cols.length + 1} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
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
              onClick={() => {
                if (addSubgroupRow()) {
                  showToast(`已添加${rowSpc ? '子组' : '行'}（复制末行,双击单元格修改）`);
                }
              }}
              style={{ flex: 1, border: 0, padding: '7px 0', textAlign: 'center', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              ＋ {rowSpc ? '子组' : '行'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (insertColumn()) showToast('已插入数值列（双击列名可重命名）');
              }}
              title="在末尾插入一个数值列；SPC 会按数据角色校验真正子组大小"
              style={{ flex: 1, padding: '7px 0', textAlign: 'center', border: '1px solid #cfd5dd', color: '#3a4350', background: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
            >
              ＋ 数值列
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 8, lineHeight: 1.5 }}>
            双击或聚焦后按 Enter/F2 编辑单元格/列名，Enter 完成、Escape 取消；聚焦或悬停行号/列名可删除。{M.isDemo ? '编辑演示集将另存为「质检数据 (副本)」。' : '修改即时保存。'}
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
                { k: '样本量 N', v: String(prepared.model?.all.length ?? 0) },
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
