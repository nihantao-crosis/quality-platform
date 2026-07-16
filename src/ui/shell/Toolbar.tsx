/** 工具栏 — 图标按钮 + 当前工作表变量选择。 */
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { resolveNumericColumn } from '../../core';
import { Icon, type IconName } from '../icons';
import { sessionLog } from '../../store/sessionLog';

export function Toolbar() {
  const { varOpen, setVarOpen, activeVar, setActiveVar, openModal, showToast, setOpenMenu, goTo } = useApp();
  const model = useData((state) => state.model);
  const selected = resolveNumericColumn(model, activeVar);

  const btns: Array<{ label: string; icon: IconName; onClick: () => void }> = [
    { label: '打开', icon: 'table', onClick: () => openModal('import') },
    { label: '导入 CSV/Excel', icon: 'grid', onClick: () => openModal('import') },
    { label: '保存', icon: 'check', onClick: () => {
      import('../../platform/project')
        .then((m) => m.exportProject(__APP_VERSION__, useApp.getState().projectName))
        .then((dest) => { if (dest) showToast('项目已保存: ' + dest); })
        .catch((error) => showToast(`项目保存失败：${(error as Error).message}`));
    } },
    { label: '图形', icon: 'chart', onClick: () => setOpenMenu('图形') },
    { label: '计算器', icon: 'bars', onClick: () => openModal('calc') },
  ];

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 46, background: '#f9fafb', borderBottom: '1px solid #dadee4', padding: '0 12px', gap: 4, flex: 'none', position: 'relative', zIndex: 50 }}>
      {btns.map((b) => (
        <button type="button" key={b.label} className="hov-tool" title={b.label} aria-label={b.label} onClick={b.onClick} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', border: 0, borderRadius: 4, cursor: 'pointer', color: '#3a4350', background: 'transparent', fontFamily: 'inherit', fontSize: 12.5, whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex' }}><Icon name={b.icon} /></span>
          <span>{b.label}</span>
        </button>
      ))}
      <div style={{ width: 1, height: 24, background: '#dfe3e8', margin: '0 6px' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5b6472' }}>
        <span>活动变量</span>
        <div style={{ position: 'relative' }}>
          <button type="button" className="hov-var" aria-haspopup="listbox" aria-expanded={varOpen} aria-label={`活动变量：${selected.name}`} onClick={() => setVarOpen(!varOpen)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#fff', border: '1px solid #cfd5dd', borderRadius: 4, minWidth: 150, cursor: 'pointer', fontFamily: 'inherit' }}>
            <span className="mono" style={{ color: '#2a333f' }}>{selected.name}</span>
            <span style={{ marginLeft: 'auto', color: '#9aa2ad' }}>▾</span>
          </button>
          {varOpen && (
            <div role="listbox" aria-label="选择活动变量" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff', border: '1px solid #d7dbe1', borderRadius: 6, boxShadow: '0 12px 30px rgba(20,30,50,0.16)', padding: 4, zIndex: 200 }}>
              {model.colNames.map((name, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected.index === index}
                  key={`${name}-${index}`}
                  className="hov-var-item mono"
                  onClick={() => setActiveVar(name)}
                  style={{ display: 'block', width: '100%', padding: '8px 14px', border: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'IBM Plex Mono,monospace', fontSize: 12.5, borderRadius: 4, ...(selected.index === index ? { background: '#e7f0f9', color: '#1f6fb2' } : { background: '#fff', color: '#3a4350' }) }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" className="hov-run" onClick={() => {
          setActiveVar(selected.name);
          goTo('summary');
          sessionLog(`打开描述性统计 · ${selected.name}`);
          showToast(`已按「${selected.name}」打开描述性统计`);
        }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: '#1f6fb2', color: '#fff', border: '1px solid #1f6fb2', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 12.5 }}>
          分析此变量
        </button>
      </div>
    </div>
  );
}
