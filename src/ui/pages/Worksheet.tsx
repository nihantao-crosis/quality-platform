/** 数据工作表 — Excel 式表格（双层 sticky 表头）+ 手工录入编辑 + 数据来源 + 列统计。
 * Minitab 式布局:左侧 sticky 行号槽(含删行按钮)+ 业务数据列,无重复的 ID/行 数据列(716-R3 P1-1);
 * 导入数据显示动态测量列,行式子组口径追加 均值/极差或标准差。
 * 测量单元格可双击或按 Enter/F2 编辑（编辑演示集自动转「副本」），支持添加子组与删行。 */
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import { PROJECT_BACKUP_HINT, datasetWriteNotes, useData } from '../../store/dataStore';
import {
  nf, parseMatrix, arrMin, arrMax, prepareSpcData, columnDisplayDp, worksheetDisplayOrder, withSigmaMethod,
  evaluateSpcChartRules, resolveSpcStage, spcViewFamilyFor,
} from '../../core';
import { errText } from '../../platform/adapter';
import { assertClipboardImportText } from '../../platform/importLimits';
import { Card, KvRows } from '../common';
import { Icon, type IconName } from '../icons';
import { isImeComposing } from '../imeGuard';
import { numericInputMode, parseStrictNumber } from '../../core/numberInput';

const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

/** 行虚拟化:超过该行数只渲染可视窗口(±OVERSCAN 行),其余用等高占位撑开滚动条 */
const VIRTUAL_AT = 400;
const ROW_H = 30;
const OVERSCAN = 12;
/**
 * UI-05 列虚拟化:导入闸门放行到 5000 列 / 200 万格,只按行开窗时 400×5000 会一次创建
 * 200 万个 EditableCell。渲染列数超过 COL_VIRTUAL_AT 时改为定宽列(table-layout: fixed),
 * 只渲染水平可视窗口 ±COL_OVERSCAN 列,两侧用等宽占位格撑开横向滚动条。
 * 行虚拟化同时按「行数 × 渲染列数」判定:宽表即使 ≤400 行也不一次渲染全部行。
 */
const COL_VIRTUAL_AT = 40;
const COL_W = 120;
const COL_OVERSCAN = 4;
const ROWNUM_W = 44;
const VIRTUAL_CELLS = 12_000;

/** 横向窗口 [start, end)(显示列序,不含行号槽)。 */
function worksheetColumnWindow(columnCount: number, scrollLeft: number, viewWidth: number): { start: number; end: number } {
  if (columnCount <= COL_VIRTUAL_AT) return { start: 0, end: columnCount };
  const span = Math.ceil(Math.max(viewWidth, COL_W) / COL_W) + 1;
  // 数据集换成更窄的宽表时,残留的 scrollLeft 可能越过末列:钳到最后一屏,绝不渲染空窗口
  const first = Math.min(Math.floor(Math.max(0, scrollLeft) / COL_W), Math.max(0, columnCount - span));
  const last = first + span;
  return {
    start: Math.max(0, Math.min(columnCount, first - COL_OVERSCAN)),
    end: Math.max(0, Math.min(columnCount, last + COL_OVERSCAN)),
  };
}

const numCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'right', color: '#2a333f' };
const txtCell: CSSProperties = { border: '1px solid #eef0f3', padding: '5px 12px', textAlign: 'left', color: '#5b6472' };
const thTop: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, background: '#eceff3', border: '1px solid #d7dbe1', color: '#7a828d', fontWeight: 600, padding: '5px 12px', textAlign: 'left', minWidth: 78 };
const thName: CSSProperties = { position: 'sticky', top: 26, zIndex: 2, background: '#f4f6f8', border: '1px solid #e2e5ea', color: '#2a333f', fontWeight: 600, padding: '5px 12px', textAlign: 'left', fontFamily: 'IBM Plex Sans' };

