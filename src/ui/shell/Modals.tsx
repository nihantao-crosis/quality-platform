/** 四个弹窗：导入 / 导出 / 计算器 / 关于 + Toast。 */
import { useState } from 'react';
import { useApp, type ImportTab, type ExportFmt } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { parseMatrix, type ParsedMatrix } from '../../core';
import { platform } from '../../platform/adapter';
import { buildExportJob } from '../../platform/report';
import { mesStart, mesStop } from '../../platform/mes';

type DataKind = 'var' | 'p' | 'c';

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
  const { importMatrix, importCounts, mesRunning, model } = useData();
  const [pending, setPending] = useState<{ name: string; parsed: ParsedMatrix } | null>(null);
  const [clipText, setClipText] = useState('');
  const [dataKind, setDataKind] = useState<DataKind>('var');
  const [pSampleSize, setPSampleSize] = useState(50);
  const tabs: Array<[ImportTab, string]> = [['csv', 'CSV 文件'], ['excel', 'Excel 工作簿'], ['clip', '剪贴板粘贴'], ['mes', 'MES 实时采集']];

  const tryParse = (name: string, text: string) => {
    const r = parseMatrix(text);
    if ('error' in r) {
      showToast('导入失败：' + r.error);
      return;
    }
    setPending({ name, parsed: r });
  };

  const pickFile = async () => {
    const f = await platform.pickImportFile();
    if (!f) return;
    if (f.bytes) {
      // 真 Excel 工作簿：SheetJS 解析首个 sheet 转 CSV
      const { xlsxBytesToCsv } = await import('../../platform/xlsxImport');
      const r = xlsxBytesToCsv(f.bytes);
      if ('error' in r) {
        showToast('导入失败：' + r.error);
        return;
      }
      tryParse(`${f.name} · ${r.sheetName}`, r.csv);
      return;
    }
    tryParse(f.name, f.contents ?? '');
  };

  const applyJob = (name: string, p: ParsedMatrix) => {
    mesStop(); // 导入新数据前停掉模拟采集
    if (dataKind === 'var') {
      importMatrix(name, p.colNames, p.rows, p.textCols);
      goTo('worksheet');
      const notes: string[] = [];
      if (p.skippedRows > 0) notes.push(`跳过 ${p.skippedRows} 行非法值`);
      if (p.textCols.length > 0) notes.push(`含 ${p.textCols.length} 个分组列（可用于 ANOVA / Gage）`);
      showToast(`已导入 ${name} · ${p.rows.length} 子组 × ${p.colNames.length} 测量列${notes.length ? ' · ' + notes.join(' · ') : ''}`);
      return true;
    }
    // 计数数据：取第一个数值列
    const counts = p.rows.map((r) => r[0]);
    if (counts.some((c) => c < 0 || !Number.isInteger(c))) {
      showToast('导入失败：计数必须为非负整数');
      return false;
    }
    try {
      importCounts(dataKind, name, counts, pSampleSize);
    } catch (e) {
      showToast('导入失败：' + (e as Error).message);
      return false;
    }
    goTo('spc');
    showToast(`已导入 ${name} · ${counts.length} 个${dataKind === 'p' ? '样本不良数（P 图）' : '单位缺陷数（C 图）'}`);
    return true;
  };

  const doImport = () => {
    if (importTab === 'mes') return; // MES tab 有自己的控制按钮
    let job = pending;
    if (!job && importTab === 'clip' && clipText.trim() !== '') {
      const r = parseMatrix(clipText);
      if ('error' in r) {
        showToast('导入失败：' + r.error);
        return;
      }
      job = { name: '剪贴板数据', parsed: r };
    }
    if (!job) {
      showToast(importTab === 'clip' ? '请先粘贴数据' : '请先选择数据文件');
      return;
    }
    if (applyJob(job.name, job.parsed)) {
      setPending(null);
      setClipText('');
    }
  };

  const kindSelector = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12.5, flexWrap: 'wrap' }}>
      <span style={{ color: '#8a929d', fontWeight: 600, fontSize: 12 }}>数据类型</span>
      {([['var', '变量数据（子组矩阵）'], ['p', '不良数（P 图）'], ['c', '缺陷数（C 图）']] as Array<[DataKind, string]>).map(([k, l]) => (
        <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#3a4350' }}>
          <input type="radio" checked={dataKind === k} onChange={() => setDataKind(k)} />
          {l}
        </label>
      ))}
      {dataKind === 'p' && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#5b6472' }}>
          样本量 n
          <input
            type="number"
            min={1}
            value={pSampleSize}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v >= 1) setPSampleSize(v);
            }}
            className="mono"
            style={{ width: 64, padding: '3px 6px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12 }}
          />
        </label>
      )}
    </div>
  );
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
        {(importTab === 'csv' || importTab === 'excel' || importTab === 'clip') && kindSelector}
        {(importTab === 'csv' || importTab === 'excel') && (
          <div style={{ border: '2px dashed #cdd6e0', borderRadius: 8, padding: 34, textAlign: 'center', background: '#f9fbfd' }}>
            {pending ? (
              <>
                <div style={{ fontSize: 13.5, color: '#2c8a45', fontWeight: 600 }}>✓ {pending.name}</div>
                <div className="mono" style={{ fontSize: 12, color: '#5b6472', marginTop: 6 }}>
                  {pending.parsed.rows.length} 子组 × {pending.parsed.colNames.length} 测量列 · {pending.parsed.colNames.join(' / ')}
                </div>
                {(pending.parsed.skippedRows > 0 || pending.parsed.droppedCols > 0) && (
                  <div style={{ fontSize: 11.5, color: '#d98324', marginTop: 4 }}>
                    {pending.parsed.skippedRows > 0 ? `跳过 ${pending.parsed.skippedRows} 行非法值 ` : ''}
                    {pending.parsed.droppedCols > 0 ? `忽略 ${pending.parsed.droppedCols} 个非数值列` : ''}
                  </div>
                )}
                <div onClick={pickFile} style={{ display: 'inline-block', marginTop: 14, padding: '8px 18px', border: '1px solid #cfd5dd', color: '#5b6472', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#fff' }}>重新选择</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13.5, color: '#5b6472', fontWeight: 500 }}>点击选择数据文件</div>
                <div style={{ fontSize: 12, color: '#9aa2ad', marginTop: 6 }}>
                  {importTab === 'excel' ? '支持 .xlsx / .xls 工作簿（读取首个工作表，首行作为列名）' : '支持 .csv / .txt，自动识别分隔符与列名'}
                </div>
                <div onClick={pickFile} style={{ display: 'inline-block', marginTop: 14, padding: '8px 18px', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>选择文件</div>
              </>
            )}
          </div>
        )}
        {importTab === 'clip' && (
          <textarea
            value={clipText}
            onChange={(e) => setClipText(e.target.value)}
            placeholder={'将数据粘贴到此处（支持 Tab / 逗号分隔）…\n例：\n直径1,直径2,直径3\n25.01,24.99,25.02\n24.98,25.03,25.00'}
            style={{ width: '100%', height: 150, border: '1px solid #cfd5dd', borderRadius: 6, padding: 12, fontFamily: 'IBM Plex Mono,monospace', fontSize: 12.5, resize: 'none', boxSizing: 'border-box' }}
          />
        )}
        {importTab === 'mes' && (
          <>
            <div style={{ border: '1px solid #eaeef2', borderRadius: 6, overflow: 'hidden', marginBottom: 14 }}>
              {[
                ['产线 A · CNC-01', mesRunning ? '● 采集中' : '● 在线', mesRunning ? '#e0902a' : '#2c8a45'],
                ['产线 A · CNC-02', '● 在线', '#2c8a45'],
                ['产线 B · 三坐标 CMM', '● 待机', '#8a929d'],
              ].map(([n, s, c], i, arr) => (
                <div key={n} style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 14px', borderBottom: i < arr.length - 1 ? '1px solid #f2f4f6' : undefined, fontSize: 12.5 }}>
                  <span style={{ color: '#3a4350' }}>{n}</span>
                  <span style={{ color: c as string, fontWeight: 600 }}>{s}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {mesRunning ? (
                <>
                  <div
                    onClick={() => { mesStop(); showToast('MES 采集已停止 · 共 ' + model.k + ' 子组'); }}
                    style={{ padding: '8px 18px', background: '#c22f2f', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    ■ 停止采集
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: '#1f6fb2' }}>已采集 {model.k} 子组 · SPC 页实时更新</span>
                </>
              ) : (
                <>
                  <div
                    onClick={() => { mesStart(); goTo('spc'); showToast('MES 模拟采集已启动 · 控制图实时更新'); closeModal(); }}
                    style={{ padding: '8px 18px', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    ▶ 开始模拟采集
                  </div>
                  <span style={{ fontSize: 11.5, color: '#9aa2ad' }}>模拟 CNC-01 每 0.8s 产出一个 n=5 子组（偶发过程漂移），生产版接串口/OPC-UA</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </ModalFrame>
  );
}

function ExportModal() {
  const { exportFmt, setExportFmt, closeModal, showToast } = useApp();
  const fmts: Array<[ExportFmt, string, string]> = [
    ['pdf', 'PDF 报告', '图文 HTML · 打开后打印即 PDF'],
    ['excel', 'Excel', '真 .xlsx · 数据 + 统计 + 失控点'],
    ['ppt', 'PowerPoint', '真 .pptx · 封面 + 指标 + 图表'],
    ['word', 'Word', '真 .docx · 图文四节报告'],
  ];
  const doExport = async () => {
    const { lsl, tgt, usl } = useApp.getState();
    const job = await buildExportJob(exportFmt, useData.getState().model, { lsl, tgt, usl });
    const dest = await platform.exportFile(job);
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
