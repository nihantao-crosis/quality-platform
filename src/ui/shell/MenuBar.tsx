/** 菜单栏 — 10 个菜单 + 下拉，行为（导航/弹窗/通知/图表风格）与原型一致。 */
import { useApp, type Page, type Modal, type ChartStyle } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { platform } from '../../platform/adapter';

/** 桌面端经 tauri-plugin-updater 检查 GitHub Releases；Web 端不适用。 */
async function checkForUpdate(toast: (m: string) => void) {
  if (!platform.isDesktop) {
    toast('Web 端始终为最新版本 · 桌面端可在应用内检查更新');
    return;
  }
  toast('正在检查更新…');
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) toast(`发现新版本 ${update.version} · 请从 GitHub Releases 下载安装`);
    else toast('当前已是最新版本');
  } catch {
    toast('检查更新失败（更新服务未发布或网络不可用）');
  }
}

type Act = {
  page?: Page;
  modal?: Exclude<Modal, null>;
  toast?: string;
  style?: ChartStyle;
  grid?: boolean;
  resetData?: boolean;
  print?: boolean;
  checkUpdate?: boolean;
  downloadCharts?: boolean;
  hypo?: import('../../store/appStore').HypoTab;
  session?: boolean;
  undo?: boolean;
  redo?: boolean;
  newSheet?: boolean;
  saveAs?: boolean;
  standardize?: boolean;
  transpose?: boolean;
  stack?: boolean;
  help?: boolean;
  options?: boolean;
};

