/** 左侧导航 — 分组导航 + 徽标 + 项目管理器（可命名项目 + 最近数据集 + 已保存分析）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../store/appStore';
import { datasetReplacementBlockReason, useData } from '../../store/dataStore';
import { snapshotMissingAnalysisIds, useAnalyses } from '../../store/analyses';
import { REMOVE_SNAPSHOT_MISSING_LABEL } from '../../platform/project';
import { timestampTextOf } from '../../platform/reportLabels';
import { PAGES } from '../pagesMeta';
import { Icon } from '../icons';
import { isImeComposing } from '../imeGuard';

const GROUPS = ['仪表盘', '数据', '分析模块'] as const;

export function SideNav() {
  const { page, goTo, showToast, projectName, setProjectName } = useApp();
  const { model, recents, loadRecent, removeRecent } = useData();
  const saved = useAnalyses((s) => s.saved);
  const restore = useAnalyses((s) => s.restore);
  const removeAnalysis = useAnalyses((s) => s.remove);
  const removeSnapshotMissing = useAnalyses((s) => s.removeSnapshotMissing);
  // 侧栏只列前 6 条；快照缺失的旧卡可能不可见，需单独给出数量与一键删除入口（fix2609 M4）。
  const missingIds = useMemo(() => snapshotMissingAnalysisIds(saved), [saved]);
  // 二次点击确认：记录首次点击时的条数，条数变化（另一窗口同步/新导入）后须重新确认。
  const [removeMissingArmedFor, setRemoveMissingArmedFor] = useState<number | null>(null);
  const removeMissingArmed = removeMissingArmedFor === missingIds.size;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const wasMobileOpenRef = useRef(false);
  const startEditingName = () => { setNameDraft(projectName); setEditingName(true); };
  const closeMobileNav = () => setMobileOpen(false);

  useEffect(() => {
    if (!mobileOpen) {
      if (wasMobileOpenRef.current) {
        wasMobileOpenRef.current = false;
        mobileToggleRef.current?.focus();
      }
      return undefined;
    }
    wasMobileOpenRef.current = true;
    const nav = navRef.current;
    const focusable = () => nav
      ? Array.from(nav.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true')
      : [];
    (nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? focusable()[0] ?? nav)?.focus();

    const keepFocusInDrawer = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        nav?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !nav?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !nav?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keepFocusInDrawer);
    return () => window.removeEventListener('keydown', keepFocusInDrawer);
  }, [mobileOpen]);

  useEffect(() => useApp.subscribe((state, previous) => {
    if (state.modal && !previous.modal) setMobileOpen(false);
  }), []);

  useEffect(() => {
    const closeWhenDesktop = () => {
      if (window.innerWidth >= 900 || document.documentElement.classList.contains('is-desktop')) {
        setMobileOpen(false);
      }
    };
    window.addEventListener('resize', closeWhenDesktop);
    return () => window.removeEventListener('resize', closeWhenDesktop);
  }, []);

  return (
    <>
      <button
        ref={mobileToggleRef}
        type="button"
        className="side-nav-mobile-toggle no-print"
        aria-controls="quality-platform-side-nav"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((open) => !open)}
      >
        {mobileOpen ? '关闭导航' : '导航与项目'}
      </button>
      {mobileOpen && <button type="button" className="side-nav-mobile-backdrop no-print" aria-label="关闭导航" onClick={closeMobileNav} />}
      <aside ref={navRef} id="quality-platform-side-nav" tabIndex={-1} className={`side-nav${mobileOpen ? ' mobile-open' : ''}`} style={{ width: 242, flex: 'none', background: '#fbfcfd', borderRight: '1px solid #dadee4', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {GROUPS.map((g, gi) => (
        <div key={g}>
          <div className="side-nav-section-label" style={{ padding: gi === 0 ? '14px 16px 8px' : '10px 16px 5px', fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600 }}>{g}</div>
          {PAGES.filter((p) => p.group === g).map((p) => {
            const active = page === p.key;
            return (
              <button
                type="button"
                key={p.key}
                className={active ? 'hov-nav-active' : 'hov-nav'}
                aria-current={active ? 'page' : undefined}
                onClick={() => { goTo(p.key); closeMobileNav(); }}
                style={{
                  width: 'calc(100% - 16px)', display: 'flex', alignItems: 'center', gap: 10, margin: '1px 8px', padding: '8px 10px',
                  border: 0, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 13,
                  ...(active
                    ? { background: '#e7f0f9', color: '#1f6fb2', fontWeight: 600, borderLeft: '3px solid #1f6fb2' }
                    : { background: 'transparent', color: '#4a5462', borderLeft: '3px solid transparent' }),
                }}
              >
                <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center', opacity: 0.9 }}>
                  <Icon name={p.icon} color={active ? '#1f6fb2' : '#7a828d'} />
                </span>
                <span className="side-nav-label" style={{ flex: 1 }}>{p.label}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div className="side-nav-project" style={{ marginTop: 'auto', borderTop: '1px solid #e6e9ee', padding: '12px 16px' }}>
        <div style={{ fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600, marginBottom: 8 }}>项目管理器</div>
        <div style={{ fontSize: 12, color: '#5b6472', lineHeight: 1.9 }}>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { setProjectName(nameDraft); setEditingName(false); }}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return; // GAP-8-6:组字期间的 Enter/Esc 属于输入法
                if (e.key === 'Enter') { setProjectName(nameDraft); setEditingName(false); }
                if (e.key === 'Escape') setEditingName(false);
              }}
              style={{ width: '100%', border: '2px solid #1f6fb2', borderRadius: 3, padding: '2px 6px', fontSize: 12, boxSizing: 'border-box' }}
            />
          ) : (
            <button
              type="button"
              title="双击重命名项目；键盘按 Enter 或空格也可重命名"
              onDoubleClick={startEditingName}
              onClick={(event) => { if (event.detail === 0) startEditingName(); }}
              style={{ width: '100%', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'cell', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', textAlign: 'left' }}
            >
              📁 {projectName}
            </button>
          )}
          <div style={{ paddingLeft: 16, color: '#1f6fb2', fontWeight: 500 }}>工作表 · {model.name}</div>
          {recents.length > 0 && (
            <>
              <div style={{ paddingLeft: 16, color: '#98a1ac', fontSize: 11, marginTop: 4 }}>最近数据集</div>
              {recents.map((r) => (
                <div
                  key={r.name}
                  className="hov-nav"
                  onFocusCapture={() => setFocusedRow(`recent:${r.name}`)}
                  onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedRow(null);
                  }}
                  style={{ paddingLeft: 16, color: r.name === model.name ? '#1f6fb2' : '#7a828d', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
                >
                  <button
                    type="button"
                    title={'导入于 ' + new Date(r.savedAt).toLocaleString('zh-CN')}
                    onClick={async () => {
                      const loaded = await loadRecent(r.name);
                      if (loaded) {
                        goTo('worksheet');
                        closeMobileNav();
                        showToast('已加载数据集 ' + r.name);
                      } else {
                        // STORE-08:被替换闸门拒绝时保留闸门的可操作提示，不用泛化失败文案覆盖
                        showToast(datasetReplacementBlockReason() ?? ('数据集加载失败或已被更新的加载请求取代：' + r.name));
                      }
                    }}
                    style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', textAlign: 'left' }}
                  >
                    ↻ {r.name}
                  </button>
                  <button
                    type="button"
                    className="rc-del"
                    aria-label={`从最近列表移除：${r.name}`}
                    onClick={() => {
                      removeRecent(r.name);
                      showToast('已从最近列表移除 ' + r.name);
                    }}
                    style={{ display: focusedRow === `recent:${r.name}` ? 'inline' : undefined, border: 0, background: 'transparent', color: '#c22f2f', fontWeight: 700, padding: '0 6px', fontFamily: 'inherit', cursor: 'pointer' }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </>
          )}
          <div style={{ paddingLeft: 16, color: '#98a1ac', fontSize: 11, marginTop: 6 }}>
            分析 · {saved.length} 项已保存
          </div>
          {missingIds.size > 0 && (
            <div role="status" style={{ margin: '2px 0 4px 16px', padding: '4px 8px', background: '#fff6e6', border: '1px solid #f0d69a', borderRadius: 4, fontSize: 11, color: '#8a6414', lineHeight: 1.5, whiteSpace: 'normal' }}>
              {missingIds.size} 条已保存分析的数据快照缺失，无法回看{saved.slice(0, 6).every((a) => !missingIds.has(a.id)) ? '（不在下方前 6 条中）' : ''}。
              <button
                type="button"
                onClick={() => {
                  if (!removeMissingArmed) {
                    setRemoveMissingArmedFor(missingIds.size);
                    return;
                  }
                  setRemoveMissingArmedFor(null);
                  const removed = removeSnapshotMissing();
                  if (removed !== null && removed > 0) showToast(`已删除 ${removed} 条快照缺失的分析记录`);
                }}
                onBlur={() => setRemoveMissingArmedFor(null)}
                style={{ display: 'block', marginTop: 3, border: 0, padding: 0, background: 'transparent', color: '#c22f2f', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, textAlign: 'left' }}
              >
                {removeMissingArmed ? `再次点击确认删除 ${missingIds.size} 条` : REMOVE_SNAPSHOT_MISSING_LABEL}
              </button>
            </div>
          )}
          {saved.slice(0, 6).map((a) => (
            <div
              key={a.id}
              className="hov-nav rc-row"
              onFocusCapture={() => setFocusedRow(`analysis:${a.id}`)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedRow(null);
              }}
              style={{ paddingLeft: 16, color: '#7a828d', borderRadius: 4, overflow: 'hidden', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
            >
              <button
                type="button"
                title={`${a.title} · ${a.metric} · ${a.datasetName}\n保存于 ${timestampTextOf(a.createdAt)}\n${missingIds.has(a.id) ? '数据快照缺失，无法回看；可用上方「' + REMOVE_SNAPSHOT_MISSING_LABEL + '」清理' : a.kind === 'aql' ? '点击返回当前 AQL，不回滚连续检验流' : '点击恢复此分析的数据集与参数'}`}
                onClick={() => { void restore(a.id); closeMobileNav(); }}
                style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', textAlign: 'left' }}
              >
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: a.statusColor, flex: 'none', marginRight: 6 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</span>
                {missingIds.has(a.id) && (
                  <span style={{ flex: 'none', marginLeft: 6, padding: '0 4px', borderRadius: 3, background: '#fdecec', color: '#c22f2f', fontSize: 10 }}>
                    快照缺失
                  </span>
                )}
                {a.kind === 'aql' && (
                  <span className="mono" style={{ flex: 'none', marginLeft: 6, color: '#a0a7b0', fontSize: 10 }}>
                    {new Date(a.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="rc-del"
                aria-label={`删除分析记录：${a.title}`}
                onClick={() => { if (removeAnalysis(a.id)) showToast('已删除分析记录 ' + a.title); }}
                style={{ display: focusedRow === `analysis:${a.id}` ? 'inline' : undefined, border: 0, background: 'transparent', color: '#c22f2f', fontWeight: 700, padding: '0 6px', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      </aside>
    </>
  );
}
