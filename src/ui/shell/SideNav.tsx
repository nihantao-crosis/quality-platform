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

  return (
    <aside style={{ width: 242, flex: 'none', background: '#fbfcfd', borderRight: '1px solid #dadee4', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {GROUPS.map((g, gi) => (
        <div key={g}>
          <div style={{ padding: gi === 0 ? '14px 16px 8px' : '10px 16px 5px', fontSize: 11, letterSpacing: '0.06em', color: '#98a1ac', fontWeight: 600 }}>{g}</div>
          {PAGES.filter((p) => p.group === g).map((p) => {
            const active = page === p.key;
            return (
              <div
                key={p.key}
                className={active ? 'hov-nav-active' : 'hov-nav'}
                onClick={() => goTo(p.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, margin: '1px 8px', padding: '8px 10px',
                  borderRadius: 5, cursor: 'pointer', fontSize: 13,
                  ...(active
                    ? { background: '#e7f0f9', color: '#1f6fb2', fontWeight: 600, borderLeft: '3px solid #1f6fb2' }
                    : { color: '#4a5462', borderLeft: '3px solid transparent' }),
                }}
              >
                <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center', opacity: 0.9 }}>
                  <Icon name={p.icon} color={active ? '#1f6fb2' : '#7a828d'} />
                </span>
                <span style={{ flex: 1 }}>{p.label}</span>
                {p.key === 'spc' && (
                  <span className="mono" style={{ background: '#e23b3b', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9 }}>2</span>
                )}
              </div>
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
            <div title="双击重命名项目" style={{ cursor: 'cell' }} onDoubleClick={() => { setNameDraft(projectName); setEditingName(true); }}>
              📁 {projectName}
            </div>
          )}
          <div style={{ paddingLeft: 16, color: '#1f6fb2', fontWeight: 500 }}>工作表 · {model.name}</div>
          {recents.length > 0 && (
            <>
              <div style={{ paddingLeft: 16, color: '#98a1ac', fontSize: 11, marginTop: 4 }}>最近数据集</div>
              {recents.map((r) => (
                <div
                  key={r.name}
                  className="hov-nav"
                  title={'导入于 ' + new Date(r.savedAt).toLocaleString('zh-CN')}
                  onClick={() => {
                    loadRecent(r.name);
                    goTo('worksheet');
                    showToast('已加载数据集 ' + r.name);
                  }}
                  style={{ paddingLeft: 16, color: r.name === model.name ? '#1f6fb2' : '#7a828d', cursor: 'pointer', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>↻ {r.name}</span>
                  <span
                    className="rc-del"
                    title="从最近列表移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecent(r.name);
                      showToast('已从最近列表移除 ' + r.name);
                    }}
                    style={{ color: '#c22f2f', fontWeight: 700, padding: '0 6px' }}
                  >
                    ×
                  </span>
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
              title={`${a.title} · ${a.metric} · ${a.datasetName}\n点击回看此分析`}
              onClick={() => restore(a.id)}
              style={{ paddingLeft: 16, color: '#7a828d', cursor: 'pointer', borderRadius: 4, overflow: 'hidden', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: a.statusColor, flex: 'none', marginRight: 6 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</span>
              <span
                className="rc-del"
                title="删除此分析记录"
                onClick={(e) => { e.stopPropagation(); removeAnalysis(a.id); showToast('已删除分析记录 ' + a.title); }}
                style={{ color: '#c22f2f', fontWeight: 700, padding: '0 6px' }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
