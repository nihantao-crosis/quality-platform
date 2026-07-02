/** 工具栏 — 图标按钮 + 活动变量下拉 + 运行分析。 */
import { useApp } from '../../store/appStore';
import { Icon, type IconName } from '../icons';

const VAR_LIST = ['C1 子组', 'C2 直径 (mm)', 'C7 均值', 'C8 极差'];

export function Toolbar() {
  const { varOpen, setVarOpen, activeVar, setActiveVar, openModal, showToast, setOpenMenu } = useApp();

  const btns: Array<{ label: string; icon: IconName; onClick: () => void }> = [
    { label: '打开', icon: 'table', onClick: () => openModal('import') },
    { label: '导入 CSV/Excel', icon: 'grid', onClick: () => openModal('import') },
    { label: '保存', icon: 'check', onClick: () => showToast('项目已保存至 质检项目 2026-Q2') },
    { label: '图形', icon: 'chart', onClick: () => setOpenMenu('图形') },
    { label: '计算器', icon: 'bars', onClick: () => openModal('calc') },
  ];

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 46, background: '#f9fafb', borderBottom: '1px solid #dadee4', padding: '0 12px', gap: 4, flex: 'none', position: 'relative', zIndex: 50 }}>
      {btns.map((b) => (
        <div key={b.label} className="hov-tool" title={b.label} onClick={b.onClick} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 4, cursor: 'pointer', color: '#3a4350', fontSize: 12.5, whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex' }}><Icon name={b.icon} /></span>
          <span>{b.label}</span>
        </div>
      ))}
      <div style={{ width: 1, height: 24, background: '#dfe3e8', margin: '0 6px' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5b6472' }}>
        <span>活动变量</span>
        <div style={{ position: 'relative' }}>
          <div className="hov-var" onClick={() => setVarOpen(!varOpen)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#fff', border: '1px solid #cfd5dd', borderRadius: 4, minWidth: 150, cursor: 'pointer' }}>
            <span className="mono" style={{ color: '#2a333f' }}>{activeVar}</span>
            <span style={{ marginLeft: 'auto', color: '#9aa2ad' }}>▾</span>
          </div>
          {varOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff', border: '1px solid #d7dbe1', borderRadius: 6, boxShadow: '0 12px 30px rgba(20,30,50,0.16)', padding: 4, zIndex: 200 }}>
              {VAR_LIST.map((v) => (
                <div
                  key={v}
                  className="hov-var-item mono"
                  onClick={() => setActiveVar(v)}
                  style={{ padding: '8px 14px', cursor: 'pointer', fontSize: 12.5, borderRadius: 4, ...(activeVar === v ? { background: '#e7f0f9', color: '#1f6fb2' } : { color: '#3a4350' }) }}
                >
                  {v}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <div className="hov-run" onClick={() => showToast('分析已运行 · 结果已更新')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: '#1f6fb2', color: '#fff', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: 12.5 }}>
          运行分析
        </div>
      </div>
    </div>
  );
}
