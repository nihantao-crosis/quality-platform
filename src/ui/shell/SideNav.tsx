/** 左侧导航 — 分组导航 + 徽标 + 项目管理器（可命名项目 + 最近数据集 + 已保存分析）。 */
import { useState } from 'react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { PAGES } from '../pagesMeta';
import { Icon } from '../icons';

const GROUPS = ['仪表盘', '数据', '分析模块'] as const;

export function SideNav() {
  const { page, goTo, showToast, projectName, setProjectName } = useApp();
  const { model, recents, loadRecent, removeRecent } = useData();
  const saved = useAnalyses((s) => s.saved);
  const restore = useAnalyses((s) => s.restore);
  const removeAnalysis = useAnalyses((s) => s.remove);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const startEditingName = () => { setNameDraft(projectName); setEditingName(true); };

  return (
    <aside style={{ width: 242, flex: 'none', background: '#fbfcfd', borderRight: '1px solid #dadee4', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {GROUPS.map((g, gi) => (
        <div key={g}>
          <div style={{ padding: gi === 0 ? '14px 16px 8px' : '10px 16px 5px', fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600 }}>{g}</div>
          {PAGES.filter((p) => p.group === g).map((p) => {
            const active = page === p.key;
            return (
              <button
                type="button"
                key={p.key}
                className={active ? 'hov-nav-active' : 'hov-nav'}
                aria-current={active ? 'page' : undefined}
                onClick={() => goTo(p.key)}
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
                <span style={{ flex: 1 }}>{p.label}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div style={{ marginTop: 'auto', borderTop: '1px solid #e6e9ee', padding: '12px 16px' }}>
        <div style={{ fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600, marginBottom: 8 }}>项目管理器</div>
        <div style={{ fontSize: 12, color: '#5b6472', lineHeight: 1.9 }}>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { setProjectName(nameDraft); setEditingName(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setProjectName(nameDraft); setEditingName(false); } if (e.key === 'Escape') setEditingName(false); }}
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
                        showToast('已加载数据集 ' + r.name);
                      } else {
                        showToast('数据集加载失败或已被更新的加载请求取代：' + r.name);
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
                title={`${a.title} · ${a.metric} · ${a.datasetName}\n${a.kind === 'aql' ? `保存于 ${new Date(a.createdAt).toLocaleString('zh-CN')}；点击返回当前 AQL，不回滚连续检验流` : '点击恢复此分析的数据集与参数'}`}
                onClick={() => restore(a.id)}
                style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', textAlign: 'left' }}
              >
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: a.statusColor, flex: 'none', marginRight: 6 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</span>
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
                onClick={() => { removeAnalysis(a.id); showToast('已删除分析记录 ' + a.title); }}
                style={{ display: focusedRow === `analysis:${a.id}` ? 'inline' : undefined, border: 0, background: 'transparent', color: '#c22f2f', fontWeight: 700, padding: '0 6px', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