/** 当前页所有 SVG 图表逐张转 PNG 下载 */
async function downloadPageCharts(toast: (m: string) => void, pageTitle: string) {
  const { svgElementToPng } = await import('../../platform/svgToPng');
  const svgs = [...document.querySelectorAll<SVGSVGElement>('main svg')].filter((s) => (s.viewBox.baseVal?.width ?? 0) >= 300);
  if (svgs.length === 0) {
    toast('本页没有可下载的图表');
    return;
  }
  toast(`正在导出 ${svgs.length} 张图表…`);
  for (let i = 0; i < svgs.length; i++) {
    try {
      const png = await svgElementToPng(svgs[i], 2);
      const url = URL.createObjectURL(new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${pageTitle}_图${i + 1}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* 单张失败不阻断 */ }
  }
  toast(`已下载 ${svgs.length} 张图表 PNG`);
}
interface Item { label?: string; kbd?: string; act?: Act; sep?: boolean }

const nav = (p: Page): Act => ({ page: p });
const tst = (m: string): Act => ({ toast: m });
const mdl = (m: Exclude<Modal, null>): Act => ({ modal: m });

const MENUS: { name: string; items: Item[] }[] = [
  { name: '文件', items: [
    { label: '新建工作表', kbd: 'Ctrl+N', act: { newSheet: true } },
    { label: '打开…', kbd: 'Ctrl+O', act: mdl('import') },
    { label: '导入 CSV / Excel…', act: mdl('import') },
    { sep: true },
    { label: '保存', kbd: 'Ctrl+S', act: tst('项目已保存') },
    { label: '另存为副本', act: { saveAs: true } },
    { sep: true },
    { label: '导出报表…', act: mdl('export') },
    { label: '打印…', kbd: 'Ctrl+P', act: { print: true } } ] },
  { name: '编辑', items: [
    { label: '撤销编辑', kbd: 'Ctrl+Z', act: { undo: true } },
    { label: '重做编辑', kbd: 'Ctrl+Y', act: { redo: true } },
    { sep: true },
    { label: '剪切', kbd: 'Ctrl+X', act: tst('已剪切') },
    { label: '复制', kbd: 'Ctrl+C', act: tst('已复制') },
    { label: '粘贴', kbd: 'Ctrl+V', act: tst('已粘贴') },
    { sep: true },
    { label: '查找 / 替换…', kbd: 'Ctrl+F', act: tst('查找 / 替换') } ] },
  { name: '数据', items: [
    { label: '导入数据…', act: mdl('import') },
    { label: '堆叠列（多列 → 单列+来源）', act: { stack: true } },
    { label: '转置列（行列互换）', act: { transpose: true } },
    { label: '排序…', act: mdl('sort') },
    { label: '筛选…', act: tst('筛选器已应用') },
    { sep: true },
    { label: '恢复演示数据集', act: { resetData: true } },
    { label: '查看工作表', act: nav('worksheet') } ] },
  { name: '计算', items: [
    { label: '计算器…', act: mdl('calc') },
    { label: '列统计…', act: mdl('colstats') },
    { label: '行统计（工作表内展示）', act: { page: 'worksheet', toast: '每行的均值 / 极差已在工作表末列展示' } },
    { sep: true },
    { label: '标准化（列 z-score）', act: { standardize: true } },
    { label: '生成随机数据…', act: mdl('random') } ] },
  { name: '统计', items: [
    { label: '控制图 (SPC)', act: nav('spc') },
    { label: '过程能力分析', act: nav('capability') },
    { label: '测量系统分析 Gage R&R', act: nav('gagerr') },
    { label: '方差分析 / 假设检验', act: nav('anova') },
    { label: '实验设计 (DOE)', act: nav('doe') },
    { label: '抽样检验 (AQL)', act: nav('aql') },
    { sep: true },
    { label: '基本统计量', act: nav('worksheet') } ] },
  { name: '图形', items: [
    { label: '直方图', act: nav('capability') },
    { label: '箱线图', act: nav('anova') },
    { label: '控制图', act: nav('spc') },
    { label: '帕累托图', act: nav('pareto') },
    { label: '时间序列图', act: nav('spc') },
    { label: '散点图 / 回归', act: { page: 'anova', hypo: 'reg' } },
    { label: '概率图', act: nav('capability') },
    { sep: true },
    { label: '下载本页图表 PNG', act: { downloadCharts: true } } ] },
  { name: '编辑器', items: [
    { label: '显示会话窗口', act: { session: true } },
    { label: '显示项目管理器', act: tst('项目管理器已显示') },
    { label: '列属性…', act: tst('列属性') } ] },
  { name: '工具', items: [
    { label: '图表风格：经典', act: { style: '经典' } },
    { label: '图表风格：现代', act: { style: '现代' } },
    { label: '图表风格：高对比', act: { style: '高对比' } },
    { label: '显示 / 隐藏网格线', act: { grid: true } },
    { sep: true },
    { label: '选项 / 本地数据…', act: mdl('options') },
    { label: '自定义工具栏…', act: tst('工具栏自定义') },
    { label: '宏 / 脚本…', act: tst('宏管理器') } ] },
  { name: '窗口', items: [
    { label: '质量总览', act: nav('dashboard') },
    { label: '数据工作表', act: nav('worksheet') },
    { label: '层叠窗口', act: tst('窗口已层叠') } ] },
  { name: '帮助', items: [
    { label: '帮助主题 / 统计指南', kbd: 'F1', act: mdl('help') },
    { sep: true },
    { label: '检查更新…', act: { checkUpdate: true } },
    { label: '关于本软件', act: mdl('about') } ] },
];

export function MenuBar({ wsName }: { wsName: string }) {
  const { openMenu, setOpenMenu, goTo, openModal, showToast, setChartStyle, toggleGrid } = useApp();

  const runCmd = (act?: Act) => {
    if (!act) return setOpenMenu(null);
    if (act.hypo) useApp.getState().setHypoTab(act.hypo);
    if (act.undo || act.redo) {
      const ok = act.undo ? useData.getState().undoEdit() : useData.getState().redoEdit();
      showToast(ok ? (act.undo ? '已撤销上一次数据编辑' : '已重做数据编辑') : (act.undo ? '没有可撤销的编辑' : '没有可重做的编辑'));
      return;
    }
    if (act.newSheet) {
      useData.getState().newWorksheet();
      goTo('worksheet');
      showToast('已新建空白工作表（双击单元格录入数据）');
      return;
    }
    if (act.saveAs) {
      const name = useData.getState().saveAsCopy();
      showToast('已另存为 ' + name);
      return;
    }
    if (act.standardize) {
      const name = useData.getState().standardize();
      if (name) {
        goTo('worksheet');
        showToast('已标准化为新数据集 ' + name);
      } else showToast('存在无变异列,无法标准化');
      return;
    }
    if (act.page) {
      goTo(act.page);
      if (act.toast) showToast(act.toast);
    }
    else if (act.modal) openModal(act.modal);
    else if (act.style) {
      setChartStyle(act.style);
      showToast('图表风格已切换为「' + act.style + '」');
    } else if (act.grid) {
      toggleGrid();
      showToast(useApp.getState().showGrid ? '网格线已显示' : '网格线已隐藏');
    } else if (act.resetData) {
      import('../../platform/mes').then((m) => m.mesStop());
      useData.getState().resetDemo();
      goTo('worksheet');
      showToast('已恢复演示数据集 质检数据.mtw');
    } else if (act.print) {
      setOpenMenu(null);
      if (platform.isDesktop) showToast('桌面端请使用「导出报表」生成文件后打印');
      else setTimeout(() => window.print(), 80);
    } else if (act.checkUpdate) {
      setOpenMenu(null);
      checkForUpdate(showToast);
    } else if (act.transpose || act.stack) {
      setOpenMenu(null);
      try {
        if (act.transpose) useData.getState().transposeDataset();
        else useData.getState().stackColumns();
        goTo('worksheet');
        showToast(act.transpose ? '已生成转置数据集' : '已生成堆叠数据集（含「来源列」分组,可直接做 ANOVA）');
      } catch (e) {
        showToast('操作失败：' + (e as Error).message);
      }
    } else if (act.session) {
      setOpenMenu(null);
      import('../../store/sessionLog').then((m) => m.useSessionLog.getState().toggle());
    } else if (act.downloadCharts) {
      setOpenMenu(null);
      const page = useApp.getState().page;
      downloadPageCharts(showToast, page);
    } else if (act.toast) showToast(act.toast);
    else setOpenMenu(null);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 30, background: 'linear-gradient(#ffffff,#f6f7f9)', borderBottom: '1px solid #dadee4', padding: '0 10px', flex: 'none', userSelect: 'none', position: 'relative', zIndex: 60 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12.5 }}>
        {MENUS.map((mu) => {
          const open = openMenu === mu.name;
          return (
            <div key={mu.name} style={{ position: 'relative' }}>
              <div
                className={open ? undefined : 'hov-menu-title'}
                onClick={() => setOpenMenu(open ? null : mu.name)}
                onMouseEnter={() => { if (openMenu && openMenu !== mu.name) setOpenMenu(mu.name); }}
                style={{ padding: '4px 9px', borderRadius: 3, cursor: 'pointer', ...(open ? { background: '#e7f0f9', color: '#1f6fb2' } : { color: '#3a4350' }) }}
              >
                {mu.name}
              </div>
              {open && (
                <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, minWidth: 236, background: '#fff', border: '1px solid #d7dbe1', borderRadius: 6, boxShadow: '0 12px 32px rgba(20,30,50,0.17)', padding: 5, zIndex: 200 }}>
                  {mu.items.map((it, i) =>
                    it.sep ? (
                      <div key={i} style={{ height: 1, background: '#eef0f3', margin: '5px 8px' }} />
                    ) : (
                      <div key={i} className="hov-menu-item" onClick={() => runCmd(it.act)} style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '7px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12.5, color: '#3a4350' }}>
                        <span style={{ flex: 1 }}>{it.label}</span>
                        <span className="mono" style={{ fontSize: 11, color: '#a3abb5' }}>{it.kbd || ''}</span>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, color: '#8a929d', fontSize: 12 }}>
        <span style={{ color: '#3a4350', fontWeight: 600 }}>{wsName}</span>
        <span style={{ width: 1, height: 14, background: '#dadee4' }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#1f6fb2', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>质</span>
          质量工程部
        </span>
      </div>
    </div>
  );
}
