/** 工具栏 — 图标按钮 + 当前工作表变量选择。 */
import { useMemo, useState } from 'react';
import { useApp } from '../../store/appStore';
import { errText } from '../../platform/adapter';
import { appVersionText } from '../../platform/reportLabels';
import { useData } from '../../store/dataStore';
import { resolveNumericColumn } from '../../core';
import { Icon, type IconName } from '../icons';
import { sessionLog } from '../../store/sessionLog';

export function Toolbar() {
  const { varOpen, setVarOpen, activeVar, setActiveVar, openModal, showToast, setOpenMenu, goTo } = useApp();
  const model = useData((state) => state.model);
  const selected = resolveNumericColumn(model, activeVar);
  const [variableQuery, setVariableQuery] = useState('');
  const matchingVariables = useMemo(() => {
    const query = variableQuery.trim().toLocaleLowerCase();
    return model.colNames
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => query === '' || name.toLocaleLowerCase().includes(query));
  }, [model.colNames, variableQuery]);
  const visibleVariables = matchingVariables.slice(0, 100);

  const btns: Array<{ label: string; icon: IconName; onClick: () => void }> = [
    { label: '打开', icon: 'table', onClick: () => openModal('import') },
    { label: '导入 CSV/Excel', icon: 'grid', onClick: () => openModal('import') },
    { label: '保存', icon: 'check', onClick: () => {
      import('../../platform/project')
        .then((m) => m.exportProject(appVersionText(), useApp.getState().projectName))
        .then((dest) => { if (dest) showToast('项目已保存: ' + dest); })
        .catch((error) => showToast(`项目保存失败：${errText(error)}`));
    } },
    { label: '图形', icon: 'chart', onClick: () => setOpenMenu('图形') },
    { label: '计算器', icon: 'bars', onClick: () => openModal('calc') },
  ];

  return (
    <div className="toolbar" style={{ display: 'flex', alignItems: 'center', height: 46, background: '#f9fafb', borderBottom: '1px solid #dadee4', padding: '0 12px', gap: 4, flex: 'none', position: 'relative', zIndex: 50 }}>
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
          <button type="button" className="hov-var" aria-expanded={varOpen} aria-label={`活动变量：${selected.name}`} onClick={() => setVarOpen(!varOpen)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#fff', border: '1px solid #cfd5dd', borderRadius: 4, minWidth: 150, cursor: 'pointer', fontFamily: 'inherit' }}>
            <span className="mono" style={{ color: '#2a333f' }}>{selected.name}</span>
            <span style={{ marginLeft: 'auto', color: '#9aa2ad' }}>▾</span>
          </button>
          {varOpen && (
            <div aria-label="选择活动变量" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, width: 320, maxWidth: 'calc(100vw - 24px)', background: '#fff', border: '1px solid #d7dbe1', borderRadius: 6, boxShadow: '0 12px 30px rgba(20,30,50,0.16)', padding: 6, zIndex: 200 }}>
              <input
                type="search"
                aria-label="搜索活动变量"
                placeholder="输入列名搜索…"
                value={variableQuery}
                onChange={(event) => setVariableQuery(event.target.value)}
                style={{ boxSizing: 'border-box', width: '100%', padding: '7px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontFamily: 'inherit', fontSize: 12.5 }}
              />
              <div aria-label="活动变量列表" style={{ maxHeight: 280, overflowY: 'auto', marginTop: 5 }}>
                {visibleVariables.map(({ name, index }) => (
                  <button
                    type="button"
                    aria-pressed={selected.index === index}
                    key={`${name}-${index}`}
                    className="hov-var-item mono"
                    onClick={() => { setActiveVar(name); setVarOpen(false); }}
                    style={{ display: 'block', width: '100%', padding: '8px 10px', border: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'IBM Plex Mono,monospace', fontSize: 12.5, borderRadius: 4, ...(selected.index === index ? { background: '#e7f0f9', color: '#1f6fb2' } : { background: '#fff', color: '#3a4350' }) }}
                  >
                    {name}
                  </button>
                ))}
                {visibleVariables.length === 0 && <div style={{ padding: '10px', color: '#8a929d', fontSize: 12 }}>没有匹配的变量</div>}
              </div>
              {matchingVariables.length > visibleVariables.length && (
                <div role="status" style={{ padding: '6px 8px 2px', color: '#8a929d', fontSize: 11.5 }}>
                  仅显示前 100 项（共 {matchingVariables.length} 项），请输入列名继续筛选
                </div>
              )}
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