/** 双击或从键盘进入编辑态的测量单元格。dp=按数据量级自适应的小数位;悬停显示全精度原值。 */
function EditableCell({ value, dp, pending = false, label, gridRow, gridCol, ariaColIndex, active, onActivate, onNavigate, onCommit }: {
  value: number;
  dp: number;
  pending?: boolean;
  label: string;
  gridRow: number;
  gridCol: number;
  /** 列虚拟化时的真实 aria-colindex(UI-05);全列渲染时省略 */
  ariaColIndex?: number;
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
  const finishEditing = (save: boolean, refocus: boolean) => {
    if (save) {
      // GAP-8-4 同族:严格解析,不再用 parseFloat 前缀截断(「12.5mm」→12.5)。拒绝时明确提示,
      // 不静默丢弃。编辑器是 type=text:type=number 在 Chromium(WebView2/PWA)里插入时就把非法
      // 字符滤掉(「3,5」→35、「12.5mm」→12.5)且 badInput=false,解析拿到的已是被改写的串。
      const parsed = parseStrictNumber(draft);
      if (parsed.ok) {
        // 千分位读法先告知;写入时若有存储告警等 toast,由其后发覆盖,不被说明挤掉。
        if (parsed.note) useApp.getState().showToast(`${label}：${parsed.note}`);
        onCommit(parsed.value);
      } else if (!parsed.empty) {
        useApp.getState().showToast(`未修改${label}：${parsed.reason}`);
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
        aria-colindex={ariaColIndex}
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
  // 编辑中逐字校验原始 draft:非法即标红并在 title 给出原因,提交时 toast 同一原因。
  const draftCheck = parseStrictNumber(draft);
  return (
    <td
      ref={cellRef}
      role="gridcell"
      data-grid-row={gridRow}
      data-grid-col={gridCol}
      aria-colindex={ariaColIndex}
      aria-label={`${label}，编辑中`}
      style={{ ...numCell, padding: 0 }}
    >
      <input
        autoFocus
        aria-label={`编辑${label}`}
        type="text"
        // iOS 的 decimal 键盘没有负号(且小数键可能随地区显示为「,」),iOS 上改全键盘
        inputMode={numericInputMode()}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        aria-invalid={draftCheck.ok || draftCheck.empty ? undefined : true}
        title={draftCheck.ok || draftCheck.empty ? undefined : draftCheck.reason}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finishEditing(true, false)}
        onKeyDown={(e) => {
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
        className="mono"
        style={{ width: 78, border: `2px solid ${draftCheck.ok || draftCheck.empty ? '#1f6fb2' : '#c22f2f'}`, borderRadius: 2, padding: '3px 8px', fontSize: 12.5, textAlign: 'right', outline: 'none', boxSizing: 'border-box' }}
      />
    </td>
  );
}

/** 双击或按 Enter/F2 重命名测量列；hover/focus 显示删除按钮。 */
function HeaderCell({ name, canDelete, gridCol, ariaColIndex, fixedWidth = false, active, onActivate, onRequestFocus, onNavigate, onRename, onDelete }: {
  name: string;
  canDelete: boolean;
  gridCol: number;
  /** 列虚拟化时的真实 aria-colindex(UI-05);全列渲染时省略 */
  ariaColIndex?: number;
  /** 列虚拟化定宽列(UI-05 复审 P3):长列名以省略号截断,全名由 title 给出 */
  fixedWidth?: boolean;
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
        aria-colindex={ariaColIndex}
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
      aria-colindex={ariaColIndex}
      aria-keyshortcuts={canDelete ? 'Enter F2 Delete' : 'Enter F2'}
      aria-label={`列 ${name}；按 Enter 或 F2 重命名${canDelete ? '，按 Delete 删除列' : ''}`}
      className="col-head"
      style={{ ...thName, cursor: 'cell', ...(canDelete ? { padding: '5px 28px 5px 12px' } : {}) }}
      title={`${name} · 双击或按 Enter/F2 重命名此列`}
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
      <span style={{ display: fixedWidth ? 'flex' : 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={fixedWidth ? { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } : undefined}>{name}</span>
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
    spcDataLayout, spcValueCol, spcSubgroupCol, spcSigmaMethod, spcStageCol,
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
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(1200);
  // 渲染列 = 数值列 + 文本列 + 派生列(均值/离散 2 列 + 演示附加 3 列),与下方 cols.length 同口径。
  // 宽表(已开列窗口)才按「行数 × 窗口列数」提前启用行窗口(UI-05);≤40 列的窄表仍只按
  // 行数 >400 判定,DOM 与旧版一致(复审 P3:400×31、301×40 不再被开行窗口)。
  const renderColumnCount = M.colNames.length + textCols.length + (rowSpc ? 2 : 0) + (M.isDemo ? 3 : 0);
  const virtual = M.k > VIRTUAL_AT
    || (renderColumnCount > COL_VIRTUAL_AT && M.k * COL_VIRTUAL_AT > VIRTUAL_CELLS);
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

  // 均值/离散失控行高亮(CORE-09 残余 / UI-12 / CORE-08):与 SPC 页、质量总览同源——
  // 图型 spcViewFamilyFor、阶段 resolveSpcStage、判异唯一原语 evaluateSpcChartRules(含 σ̂ 守卫)。
  // 不再按全局控制限自行 evalRules:分阶段时 SPC 页段内 0 失控,工作表也必须 0 红格。
  // I-MR 视图按单个观测判异,无法落到子组均值/离散列;分阶段未运行、σ̂ 不可判定时同样不高亮并说明原因。
  const rowSpcFamily = rowSpc ? spcViewFamilyFor(rowSpc, spcType) : null;
  const rowSpcUsesS = rowSpcFamily === 'xbar-s';
  const { meanViol, dispersionViol, dispersionValues, rowSpcHint } = useMemo(() => {
    const none = new Set<number>();
    if (!rowSpc || !rowSpcFamily) {
      return { meanViol: none, dispersionViol: none, dispersionValues: [] as number[], rowSpcHint: null as string | null };
    }
    const dispersionValues = rowSpcUsesS ? rowSpc.svals : rowSpc.subs.map((sub) => sub.range);
    const unhighlighted = (rowSpcHint: string) => ({ meanViol: none, dispersionViol: none, dispersionValues, rowSpcHint });
    if (rowSpcFamily === 'i-mr') {
      return unhighlighted('当前 SPC 视图为 I-MR（按单个观测判异），子组均值/极差列不做失控高亮；失控观测请在控制图页查看。');
    }
    const stage = resolveSpcStage({
      stageColumn: spcStageCol, textCols: prepared.textCols, spcType, hasSubgroups: rowSpc.hasSubgroups, pointCount: rowSpc.k,
    });
    if (stage.state === 'invalid') {
      return unhighlighted(`SPC 分阶段未运行：${stage.reason}；与控制图页一致不出结论，均值/极差列不做失控高亮。`);
    }
    const evaluation = evaluateSpcChartRules(rowSpc, spcRules, spcRuleK, rowSpcFamily, false, stage);
    if (evaluation.unavailableReason) {
      return unhighlighted(`SPC 不可判定：${evaluation.unavailableReason}；均值/${rowSpcUsesS ? '标准差' : '极差'}列不做失控高亮。`);
    }
    return {
      meanViol: evaluation.location.viol,
      dispersionViol: evaluation.dispersion.viol,
      dispersionValues,
      rowSpcHint: stage.state === 'active'
        ? `均值/极差高亮按「${stage.column}」分阶段段内控制限判异（与控制图页一致）。`
        : null,
    };
  }, [rowSpc, rowSpcFamily, rowSpcUsesS, prepared, spcType, spcStageCol, spcRules, spcRuleK]);

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

  // 列窗口(UI-05):显示列序 [colStart, colEnd);非宽表时即全部列,渲染与旧版一致。
  const colVirtual = cols.length > COL_VIRTUAL_AT;
  const { start: colStart, end: colEnd } = worksheetColumnWindow(cols.length, scrollLeft, viewW);
  const visibleColIndices = Array.from({ length: colEnd - colStart }, (_, offset) => colStart + offset);
  const leftSpacerW = colStart * COL_W;
  const rightSpacerW = (cols.length - colEnd) * COL_W;
  const renderedCellCount = 1 + (leftSpacerW > 0 ? 1 : 0) + visibleColIndices.length + (rightSpacerW > 0 ? 1 : 0);
  /** 列窗口下每个渲染格都带真实 aria-colindex(行号槽为 1),辅助技术按全表列号播报。 */
  const ariaColIndex = (gridCol: number) => (colVirtual ? gridCol + 1 : undefined);
  const fixedColStyle: CSSProperties | undefined = colVirtual
    ? { width: COL_W, minWidth: COL_W, maxWidth: COL_W, boxSizing: 'border-box' }
    : undefined;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewW(el.clientWidth || 1200);
  }, [colVirtual]);

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
    if (colVirtual && nextCol > 0 && scrollRef.current) {
      // 列窗口:目标列在窗口外时先横向滚到可视区(左侧 sticky 行号槽遮住 ROWNUM_W)
      const cellLeft = (nextCol - 1) * COL_W;
      const viewportLeft = scrollRef.current.scrollLeft;
      const viewportWidth = (scrollRef.current.clientWidth || viewW) - ROWNUM_W;
      let nextScrollLeft = viewportLeft;
      if (cellLeft < viewportLeft) nextScrollLeft = cellLeft;
      else if (cellLeft + COL_W > viewportLeft + viewportWidth) nextScrollLeft = Math.max(0, cellLeft + COL_W - viewportWidth);
      if (nextScrollLeft !== viewportLeft) {
        scrollRef.current.scrollLeft = nextScrollLeft;
        setScrollLeft(nextScrollLeft);
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
  const logicalActiveGridCol = Math.min(activeGridCell.col, cols.length);
  // 列窗口同理:横向滚走的停靠列钳到窗口边界,保证 grid 始终有一个 Tab 停靠点。
  const activeGridCol = colVirtual && logicalActiveGridCol > 0
    ? Math.max(colStart + 1, Math.min(colEnd, logicalActiveGridCol))
    : logicalActiveGridCol;

  // UI-05 复审 P2:焦点只响应「新的」键盘焦点请求。行/列窗口变化(鼠标、触控板滚动)引起的
  // 重跑不得再调用带滚动的 focus()——否则会抢走 grid 外输入框的焦点,并把横向/纵向滚动拉回。
  // 唯一例外:grid 内原焦点格随滚动被卸载、焦点落回 body 时,无滚动地移到钳制后的停靠格,
  // 键盘用户不致失去位置。
  const handledGridFocusRequest = useRef(0);
  const lastGridFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-grid-row="${activeGridRow}"][data-grid-col="${activeGridCol}"]`,
    );
    if (gridFocusRequest !== handledGridFocusRequest.current) {
      handledGridFocusRequest.current = gridFocusRequest;
      target?.focus();
      return;
    }
    const lost = lastGridFocus.current;
    const active = document.activeElement;
    if (target && lost && !lost.isConnected && (active == null || active === document.body)) {
      target.focus({ preventScroll: true });
    }
  }, [activeGridRow, activeGridCol, gridFocusRequest, winStart, winEnd, colStart, colEnd]);

  const sources: Array<{ icon: IconName; iconColor: string; label: string; status: string; statusColor: string; onClick: () => void }> = [
    { icon: 'grid', iconColor: '#2c8a45', label: 'Excel / CSV 导入', status: '已连接', statusColor: '#2c8a45', onClick: () => { setImportTab('csv'); openModal('import'); } },
    { icon: 'table', iconColor: '#2c8a45', label: '手工录入', status: '启用', statusColor: '#2c8a45', onClick: () => showToast('双击测量单元格，或聚焦后按 Enter/F2 编辑 · 右侧可添加子组') },
    { icon: 'gauge', iconColor: '#1f6fb2', label: 'MES 自动采集', status: '实时', statusColor: '#1f6fb2', onClick: () => { setImportTab('mes'); openModal('import'); } },
    { icon: 'check', iconColor: '#8a929d', label: '扫码录入', status: '待配置', statusColor: '#8a929d', onClick: () => showToast('扫码录入待配置') },
  ];

  return (
    <div ref={worksheetRef} className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 268px', gap: 16 }}>
      <div style={{ background: '#fff', border: '1px solid #d7dbe1', borderRadius: 5, overflow: 'hidden', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
        {rowSpcHint && (
          <div role="status" style={{ padding: '6px 12px', borderBottom: '1px solid #eceff3', background: '#fbfaf5', color: '#8a5a00', fontSize: 11.5, lineHeight: 1.5 }}>
            {rowSpcHint}
          </div>
        )}
        <div
          ref={scrollRef}
          onFocus={(event) => { lastGridFocus.current = event.target instanceof HTMLElement ? event.target : null; }}
          onBlur={(event) => {
            // 焦点移到 grid 外的真实元素 = 用户主动离开;relatedTarget 为空(格被卸载/点空白)保留记录
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) lastGridFocus.current = null;
          }}
          onScroll={virtual || colVirtual
            ? (e) => {
                const target = e.target as HTMLDivElement;
                if (virtual) setScrollTop(target.scrollTop);
                if (colVirtual) setScrollLeft(target.scrollLeft);
              }
            : undefined}
          style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}
        >
          <table
            className={colVirtual ? 'mono ws-colvirtual' : 'mono'}
            role="grid"
            aria-label="数据工作表"
            aria-rowcount={M.k + 1}
            aria-colcount={cols.length + 1}
            style={{
              borderCollapse: 'collapse', fontSize: 12.5, whiteSpace: 'nowrap', minWidth: '100%',
              // 列窗口:定宽布局,表宽即全部列宽,滚动条与未渲染列一致
              ...(colVirtual ? { tableLayout: 'fixed', width: ROWNUM_W + cols.length * COL_W } : {}),
            }}
          >
            <thead>
              {/* C#/S# 代号仅为视觉辅助；可访问列标题由下方唯一表头行承担。 */}
              <tr role="presentation" aria-hidden="true">
                <th style={{ ...thTop, left: 0, zIndex: 3, width: ROWNUM_W, minWidth: ROWNUM_W }} />
                {leftSpacerW > 0 && <th className="worksheet-col-spacer" style={{ ...thTop, width: leftSpacerW, minWidth: leftSpacerW, padding: 0 }} />}
                {visibleColIndices.map((displayIndex) => {
                  const c = cols[displayIndex];
                  return <th key={c.code} style={{ ...thTop, ...fixedColStyle }}>{c.code}</th>;
                })}
                {rightSpacerW > 0 && <th className="worksheet-col-spacer" style={{ ...thTop, width: rightSpacerW, minWidth: rightSpacerW, padding: 0 }} />}
              </tr>
              <tr role="row" aria-rowindex={1}>
                {/* 行号槽表头:Minitab 行号槽无标题;行式子组口径保留「子组」语义(716-R3 P1-1) */}
                <th
                  role="columnheader"
                  scope="col"
                  tabIndex={activeGridRow === 0 && activeGridCol === 0 ? 0 : -1}
                  data-grid-row={0}
                  data-grid-col={0}
                  aria-colindex={ariaColIndex(0)}
                  aria-label={rowSpc ? '子组行号列' : '行号列'}
                  style={{ ...thName, left: 0, zIndex: 3, border: '1px solid #d7dbe1', textAlign: 'center' }}
                  onFocus={() => activateGridCell(0, 0)}
                  onKeyDown={(event) => navigateGrid(event, 0, 0)}
                >
                  {rowSpc ? '子组' : ''}
                </th>
                {leftSpacerW > 0 && <th role="presentation" aria-hidden="true" className="worksheet-col-spacer" style={{ ...thName, padding: 0 }} />}
                {visibleColIndices.map((displayIndex) => {
                  const c = cols[displayIndex];
                  const gridCol = displayIndex + 1;
                  // measIdx 非空 = 数值测量列(可重命名/删除);列已按导入原序交错,不能再用位置推断
                  return c.measIdx != null ? (
                    <HeaderCell
                      key={c.code}
                      name={c.name}
                      canDelete={M.n > 1}
                      gridCol={gridCol}
                      ariaColIndex={ariaColIndex(gridCol)}
                      fixedWidth={colVirtual}
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
                      aria-colindex={ariaColIndex(gridCol)}
                      title={c.name}
                      style={thName}
                      onFocus={() => activateGridCell(0, gridCol)}
                      onKeyDown={(event) => navigateGrid(event, 0, gridCol)}
                    >
                      {c.name}
                    </th>
                  );
                })}
                {rightSpacerW > 0 && <th role="presentation" aria-hidden="true" className="worksheet-col-spacer" style={{ ...thName, padding: 0 }} />}
              </tr>
            </thead>
            <tbody>
              {virtual && winStart > 0 && (
                <tr role="presentation" aria-hidden="true" className="worksheet-virtual-spacer" style={{ height: winStart * ROW_H }}>
                  <td colSpan={renderedCellCount} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
              {visibleSubs.map((s, vi) => {
                const i = winStart + vi;
                const gridRow = i + 1;
                const meanOoc = meanViol.has(i);
                const dispersionOoc = dispersionViol.has(i);
                const demoValues = M.isDemo
                  ? [OPS[i % 3], '2026-06-' + String((i % 28) + 1).padStart(2, '0'), SHIFTS[i % 3]]
                  : null;
                // 按显示列序渲染一个数据格:测量/文本列 → 均值/离散派生列 → 演示附加列(与列头同序)
                const renderCell = (displayIndex: number) => {
                  const gridCol = displayIndex + 1;
                  if (displayIndex < displayOrder.length) {
                    const ref = displayOrder[displayIndex];
                    return ref.kind === 'numeric' ? (
                      <EditableCell
                        key={'n' + ref.index}
                        value={s.vals[ref.index]}
                        dp={colDp[ref.index]}
                        pending={pendingSet.has(`${i}:${ref.index}`)}
                        label={`${M.colNames[ref.index]}，第 ${s.i} 行`}
                        gridRow={gridRow}
                        gridCol={gridCol}
                        ariaColIndex={ariaColIndex(gridCol)}
                        active={activeGridRow === gridRow && activeGridCol === gridCol}
                        onActivate={activateGridCell}
                        onNavigate={navigateGrid}
                        onCommit={(nv) => updateCell(i, ref.index, nv)}
                      />
                    ) : (
                      <td
                        key={'t' + ref.index}
                        role="gridcell"
                        tabIndex={activeGridRow === gridRow && activeGridCol === gridCol ? 0 : -1}
                        data-grid-row={gridRow}
                        data-grid-col={gridCol}
                        aria-colindex={ariaColIndex(gridCol)}
                        title={textCols[ref.index].values[i] || undefined}
                        style={txtCell}
                        onFocus={() => activateGridCell(gridRow, gridCol)}
                        onKeyDown={(event) => navigateGrid(event, gridRow, gridCol)}
                      >
                        {textCols[ref.index].values[i] ?? ''}
                      </td>
                    );
                  }
                  const derivedIndex = displayIndex - displayOrder.length;
                  if (rowSpc && derivedIndex < 2) {
                    const isMean = derivedIndex === 0;
                    const ooc = isMean ? meanOoc : dispersionOoc;
                    const rawValue = isMean ? rowSpc.subs[i].mean : dispersionValues[i];
                    return (
                      <td
                        key={isMean ? 'mean' : 'dispersion'}
                        role="gridcell"
                        tabIndex={activeGridRow === gridRow && activeGridCol === gridCol ? 0 : -1}
                        data-grid-row={gridRow}
                        data-grid-col={gridCol}
                        aria-colindex={ariaColIndex(gridCol)}
                        title={String(rawValue)}
                        style={isMean
                          ? { ...numCell, fontWeight: 600, ...(ooc ? { background: '#fdecec', color: '#c22f2f' } : { color: '#1f6fb2' }) }
                          : { ...numCell, ...(ooc ? { background: '#fdecec', color: '#c22f2f', fontWeight: 600 } : {}) }}
                        onFocus={() => activateGridCell(gridRow, gridCol)}
                        onKeyDown={(event) => navigateGrid(event, gridRow, gridCol)}
                      >
                        {nf(rawValue, meanDp)}
                      </td>
                    );
                  }
                  const demoIndex = derivedIndex - (rowSpc ? 2 : 0);
                  return (
                    <td
                      key={gridCol}
                      role="gridcell"
                      tabIndex={activeGridRow === gridRow && activeGridCol === gridCol ? 0 : -1}
                      data-grid-row={gridRow}
                      data-grid-col={gridCol}
                      aria-colindex={ariaColIndex(gridCol)}
                      title={demoValues?.[demoIndex] || undefined}
                      style={txtCell}
                      onFocus={() => activateGridCell(gridRow, gridCol)}
                      onKeyDown={(event) => navigateGrid(event, gridRow, gridCol)}
                    >
                      {demoValues?.[demoIndex] ?? ''}
                    </td>
                  );
                };
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
                      aria-colindex={ariaColIndex(0)}
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
                    {leftSpacerW > 0 && <td role="presentation" aria-hidden="true" className="worksheet-col-spacer" style={{ padding: 0, border: 0 }} />}
                    {visibleColIndices.map(renderCell)}
                    {rightSpacerW > 0 && <td role="presentation" aria-hidden="true" className="worksheet-col-spacer" style={{ padding: 0, border: 0 }} />}
                  </tr>
                );
              })}
              {virtual && winEnd < M.k && (
                <tr role="presentation" aria-hidden="true" className="worksheet-virtual-spacer" style={{ height: (M.k - winEnd) * ROW_H }}>
                  <td colSpan={renderedCellCount} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(virtual || colVirtual) && (
          <div style={{ padding: '5px 12px', fontSize: 11, color: '#98a1ac', borderTop: '1px solid #eef0f3' }}>
            {virtual ? `大数据集已启用行虚拟化 · 共 ${M.k.toLocaleString()} 行,仅渲染可视窗口(${winStart + 1}–${winEnd})` : ''}
            {virtual && colVirtual ? ' · ' : ''}
            {colVirtual ? `宽表已启用列虚拟化 · 共 ${cols.length.toLocaleString()} 列,仅渲染第 ${colStart + 1}–${colEnd} 列` : ''}
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
