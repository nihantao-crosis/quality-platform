/** 四个弹窗：导入 / 导出 / 计算器 / 关于 + Toast。 */
import { useApp, type ImportTab, type ExportFmt } from '../../store/appStore';
import { platform } from '../../platform/adapter';
import { buildExportPayload } from '../../platform/report';
import { DATA } from '../../dataModel';

const tabStyle = (a: boolean): React.CSSProperties =>
  a
    ? { padding: '6px 15px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: '#1f6fb2', color: '#fff', whiteSpace: 'nowrap' }
    : { padding: '6px 15px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#4a5462', background: '#eef1f4', whiteSpace: 'nowrap' };

function ModalFrame({ width, title, onClose, children, footer }: {
  width: number; title: string; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div style={{ position: 'relative', width, background: '#fff', borderRadius: 10, boxShadow: '0 24px 60px rgba(10,20,40,0.32)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #edf0f3' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>{title}</div>
        <div onClick={onClose} style={{ marginLeft: 'auto', cursor: 'pointer', color: '#9aa2ad', fontSize: 17 }}>✕</div>
      </div>
      {children}
      {footer && (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 20px', borderTop: '1px solid #edf0f3', background: '#fafbfc' }}>{footer}</div>
      )}
    </div>
  );
}

const cancelBtn: React.CSSProperties = { padding: '8px 18px', border: '1px solid #cfd5dd', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#5b6472' };
const primaryBtn: React.CSSProperties = { padding: '8px 18px', background: '#1f6fb2', color: '#fff', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 };

function ImportModal() {
  const { importTab, setImportTab, closeModal, goTo, showToast } = useApp();
  const tabs: Array<[ImportTab, string]> = [['csv', 'CSV 文件'], ['excel', 'Excel 工作簿'], ['clip', '剪贴板粘贴'], ['mes', 'MES 实时采集']];
  const doImport = () => { goTo('worksheet'); showToast('已导入 125 行 × 11 列 到 质检数据.mtw'); };
  const pickFile = async () => {
    const f = await platform.pickImportFile();
    if (!f) return;
    const lines = f.contents.split(/\r?\n/).filter((l) => l.trim() !== '');
    const cols = lines[0] ? lines[0].split(/[,\t]/).length : 0;
    goTo('worksheet');
    showToast(`已读取 ${f.name} · ${lines.length} 行 × ${cols} 列（演示版仍使用内置数据集）`);
  };
  return (
    <ModalFrame width={560} title="导入数据" onClose={closeModal}
      footer={<>
        <div onClick={closeModal} style={cancelBtn}>取消</div>
        <div onClick={doImport} style={primaryBtn}>导入</div>
      </>}>
      <div style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => (
            <div key={k} style={tabStyle(importTab === k)} onClick={() => setImportTab(k)}>{l}</div>
          ))}
        </div>
        {(importTab === 'csv' || importTab === 'excel') && (
          <div style={{ border: '2px dashed #cdd6e0', borderRadius: 8, padding: 34, textAlign: 'center', background: '#f9fbfd' }}>
            <div style={{ fontSize: 13.5, color: '#5b6472', fontWeight: 500 }}>拖拽文件到此处，或点击选择文件</div>
            <div style={{ fontSize: 12, color: '#9aa2ad', marginTop: 6 }}>
              {importTab === 'excel' ? '支持 .xlsx / .xls 工作簿，首行作为列名' : '支持 .csv / .txt，自动识别分隔符与列名'}
            </div>
            <div onClick={pickFile} style={{ display: 'inline-block', marginTop: 14, padding: '8px 18px', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>选择文件</div>
          </div>
        )}
        {importTab === 'clip' && (
          <textarea
            placeholder="将数据粘贴到此处（支持 Tab / 逗号分隔）…"
            style={{ width: '100%', height: 150, border: '1px solid #cfd5dd', borderRadius: 6, padding: 12, fontFamily: 'IBM Plex Mono,monospace', fontSize: 12.5, resize: 'none', boxSizing: 'border-box' }}
          />
        )}
        {importTab === 'mes' && (
          <div style={{ border: '1px solid #eaeef2', borderRadius: 6, overflow: 'hidden' }}>
            {[['产线 A · CNC-01', '● 在线', '#2c8a45'], ['产线 A · CNC-02', '● 在线', '#2c8a45'], ['产线 B · 三坐标 CMM', '● 采集中', '#e0902a']].map(([n, s, c], i, arr) => (
              <div key={n} style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 14px', borderBottom: i < arr.length - 1 ? '1px solid #f2f4f6' : undefined, fontSize: 12.5 }}>
                <span style={{ color: '#3a4350' }}>{n}</span>
                <span style={{ color: c, fontWeight: 600 }}>{s}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </ModalFrame>
  );
}

function ExportModal() {
  const { exportFmt, setExportFmt, closeModal, showToast } = useApp();
  const fmts: Array<[ExportFmt, string, string]> = [
    ['pdf', 'PDF 报告', '便携文档 · 打印存档'],
    ['excel', 'Excel', '数据 + 统计表'],
    ['ppt', 'PowerPoint', '图表演示'],
    ['word', 'Word', '图文报告'],
  ];
  const doExport = async () => {
    const { lsl, tgt, usl } = useApp.getState();
    const payload = buildExportPayload(exportFmt, DATA, { lsl, tgt, usl });
    const dest = await platform.exportReport(exportFmt, payload.defaultName, payload.contents);
    if (dest == null) return; // 用户取消
    showToast(platform.isDesktop ? '报表已保存: ' + dest : '报表已导出: ' + dest);
    closeModal();
  };
  return (
    <ModalFrame width={520} title="导出报表" onClose={closeModal}
      footer={<>
        <div onClick={closeModal} style={cancelBtn}>取消</div>
        <div onClick={doExport} style={primaryBtn}>导出</div>
      </>}>
      <div style={{ padding: '18px 20px' }}>
        <div style={{ fontSize: 12.5, color: '#8a929d', marginBottom: 10 }}>选择导出格式</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {fmts.map(([k, l, d]) => (
            <div key={k} onClick={() => setExportFmt(k)}
              style={{ border: '1px solid ' + (exportFmt === k ? '#1f6fb2' : '#e2e5ea'), background: exportFmt === k ? '#f0f6fc' : '#fff', borderRadius: 6, padding: '12px 14px', cursor: 'pointer' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#26303c' }}>{l}</div>
              <div style={{ fontSize: 11.5, color: '#8a929d', marginTop: 3 }}>{d}</div>
            </div>
          ))}
        </div>
      </div>
    </ModalFrame>
  );
}

function CalcModal() {
  const { calc, pressCalc, closeModal } = useApp();
  const base: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 46, borderRadius: 6, cursor: 'pointer', fontSize: 16, fontFamily: 'IBM Plex Mono,monospace', fontWeight: 500, userSelect: 'none' };
  const styleOf = (t: string): React.CSSProperties => {
    if (t === 'op') return { ...base, background: '#eaf1f9', color: '#1f6fb2', fontWeight: 600 };
    if (t === 'eq') return { ...base, background: '#1f6fb2', color: '#fff', fontWeight: 700 };
    if (t === 'fn') return { ...base, background: '#f0f2f5', color: '#5b6472' };
    return { ...base, background: '#f7f9fb', color: '#26303c' };
  };
  const btns: Array<[string, string]> = [
    ['C', 'fn'], ['±', 'fn'], ['÷', 'op'], ['×', 'op'],
    ['7', 'n'], ['8', 'n'], ['9', 'n'], ['−', 'op'],
    ['4', 'n'], ['5', 'n'], ['6', 'n'], ['+', 'op'],
    ['1', 'n'], ['2', 'n'], ['3', 'n'], ['=', 'eq'],
    ['00', 'n'], ['0', 'n'], ['.', 'n'], ['⌫', 'fn'],
  ];
  return (
    <ModalFrame width={300} title="计算器" onClose={closeModal}>
      <div style={{ padding: 16 }}>
        <div className="mono" style={{ background: '#f4f6f8', borderRadius: 8, padding: 16, textAlign: 'right', fontSize: 28, fontWeight: 600, color: '#26303c', marginBottom: 12, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {calc.disp}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
          {btns.map(([k, t]) => (
            <div key={k} style={styleOf(t)} onClick={() => pressCalc(k)}>{k}</div>
          ))}
        </div>
      </div>
    </ModalFrame>
  );
}

function AboutModal() {
  const { closeModal } = useApp();
  return (
    <ModalFrame width={460} title="关于本软件" onClose={closeModal}
      footer={<div onClick={closeModal} style={primaryBtn}>确定</div>}>
      <div style={{ padding: '22px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <span style={{ width: 40, height: 40, borderRadius: 9, background: '#1f6fb2', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700 }}>质</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#26303c' }}>质量分析平台</div>
            <div style={{ fontSize: 12, color: '#8a929d' }}>Quality Analytics Platform · v1.0</div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.7 }}>
          面向工厂质量部门的统计分析工具，涵盖 SPC 控制图、过程能力、测量系统分析、方差分析、实验设计与抽样检验。所有统计量均为实时计算。
        </div>
      </div>
    </ModalFrame>
  );
}

export function Modals() {
  const { modal, closeModal } = useApp();
  if (!modal) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(20,28,40,0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={closeModal} style={{ position: 'absolute', inset: 0 }} />
      {modal === 'import' && <ImportModal />}
      {modal === 'export' && <ExportModal />}
      {modal === 'calc' && <CalcModal />}
      {modal === 'about' && <AboutModal />}
    </div>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  return (
    <div style={{ position: 'fixed', bottom: 40, right: 26, zIndex: 400, background: '#26303c', color: '#fff', padding: '12px 18px', borderRadius: 8, boxShadow: '0 12px 30px rgba(10,20,40,0.3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#43c46e' }} />
      {toast}
    </div>
  );
}
