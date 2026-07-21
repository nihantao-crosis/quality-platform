/** 四个弹窗：导入 / 导出 / 计算器 / 关于 + Toast。 */
import { useState, useEffect, useRef } from 'react';
import { useApp, type ImportTab, type ExportFmt } from '../../store/appStore';
import { markActiveDataReplaced, prepareVaultDatasetRemoval, useData } from '../../store/dataStore';
import { parseMatrix, parseCategoryCounts, extractPChartColumns, evalFormula, truthy, arrMin, arrMax, mean, stdev, FormulaError, worksheetNumericColumnCodes, detectCsvBlocks, assessSpcCharts, type CsvBlock, type ParsedMatrix } from '../../core';
import { assertXlsxImportSize, platform } from '../../platform/adapter';
import { assertTextImportSize } from '../../platform/importLimits';
import { buildExportJob } from '../../platform/report';
import { mesStart, mesStop } from '../../platform/mes';
import { sessionLog } from '../../store/sessionLog';
import { isProjectFile, applyProjectText } from '../../platform/project';
import { HelpModal } from './HelpModal';
import { OptionsModal } from './OptionsModal';

import type { ImportKind } from '../../store/appStore';
type DataKind = ImportKind;

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
}

const tabStyle = (a: boolean): React.CSSProperties =>
  a
    ? { padding: '6px 15px', border: 0, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, background: '#1f6fb2', color: '#fff', whiteSpace: 'nowrap' }
    : { padding: '6px 15px', border: 0, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: '#4a5462', background: '#eef1f4', whiteSpace: 'nowrap' };

function ModalFrame({ width, title, onClose, children, footer }: {
  width: number; title: string; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div style={{ position: 'relative', width, background: '#fff', borderRadius: 10, boxShadow: '0 24px 60px rgba(10,20,40,0.32)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #edf0f3' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>{title}</div>
        <button type="button" aria-label={`关闭${title}`} onClick={onClose} style={{ marginLeft: 'auto', border: 0, background: 'transparent', cursor: 'pointer', color: '#9aa2ad', fontSize: 17 }}>✕</button>
      </div>
      {children}
      {footer && (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 20px', borderTop: '1px solid #edf0f3', background: '#fafbfc' }}>{footer}</div>
      )}
    </div>
  );
}

const cancelBtn: React.CSSProperties = { padding: '8px 18px', border: '1px solid #cfd5dd', background: '#fff', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: '#5b6472' };
const primaryBtn: React.CSSProperties = { padding: '8px 18px', border: '1px solid #1f6fb2', background: '#1f6fb2', color: '#fff', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600 };

function ImportModal() {
  const { importTab, setImportTab, importKind, setImportKind, closeModal, goTo, showToast } = useApp();
  const { importMatrix, importCounts, importPareto, mesRunning, model } = useData();
  const [pending, setPending] = useState<{ name: string; raw: string; parsed?: ParsedMatrix; cats?: number } | null>(null);
  const [blockChoices, setBlockChoices] = useState<{ name: string; raw: string; blocks: CsvBlock[] } | null>(null);
  const [clipText, setClipText] = useState('');
  const [dataKind, setDataKind] = useState<DataKind>(importKind);
  const [pSampleSize, setPSampleSize] = useState(50);
  const [paretoCategoryCol, setParetoCategoryCol] = useState('');
  const [paretoCountCol, setParetoCountCol] = useState('');
  const tabs: Array<[ImportTab, string]> = [['csv', 'CSV 文件'], ['excel', 'Excel 工作簿'], ['clip', '剪贴板粘贴'], ['mes', 'MES 实时采集']];

  const paretoColumns = () => {
    if (paretoCategoryCol.trim() === '' && paretoCountCol.trim() === '') return undefined;
    const categoryColumn = Number(paretoCategoryCol) - 1;
    const countColumn = Number(paretoCountCol) - 1;
    if (!Number.isInteger(categoryColumn) || !Number.isInteger(countColumn) || categoryColumn < 0 || countColumn < 0) {
      showToast('帕累托手动选列时，请同时填写从 1 开始的类别列和频数列');
      return null;
    }
    return { categoryColumn, countColumn };
  };

  const tryParse = (name: string, text: string) => {
    if (dataKind === 'pareto') {
      const cols = paretoColumns();
      if (cols === null) return;
      const r = parseCategoryCounts(text, cols);
      if ('error' in r) {
        showToast('导入失败：' + r.error);
        return;
      }
      setPending({ name, raw: text, cats: r.rows.length });
      return;
    }
    // v1.40:并排多数据块(工厂 MSA 五案例工作簿)先让用户显式选块,不做整表瞎猜
    const blocks = detectCsvBlocks(text);
    if (blocks.length > 1) {
      setPending(null);
      setBlockChoices({ name, raw: text, blocks });
      return;
    }
    setBlockChoices(null);
    const r = parseMatrix(text);
    if ('error' in r) {
      if (blocks.length === 1) {
        const block = blocks[0];
        const retried = parseMatrix(block.csv);
        if (!('error' in retried)) {
          setPending({ name: `${name} · ${block.name}`, raw: block.csv, parsed: retried });
          showToast(`整表解析失败，已截取检测到的表格区域「${block.name}」(${block.rows} 行)`);
          return;
        }
      }
      showToast('导入失败：' + r.error);
      return;
    }
    setPending({ name, raw: text, parsed: r });
  };

  const chooseBlock = (choice: { name: string; raw: string; blocks: CsvBlock[] }, block: CsvBlock) => {
    const parsed = parseMatrix(block.csv);
    if ('error' in parsed) {
      showToast(`数据块「${block.name}」解析失败：` + parsed.error);
      return;
    }
    if (importTab === 'clip') {
      // 剪贴板流:把选中块写回文本框(所见即所导),不设隐藏 pending 压过文本框(对抗审查 P2)
      setClipText(block.csv);
      setBlockChoices(null);
      showToast(`已选数据块「${block.name}」(${block.rows} 行),文本框已更新,请再点「导入」确认`);
      return;
    }
    setPending({ name: `${choice.name} · ${block.name}`, raw: block.csv, parsed });
    setBlockChoices(null);
  };

  // 逃生口:带装饰性空隔列的正常宽表会被拆成多块,必须保留 v1.39 的整表导入路径
  const importWholeTable = (choice: { name: string; raw: string; blocks: CsvBlock[] }) => {
    if (applyJob(choice.name, choice.raw)) {
      setPending(null);
      setBlockChoices(null);
      setClipText('');
      closeModal();
    }
  };

  const handlePicked = async (name: string, contents?: string, bytes?: Uint8Array) => {
    if (bytes) {
      // 真 Excel 工作簿：SheetJS 解析首个 sheet 转 CSV
      const { xlsxBytesToCsv } = await import('../../platform/xlsxImport');
      const r = xlsxBytesToCsv(bytes);
      if ('error' in r) {
        showToast('导入失败：' + r.error);
        return;
      }
      tryParse(`${name} · ${r.sheetName}`, r.csv);
      return;
    }
    tryParse(name, contents ?? '');
  };

  const pickFile = async () => {
    let f;
    try {
      f = await platform.pickImportFile();
    } catch (error) {
      showToast('导入失败：' + (error as Error).message);
      return;
    }
    if (!f) return;
    if (isProjectFile(f.name)) {
      // P0-3:导入期间锁死整个界面(遮罩层 zIndex 高于弹窗),失败才解锁;成功保持锁定直至 reload。
      useApp.getState().setBusyOverlay('正在导入项目，请勿操作…（完成后将自动重载）');
      const r = await applyProjectText(f.contents ?? '');
      if (r.error) {
        useApp.getState().setBusyOverlay(null);
        showToast('打开项目失败：' + r.error);
        return;
      }
      sessionLog('打开项目文件 ' + f.name + (r.note ? ' · ' + r.note : '') + ' · 即将重载');
      showToast(r.note ? `项目已恢复(${r.note}),正在重载…` : '项目已恢复,正在重载…');
      markActiveDataReplaced(); // 旧内存数据即将被新项目替换,不再触发 beforeunload 拦截
      setTimeout(() => location.reload(), 900);
      return;
    }
    handlePicked(f.name, f.contents, f.bytes);
  };

  const [dragOver, setDragOver] = useState(false);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (isProjectFile(file.name)) {
      let text: string;
      try {
        assertTextImportSize(file.name, file.size);
        text = await file.text(); // 拖放源文件可能已被移动/删除;必须在上锁之前读取
      } catch (error) {
        showToast('打开项目失败：' + ((error as Error).message
          || '无法读取拖入的文件（源文件可能已被移动或删除）'));
        return;
      }
      useApp.getState().setBusyOverlay('正在导入项目，请勿操作…（完成后将自动重载）');
      const r = await applyProjectText(text);
      if (r.error) {
        useApp.getState().setBusyOverlay(null);
        showToast('打开项目失败：' + r.error);
        return;
      }
      sessionLog('打开项目文件 ' + file.name + (r.note ? ' · ' + r.note : '') + ' · 即将重载');
      showToast(r.note ? `项目已恢复(${r.note}),正在重载…` : '项目已恢复,正在重载…');
      markActiveDataReplaced();
      setTimeout(() => location.reload(), 900);
      return;
    }
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      try {
        assertXlsxImportSize(file.size); // 拖放流程在读取前拒绝过大文件
        const bytes = new Uint8Array(await file.arrayBuffer());
        assertXlsxImportSize(bytes.byteLength);
        handlePicked(file.name, undefined, bytes);
      } catch (error) {
        showToast('导入失败：' + (error as Error).message);
      }
    } else {
      try {
        assertTextImportSize(file.name, file.size);
        handlePicked(file.name, await file.text());
      } catch (error) {
        showToast('导入失败：' + (error as Error).message);
      }
    }
  };

  // P0-5:只有真正落盘才显示绿色成功;未持久化时给高优先级警告(刷新会丢数据)。
  const persistAwareToast = (outcome: { persisted: boolean; archiving: boolean }, successMsg: string) => {
    if (outcome.persisted) { showToast(successMsg); return; }
    if (outcome.archiving) { showToast(successMsg + '；数据集较大,正在归档到本机数据集库…'); return; }
    showToast('⚠ 数据已导入到内存,但浏览器存储空间不足,尚未持久化——刷新将丢失！请立即「文件 → 导出项目」备份,或在「工具 → 选项」清理本地数据');
  };

  const applyJob = (name: string, raw: string) => {
    mesStop(); // 导入新数据前停掉模拟采集
    if (dataKind === 'pareto') {
      const cols = paretoColumns();
      if (cols === null) return false;
      const r = parseCategoryCounts(raw, cols);
      if ('error' in r) {
        showToast('导入失败：' + r.error);
        return false;
      }
      const paretoOutcome = importPareto(name, r.rows);
      goTo('pareto');
      persistAwareToast(paretoOutcome, `已导入帕累托数据 ${name} · ${r.rows.length} 个类别${r.note ? ' · ' + r.note : ''}`);
      return true;
    }
    const parsed = parseMatrix(raw);
    if ('error' in parsed) {
      showToast('导入失败：' + parsed.error);
      return false;
    }
    const p = parsed;
    if (dataKind === 'var') {
      const varOutcome = importMatrix(name, p.colNames, p.rows, p.textCols);
      goTo('worksheet');
      const notes: string[] = [];
      if (p.skippedRows > 0) notes.push(`跳过 ${p.skippedRows} 行非法值`);
      if (p.textCols.length > 0) notes.push(`含 ${p.textCols.length} 个分组列（可用于 ANOVA / Gage）`);
      persistAwareToast(varOutcome, `已导入 ${name} · ${p.rows.length} 行 × ${p.colNames.length} 个数值列；请在 SPC 页确认数据角色${notes.length ? ' · ' + notes.join(' · ') : ''}`);
      return true;
    }
    if (dataKind === 'p') {
      const extracted = extractPChartColumns(p, pSampleSize);
      if ('error' in extracted) {
        showToast('导入失败：' + extracted.error);
        return false;
      }
      let pOutcome: { persisted: boolean; archiving: boolean };
      try {
        pOutcome = importCounts('p', name, extracted.counts, extracted.sampleSizes);
      } catch (e) {
        showToast('导入失败：' + (e as Error).message);
        return false;
      }
      goTo('spc');
      persistAwareToast(pOutcome, `已导入 ${name} · ${extracted.counts.length} 个样本不良数（P 图）${extracted.variableSampleSizes ? ' · 使用逐批样本量' : ''}`);
      return true;
    }
    // C 图只能接受一列计数；不能静默丢弃多余列。
    if (p.colNames.length !== 1 || p.textCols.length > 0) {
      showToast(`导入失败：C 图数据应为单列计数（检测到 ${p.colNames.length + p.textCols.length} 列）`);
      return false;
    }
    const counts = p.rows.map((r) => r[0]);
    if (counts.some((c) => c < 0 || !Number.isInteger(c))) {
      showToast('导入失败：计数必须为非负整数');
      return false;
    }
    let cOutcome: { persisted: boolean; archiving: boolean };
    try {
      cOutcome = importCounts('c', name, counts);
    } catch (e) {
      showToast('导入失败：' + (e as Error).message);
      return false;
    }
    goTo('spc');
    persistAwareToast(cOutcome, `已导入 ${name} · ${counts.length} 个单位缺陷数（C 图）`);
    return true;
  };

  const doImport = () => {
    if (importTab === 'mes') return; // MES tab 有自己的控制按钮
    let job = pending;
    if (!job && importTab === 'clip' && clipText.trim() !== '') {
      // v1.40:剪贴板与文件同权——并排多数据块先选块(芯片含「按整表导入」逃生口)
      if (dataKind !== 'pareto') {
        const blocks = detectCsvBlocks(clipText);
        if (blocks.length > 1) {
          setBlockChoices({ name: '剪贴板数据', raw: clipText, blocks });
          return;
        }
        if (blocks.length === 1) {
          const direct = parseMatrix(clipText);
          if ('error' in direct) {
            const retried = parseMatrix(blocks[0].csv);
            if (!('error' in retried)) {
              showToast(`整段解析失败，已截取检测到的表格区域「${blocks[0].name}」(${blocks[0].rows} 行)`);
              job = { name: `剪贴板数据 · ${blocks[0].name}`, raw: blocks[0].csv };
            }
          }
        }
      }
      job = job ?? { name: '剪贴板数据', raw: clipText };
    }
    if (!job) {
      showToast(importTab === 'clip' ? '请先粘贴数据' : '请先选择数据文件');
      return;
    }
    if (applyJob(job.name, job.raw)) {
      setPending(null);
      setClipText('');
      closeModal();
    }
  };

  const kindSelector = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12.5, flexWrap: 'wrap' }}>
      <span style={{ color: '#8a929d', fontWeight: 600, fontSize: 12 }}>数据类型</span>
      {([['var', '变量数据（子组矩阵）'], ['p', '不良数（P 图）'], ['c', '缺陷数（C 图）'], ['pareto', '缺陷类别+频数（帕累托）']] as Array<[DataKind, string]>).map(([k, l]) => (
        <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#3a4350' }}>
          <input type="radio" checked={dataKind === k} onChange={() => { setDataKind(k); setImportKind(k); setPending(null); setBlockChoices(null); }} />
          {l}
        </label>
      ))}
      {dataKind === 'p' && (
        <>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#5b6472' }}>
            单列默认样本量 n
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
          <span style={{ color: '#8a929d', fontSize: 11.5 }}>两列时按“不良数, 每批样本量”读取，界面默认 n 不参与计算</span>
        </>
      )}
      {dataKind === 'pareto' && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#5b6472', flexWrap: 'wrap' }}>
          多列时指定：类别列
          <input
            type="number" min={1} step={1} placeholder="自动" value={paretoCategoryCol}
            onChange={(e) => { setParetoCategoryCol(e.target.value); setPending(null); }}
            className="mono" title="从 1 开始；留空时自动识别"
            style={{ width: 58, padding: '3px 6px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12 }}
          />
          频数列
          <input
            type="number" min={1} step={1} placeholder="自动" value={paretoCountCol}
            onChange={(e) => { setParetoCountCol(e.target.value); setPending(null); }}
            className="mono" title="从 1 开始；留空时自动识别"
            style={{ width: 58, padding: '3px 6px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12 }}
          />
        </span>
      )}
    </div>
  );
  return (
    <ModalFrame width={560} title="导入数据" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" onClick={doImport} style={primaryBtn}>导入</button>
      </>}>
      <div style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => (
            <button type="button" role="tab" aria-selected={importTab === k} key={k} style={tabStyle(importTab === k)} onClick={() => { setImportTab(k); setBlockChoices(null); }}>{l}</button>
          ))}
        </div>
        {(importTab === 'csv' || importTab === 'excel' || importTab === 'clip') && kindSelector}
        {blockChoices && dataKind !== 'pareto' && (importTab === 'csv' || importTab === 'excel' || importTab === 'clip') && (
          <div role="group" aria-label="选择数据块" style={{ margin: '0 0 12px', padding: '10px 12px', border: '1px solid #cfe0f0', background: '#f4f9fe', borderRadius: 6 }}>
            <div style={{ fontSize: 12.5, color: '#1c4e7a', fontWeight: 600, marginBottom: 8 }}>
              「{blockChoices.name}」检测到 {blockChoices.blocks.length} 个并排数据块（工作表含说明区/多案例并排），请选择要导入的一块：
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {blockChoices.blocks.map((block, index) => (
                <button
                  type="button" key={index}
                  onClick={() => chooseBlock(blockChoices, block)}
                  style={{ padding: '6px 10px', border: '1px solid #9dbede', background: '#fff', color: '#1c4e7a', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
                >
                  {block.name}（{block.headers.join('/')} · {block.rows} 行）
                </button>
              ))}
              <button
                type="button"
                onClick={() => importWholeTable(blockChoices)}
                title="不选块,按 v1.39 行为把整个工作表按一张表解析导入"
                style={{ padding: '6px 10px', border: '1px dashed #9aa2ad', background: '#fff', color: '#5b6472', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
              >
                按整表导入
              </button>
            </div>
          </div>
        )}
        {(importTab === 'csv' || importTab === 'excel') && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? '#1f6fb2' : '#cdd6e0'}`,
              borderRadius: 8, padding: 34, textAlign: 'center',
              background: dragOver ? '#eef4fa' : '#f9fbfd',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            {pending ? (
              <>
                <div style={{ fontSize: 13.5, color: '#2c8a45', fontWeight: 600 }}>✓ {pending.name}</div>
                <div className="mono" style={{ fontSize: 12, color: '#5b6472', marginTop: 6 }}>
                  {pending.parsed
                    ? `${pending.parsed.rows.length} 行 × ${pending.parsed.colNames.length} 个数值列 · ${pending.parsed.colNames.join(' / ')}`
                    : `${pending.cats ?? 0} 个类别（帕累托）`}
                </div>
                {pending.parsed && (pending.parsed.skippedRows > 0 || pending.parsed.droppedCols > 0) && (
                  <div style={{ fontSize: 11.5, color: '#d98324', marginTop: 4 }}>
                    {pending.parsed!.skippedRows > 0 ? `跳过 ${pending.parsed!.skippedRows} 行非法值 ` : ''}
                    {pending.parsed!.droppedCols > 0 ? `保留 ${pending.parsed!.droppedCols} 个文本/分组列` : ''}
                  </div>
                )}
                <button type="button" onClick={pickFile} style={{ display: 'inline-block', marginTop: 14, padding: '8px 18px', border: '1px solid #cfd5dd', color: '#5b6472', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#fff' }}>重新选择</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13.5, color: '#5b6472', fontWeight: 500 }}>拖拽文件到此处，或点击选择文件</div>
                <div style={{ fontSize: 12, color: '#9aa2ad', marginTop: 6 }}>
                  {importTab === 'excel' ? '支持 .xlsx / .xls 工作簿（最大 20 MB，读取首个工作表，首行作为列名）' : '支持 .csv / .txt，自动识别分隔符与列名'}
                </div>
                <button type="button" onClick={pickFile} style={{ display: 'inline-block', marginTop: 14, padding: '8px 18px', border: '1px solid #1f6fb2', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>选择文件</button>
              </>
            )}
          </div>
        )}
        {importTab === 'clip' && (
          <textarea
            value={clipText}
            onChange={(e) => setClipText(e.target.value)}
            placeholder={dataKind === 'pareto'
              ? '将「类别,频数」数据粘贴到此处…\n纵向:  划伤,32↵毛刺,21↵缺料,9\n横向:  划伤,毛刺,缺料↵32,21,9\n单列原始标签也可(自动计数)'
              : '将数据粘贴到此处（支持 Tab / 逗号分隔）…\n例：\n直径1,直径2,直径3\n25.01,24.99,25.02\n24.98,25.03,25.00'}
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
                  <button type="button"
                    onClick={() => { mesStop(); showToast('MES 采集已停止 · 共 ' + model.k + ' 子组'); }}
                    style={{ padding: '8px 18px', border: '1px solid #c22f2f', background: '#c22f2f', color: '#fff', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    ■ 停止采集
                  </button>
                  <span className="mono" style={{ fontSize: 12, color: '#1f6fb2' }}>已采集 {model.k} 子组 · SPC 页实时更新</span>
                </>
              ) : (
                <>
                  <button type="button"
                    onClick={() => { mesStart(); goTo('spc'); showToast('MES 模拟采集已启动 · 控制图实时更新'); closeModal(); }}
                    style={{ padding: '8px 18px', border: '1px solid #1f6fb2', background: '#1f6fb2', color: '#fff', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    ▶ 开始模拟采集
                  </button>
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
    ['pdf', 'PDF 报告', '当前分析图文 HTML · 打开后打印即 PDF'],
    ['excel', 'Excel', '真 .xlsx · 数据 + 当前分析明细'],
    ['ppt', 'PowerPoint', '真 .pptx · 当前分析表格与图形'],
    ['word', 'Word', '真 .docx · 当前分析图文报告'],
  ];
  const doExport = async () => {
    try {
      const { lsl, tgt, usl, spcRules, spcRuleK } = useApp.getState();
      const { buildActiveAnalysisExport } = await import('../../platform/activeAnalysisReport');
      const { report: analysis, model } = buildActiveAnalysisExport();
      // v1.42.3(审计 P1):通用报告判异用「用户当前规则/K」评估一次,四种格式共用——
      // 不再让各导出器各自按 DEFAULT_RULES 只评位置图。
      const spcAssessment = assessSpcCharts(model, spcRules, spcRuleK);
      const job = await buildExportJob(exportFmt, model, { lsl, tgt, usl }, spcAssessment, analysis);
      const dest = await platform.exportFile(job);
      if (dest == null) return; // 用户取消
      sessionLog(`导出报表 ${dest}`);
      showToast(platform.isDesktop ? '报表已保存: ' + dest : '报表已导出: ' + dest);
      closeModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      sessionLog(`导出失败 · ${message}`);
      showToast(`导出失败：${message}`);
    }
  };
  return (
    <ModalFrame width={520} title="导出报表" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" onClick={doExport} style={primaryBtn}>导出</button>
      </>}>
      <div style={{ padding: '18px 20px' }}>
        <div style={{ fontSize: 12.5, color: '#8a929d', marginBottom: 10 }}>选择导出格式</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {fmts.map(([k, l, d]) => (
            <button type="button" key={k} aria-pressed={exportFmt === k} onClick={() => setExportFmt(k)}
              style={{ border: '1px solid ' + (exportFmt === k ? '#1f6fb2' : '#e2e5ea'), background: exportFmt === k ? '#f0f6fc' : '#fff', borderRadius: 6, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#26303c' }}>{l}</div>
              <div style={{ fontSize: 11.5, color: '#8a929d', marginTop: 3 }}>{d}</div>
            </button>
          ))}
        </div>
      </div>
    </ModalFrame>
  );
}

function CalcModal() {
  const { calc, pressCalc, closeModal } = useApp();
  const base: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 46, border: 0, borderRadius: 6, cursor: 'pointer', fontSize: 16, fontFamily: 'IBM Plex Mono,monospace', fontWeight: 500, userSelect: 'none' };
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
        {calc.error && <div role="alert" style={{ color: '#b33a2b', fontSize: 12, margin: '-4px 2px 10px', textAlign: 'right' }}>{calc.error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
          {btns.map(([k, t]) => (
            <button type="button" aria-label={`计算器 ${k}`} key={k} style={styleOf(t)} onClick={() => pressCalc(k)}>{k}</button>
          ))}
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------- 公式计算列 ----------
function FormulaModal() {
  const { closeModal, goTo, showToast } = useApp();
  const { model, textCols, addFormulaColumn } = useData();
  const [name, setName] = useState('公式列');
  const [expr, setExpr] = useState('');

  const columns = model.colNames.map((_, j) => model.subs.map((s) => s.vals[j]));
  const columnNumbers = worksheetNumericColumnCodes(model.n, textCols);
  const firstCode = `C${columnNumbers[0] ?? 1}`;
  const secondCode = `C${columnNumbers[1] ?? columnNumbers[0] ?? 1}`;
  // 实时预览:算前几行 + 捕获错误
  let previewVals: number[] | null = null;
  let error: string | null = null;
  if (expr.trim() !== '') {
    try {
      previewVals = evalFormula(expr, { columns, colNames: model.colNames, rowCount: model.k, columnNumbers }).values;
      const invalidRow = previewVals.findIndex((value) => !Number.isFinite(value));
      if (invalidRow >= 0) error = `第 ${invalidRow + 1} 行未得到有限数值（可能除以 0、对负数开方或数值溢出）`;
    } catch (e) {
      error = e instanceof FormulaError ? e.message : (e as Error).message;
    }
  }

  const insert = (token: string) => setExpr((s) => (s + (s && !s.endsWith(' ') ? ' ' : '') + token));

  const apply = () => {
    if (expr.trim() === '') { showToast('请先输入公式'); return; }
    const err = addFormulaColumn(name, expr);
    if (err) { showToast('无法添加：' + err); return; }
    closeModal();
    goTo('worksheet');
    showToast(`已添加公式列「${name.trim() || '公式列'}」（可 Ctrl+Z 撤销）`);
  };

  const chip: React.CSSProperties = { padding: '3px 8px', border: 0, borderRadius: 4, background: '#eef1f4', color: '#3a4350', cursor: 'pointer', fontSize: 11.5, fontFamily: 'IBM Plex Mono,monospace' };
  const fnChip: React.CSSProperties = { ...chip, background: '#f0f2f5', color: '#5b6472' };

  return (
    <ModalFrame width={540} title="公式计算列 · Calculator" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" disabled={!!error} onClick={apply} style={{ ...primaryBtn, ...(error ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>添加列</button>
      </>}>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: '#5b6472' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 56, color: '#8a929d' }}>新列名</span>
          <input value={name} onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5 }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ width: 56, color: '#8a929d', paddingTop: 7 }}>公式</span>
          <textarea value={expr} onChange={(e) => setExpr(e.target.value)} autoFocus
            placeholder={`例:(${firstCode} + ${secondCode}) / 2    或    (${firstCode} - mean(${firstCode})) / std(${firstCode})    或    sqrt(${firstCode})`}
            style={{ flex: 1, height: 60, border: `1px solid ${error ? '#d98324' : '#cfd5dd'}`, borderRadius: 6, padding: '8px 10px', fontFamily: 'IBM Plex Mono,monospace', fontSize: 13, resize: 'none', boxSizing: 'border-box' }} />
        </label>

        <div>
          <div style={{ fontSize: 11, color: '#98a1ac', marginBottom: 5 }}>点击插入列引用</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {model.colNames.map((n, i) => (
              <button type="button" key={i} style={chip} title={n} onClick={() => insert(`C${columnNumbers[i]}`)}>C{columnNumbers[i]} · {n}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#98a1ac', marginBottom: 5 }}>函数(逐元素 / 聚合)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['abs()', 'sqrt()', 'ln()', 'log10()', 'exp()', 'round()', 'sq()', 'mean()', 'std()', 'min()', 'max()', 'sum()', 'median()'].map((f) => (
              <button type="button" key={f} style={fnChip} onClick={() => insert(f)}>{f}</button>
            ))}
          </div>
        </div>

        <div style={{ borderTop: '1px solid #eef0f3', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: '#98a1ac', marginBottom: 5 }}>预览(前 {Math.min(6, model.k)} 行 / 共 {model.k} 行)</div>
          {error ? (
            <div style={{ color: '#c22f2f', fontSize: 12.5 }}>⚠ {error}</div>
          ) : previewVals ? (
            <div className="mono" style={{ fontSize: 12.5, color: '#1c4e7a' }}>
              {previewVals.slice(0, 6).map((v) => Number(v.toFixed(4))).join('   ')}
              {model.k > 6 ? '   …' : ''}
            </div>
          ) : (
            <div style={{ color: '#9aa2ad', fontSize: 12.5 }}>输入公式后在此实时预览计算结果。支持 + − × ÷ ^、括号、工作表顶部 C# 数值列引用与列名。</div>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------- 数据集库(本机 SQLite,仅桌面端) ----------
function VaultModal() {
  const { closeModal, goTo, showToast } = useApp();
  const loadRecent = useData((s) => s.loadRecent);
  const db = platform.datasetDb;
  const [list, setList] = useState<Array<{ name: string; saved_at: string; bytes: number }>>([]);
  const [stats, setStats] = useState<{ count: number; total_bytes: number; path: string } | null>(null);
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);

  const refresh = () => {
    if (!db) return;
    db.list().then(setList).catch(() => {});
    db.stats().then(setStats).catch(() => {});
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtKB = (b: number) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  return (
    <ModalFrame width={560} title="数据集库(本机)" onClose={closeModal}
      footer={<button type="button" onClick={closeModal} style={primaryBtn}>关闭</button>}>
      <div style={{ padding: '16px 20px', fontSize: 12.5, color: '#5b6472' }}>
        {!db ? (
          <div style={{ padding: '18px 4px', lineHeight: 1.8 }}>
            数据集库由桌面版内置的 SQLite 提供,容量不受浏览器 localStorage(约 5MB)限制。
            <br />当前为 Web 端,此功能不可用——请使用桌面安装版(.exe / .msi / .dmg)。
            <br /><span style={{ color: '#9aa2ad', fontSize: 12 }}>Web 端数据仍通过「最近数据集」与 .qproj 项目文件持久化。</span>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: '#8a929d', marginBottom: 10 }}>
              每次导入或编辑的数据集都自动归档到本机 SQLite,不占浏览器存储配额;即使从「最近列表」移除也可在此找回。
              {stats && <span> · 共 <b>{stats.count}</b> 个数据集 / {fmtKB(stats.total_bytes)}</span>}
            </div>
            {list.length === 0 ? (
              <div style={{ padding: '16px 4px', color: '#9aa2ad' }}>库内暂无数据集——导入或编辑任意数据集后会自动归档到这里。</div>
            ) : (
              <div style={{ border: '1px solid #eaeef2', borderRadius: 6, overflow: 'hidden', maxHeight: 300, overflowY: 'auto' }}>
                {list.map((d, i) => (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: i < list.length - 1 ? '1px solid #f2f4f6' : undefined }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#2b3440', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                      <div className="mono" style={{ fontSize: 11, color: '#98a1ac' }}>{new Date(d.saved_at).toLocaleString('zh-CN')} · {fmtKB(d.bytes)}</div>
                    </div>
                    <button type="button"
                      className="hov-act"
                      onClick={async () => {
                        const loaded = await loadRecent(d.name);
                        if (loaded) {
                          closeModal();
                          goTo('worksheet');
                          showToast('已从数据集库加载 ' + d.name);
                        } else {
                          showToast('数据集加载失败或已被更新的加载请求取代：' + d.name);
                        }
                      }}
                      style={{ padding: '5px 12px', border: '1px solid #1f6fb2', background: '#fff', color: '#1f6fb2', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, flex: 'none' }}
                    >
                      加载
                    </button>
                    <button type="button"
                      className="hov-act"
                      onClick={async () => {
                        if (useData.getState().model.name === d.name) {
                          showToast(`不能删除当前活动数据集「${d.name}」；请先切换数据集或导出项目`);
                          return;
                        }
                        let activeRef: string | null = null;
                        try { activeRef = localStorage.getItem('qp-active-ref-v1'); } catch { /* 忽略 */ }
                        if (activeRef === d.name) {
                          showToast(`不能删除活动数据集「${d.name}」：它仅存在于本机库；请先另存/导出项目`);
                          return;
                        }
                        if (deleteArmed !== d.name) {
                          setDeleteArmed(d.name);
                          showToast(`再次点击“确认删除”才会移除「${d.name}」`);
                          return;
                        }
                        try {
                          await prepareVaultDatasetRemoval(d.name);
                          const removed = await db.remove(d.name);
                          if (!removed) throw new Error('数据集不存在或未能删除');
                          setDeleteArmed(null);
                          refresh();
                          showToast('已从数据集库删除 ' + d.name);
                        } catch (error) {
                          showToast(`删除失败：${(error as Error).message}`);
                        }
                      }}
                      style={{ padding: '5px 12px', border: '1px solid #cfd5dd', background: '#fff', color: '#c22f2f', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, flex: 'none' }}
                    >
                      {deleteArmed === d.name ? '确认删除' : '删除'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {stats && <div className="mono" style={{ fontSize: 10.5, color: '#b3bac2', marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={stats.path}>库文件:{stats.path}</div>}
          </>
        )}
      </div>
    </ModalFrame>
  );
}

// ---------- 查找 / 替换 ----------
function FindReplaceModal() {
  const { closeModal, goTo, showToast } = useApp();
  const { model, findReplace } = useData();
  const [findS, setFindS] = useState('');
  const [replS, setReplS] = useState('');
  const [col, setCol] = useState(-1);

  const findV = parseFloat(findS);
  const replV = parseFloat(replS);
  const canFind = Number.isFinite(findV);
  const matches = canFind ? findReplace(findV, null, col) : null;
  const canApply = canFind && Number.isFinite(replV) && (matches ?? 0) > 0;

  const apply = () => {
    if (!canApply) return;
    const n = findReplace(findV, replV, col);
    closeModal();
    goTo('worksheet');
    showToast(`已替换 ${n} 处 ${findV} → ${replV}(可 Ctrl+Z 撤销)`);
  };

  const inp: React.CSSProperties = { width: 120, padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5, fontFamily: 'IBM Plex Mono,monospace', textAlign: 'right' };
  return (
    <ModalFrame width={420} title="查找 / 替换 · 测量值" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" disabled={!canApply} onClick={apply} style={{ ...primaryBtn, ...(canApply ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}>全部替换</button>
      </>}>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 13, fontSize: 12.5, color: '#5b6472' }}>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          查找数值
          <input autoFocus type="number" step="any" value={findS} onChange={(e) => setFindS(e.target.value)} placeholder="如 25.037" style={inp} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          替换为
          <input type="number" step="any" value={replS} onChange={(e) => setReplS(e.target.value)} placeholder="如 25.000" style={inp} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          范围
          <select value={col} onChange={(e) => setCol(+e.target.value)} style={{ padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5 }}>
            <option value={-1}>全部测量列</option>
            {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </label>
        <div style={{ borderTop: '1px solid #eef0f3', paddingTop: 10, fontSize: 12.5 }}>
          {matches == null
            ? <span style={{ color: '#9aa2ad' }}>输入查找数值后实时显示命中数。匹配按 3 位小数四舍五入的容差判定(与单元格显示位数无关)。</span>
            : matches === 0
              ? <span style={{ color: '#d98324' }}>没有匹配的测量值</span>
              : <span style={{ color: '#1c4e7a' }}>命中 <b className="mono">{matches}</b> 处,替换后可 Ctrl+Z 撤销</span>}
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------- 数据子集 / 条件筛选 ----------
function SubsetModal() {
  const { closeModal, goTo, showToast } = useApp();
  const { model, textCols, subsetByCondition } = useData();
  const [cond, setCond] = useState('');

  const columns = model.colNames.map((_, j) => model.subs.map((s) => s.vals[j]));
  const columnNumbers = worksheetNumericColumnCodes(model.n, textCols);
  const firstCode = `C${columnNumbers[0] ?? 1}`;
  const secondCode = `C${columnNumbers[1] ?? columnNumbers[0] ?? 1}`;
  let kept: number | null = null;
  let error: string | null = null;
  if (cond.trim() !== '') {
    try {
      const flags = evalFormula(cond, { columns, colNames: model.colNames, rowCount: model.k, columnNumbers }).values;
      kept = flags.filter(truthy).length;
    } catch (e) {
      error = e instanceof FormulaError ? e.message : (e as Error).message;
    }
  }

  const insert = (token: string) => setCond((s) => (s + (s && !s.endsWith(' ') ? ' ' : '') + token));

  const apply = () => {
    if (cond.trim() === '') { showToast('请先输入筛选条件'); return; }
    const r = subsetByCondition(cond);
    if (!r.ok) { showToast('无法筛选：' + r.error); return; }
    closeModal();
    goTo('worksheet');
    showToast(`已生成子集「${r.name}」· 保留 ${r.kept}/${r.total} 行`);
  };

  const chip: React.CSSProperties = { padding: '3px 8px', border: 0, borderRadius: 4, background: '#eef1f4', color: '#3a4350', cursor: 'pointer', fontSize: 11.5, fontFamily: 'IBM Plex Mono,monospace' };
  const opChip: React.CSSProperties = { ...chip, background: '#f0f2f5', color: '#5b6472' };
  const canApply = !error && kept != null && kept >= 2 && kept < model.k;

  return (
    <ModalFrame width={540} title="子集 / 条件筛选 · Subset" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" disabled={!canApply} onClick={apply} style={{ ...primaryBtn, ...(canApply ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}>生成子集</button>
      </>}>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: '#5b6472' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ width: 40, color: '#8a929d', paddingTop: 7 }}>条件</span>
          <textarea value={cond} onChange={(e) => setCond(e.target.value)} autoFocus
            placeholder={`例:${firstCode} > 25    或    ${firstCode} >= 24.9 and ${firstCode} <= 25.1    或    not (${secondCode} = 0)`}
            style={{ flex: 1, height: 56, border: `1px solid ${error ? '#d98324' : '#cfd5dd'}`, borderRadius: 6, padding: '8px 10px', fontFamily: 'IBM Plex Mono,monospace', fontSize: 13, resize: 'none', boxSizing: 'border-box' }} />
        </label>

        <div>
          <div style={{ fontSize: 11, color: '#98a1ac', marginBottom: 5 }}>点击插入列引用</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {model.colNames.map((n, i) => (
              <button type="button" key={i} style={chip} title={n} onClick={() => insert(`C${columnNumbers[i]}`)}>C{columnNumbers[i]} · {n}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#98a1ac', marginBottom: 5 }}>比较 / 逻辑运算符</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['>', '<', '>=', '<=', '==', '<>', 'and', 'or', 'not'].map((o) => (
              <button type="button" key={o} style={opChip} onClick={() => insert(o)}>{o}</button>
            ))}
          </div>
        </div>

        <div style={{ borderTop: '1px solid #eef0f3', paddingTop: 10 }}>
          {error ? (
            <div style={{ color: '#c22f2f', fontSize: 12.5 }}>⚠ {error}</div>
          ) : kept != null ? (
            <div style={{ fontSize: 12.5, color: kept >= 2 && kept < model.k ? '#1c4e7a' : '#d98324' }}>
              满足条件:<b className="mono">{kept}</b> / {model.k} 行
              {kept === model.k ? ' · 未筛除任何行' : kept < 2 ? ' · 不足 2 行,无法生成' : ` · 将生成含 ${kept} 行的新数据集`}
            </div>
          ) : (
            <div style={{ color: '#9aa2ad', fontSize: 12.5 }}>输入条件后实时显示命中行数。条件为真的行将保留到新数据集「… (子集)」,原数据集不变。</div>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}

function AboutModal() {
  const { closeModal } = useApp();
  return (
    <ModalFrame width={460} title="关于本软件" onClose={closeModal}
      footer={<button type="button" onClick={closeModal} style={primaryBtn}>确定</button>}>
      <div style={{ padding: '22px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <span style={{ width: 40, height: 40, borderRadius: 9, background: '#1f6fb2', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700 }}>质</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#26303c' }}>质量分析平台</div>
            <div style={{ fontSize: 12, color: '#8a929d' }}>Quality Analytics Platform · v{__APP_VERSION__}</div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: '#5b6472', lineHeight: 1.7 }}>
          面向工厂质量部门的统计分析工具，涵盖 SPC 控制图、过程能力、测量系统分析、方差分析、实验设计与抽样检验。所有统计量均为实时计算。
        </div>
      </div>
    </ModalFrame>
  );
}

// ---------- 排序 ----------
function SortModal() {
  const { closeModal, goTo, showToast } = useApp();
  const { model, sortBy } = useData();
  const [col, setCol] = useState(0);
  const [asc, setAsc] = useState(true);
  const apply = () => {
    sortBy(col, asc);
    closeModal();
    goTo('worksheet');
    showToast(`已按「${model.colNames[col]}」${asc ? '升序' : '降序'}排序（可 Ctrl+Z 撤销）`);
  };
  const sel: React.CSSProperties = { padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5, fontFamily: 'IBM Plex Mono,monospace' };
  return (
    <ModalFrame width={380} title="按列排序" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" onClick={apply} style={primaryBtn}>排序</button>
      </>}>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12.5, color: '#5b6472' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          排序列
          <select style={sel} value={col} onChange={(e) => setCol(+e.target.value)}>
            {model.colNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 16 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="radio" checked={asc} onChange={() => setAsc(true)} /> 升序
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="radio" checked={!asc} onChange={() => setAsc(false)} /> 降序
          </label>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa2ad' }}>行整体重排,分组文本列同步;时间序列类分析(SPC)将失去原始顺序,可撤销。</div>
      </div>
    </ModalFrame>
  );
}

// ---------- 列统计 ----------
function ColStatsModal() {
  const { closeModal } = useApp();
  const { model } = useData();
  const rows = model.colNames.map((name, j) => {
    const v = model.subs.map((s) => s.vals[j]);
    const mu = mean(v);
    const sd = stdev(v);
    const mn = arrMin(v);
    const mx = arrMax(v);
    return { name, n: v.length, mu, sd, mn, mx, range: mx - mn };
  });
  const td: React.CSSProperties = { padding: '7px 10px', borderTop: '1px solid #f0f2f5', textAlign: 'right', fontFamily: 'IBM Plex Mono,monospace', color: '#2a333f' };
  return (
    <ModalFrame width={560} title={`列统计 · ${model.name}`} onClose={closeModal}
      footer={<button type="button" onClick={closeModal} style={primaryBtn}>关闭</button>}>
      <div style={{ padding: '10px 8px', maxHeight: 320, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#98a1ac', textAlign: 'right' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600 }}>列</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>N</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>均值</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>标准差</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>最小</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>最大</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>极差</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td style={{ ...td, textAlign: 'left', fontFamily: 'IBM Plex Sans', color: '#33404f', fontWeight: 500 }}>{r.name}</td>
                <td style={td}>{r.n}</td>
                <td style={td}>{r.mu.toFixed(4)}</td>
                <td style={td}>{r.sd.toFixed(4)}</td>
                <td style={td}>{r.mn.toFixed(3)}</td>
                <td style={td}>{r.mx.toFixed(3)}</td>
                <td style={td}>{r.range.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ModalFrame>
  );
}

// ---------- 生成随机数据 ----------
function RandomModal() {
  const { closeModal, goTo, showToast } = useApp();
  const generateRandom = useData((s) => s.generateRandom);
  const [mu, setMu] = useState(25);
  const [sigma, setSigma] = useState(0.03);
  const [k, setK] = useState(25);
  const [n, setN] = useState(5);
  const apply = () => {
    if (sigma <= 0 || k < 2 || k > 100000 || n < 1 || n > 10) {
      showToast('参数无效：σ>0,子组数 2–100000,子组大小 1–10');
      return;
    }
    const name = generateRandom(mu, sigma, k, n);
    closeModal();
    goTo('worksheet');
    showToast(`已生成 ${name} · ${k} 子组 × ${n}`);
  };
  const inp: React.CSSProperties = { width: 90, padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4, fontSize: 12.5, fontFamily: 'IBM Plex Mono,monospace', textAlign: 'right' };
  const fields: Array<[string, number, (v: number) => void, number]> = [
    ['均值 μ', mu, setMu, 0.001],
    ['标准差 σ', sigma, setSigma, 0.001],
    ['子组数 k', k, setK, 1],
    ['子组大小 n', n, setN, 1],
  ];
  return (
    <ModalFrame width={380} title="生成正态随机数据" onClose={closeModal}
      footer={<>
        <button type="button" onClick={closeModal} style={cancelBtn}>取消</button>
        <button type="button" onClick={apply} style={primaryBtn}>生成</button>
      </>}>
      <div style={{ padding: '18px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12.5, color: '#5b6472' }}>
        {fields.map(([label, val, set, step]) => (
          <label key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {label}
            <input type="number" step={step} value={val} style={inp}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) set(v); }} />
          </label>
        ))}
        <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: '#9aa2ad' }}>
          生成 X ~ N(μ, σ²) 的 k×n 子组矩阵并设为活动数据集,适合练习控制图与能力分析。
        </div>
      </div>
    </ModalFrame>
  );
}

export function Modals() {
  const { modal, closeModal } = useApp();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!modal) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (useApp.getState().busyOverlay) return; // P0-3:导入事务期间禁止关闭
      if (event.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [modal, closeModal]);

  useEffect(() => {
    if (!modal) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]');
      (preferred ?? focusableElements(dialog)[0] ?? dialog).focus();
    }
    return () => {
      const previous = returnFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, [modal]);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!modal) return null;
  const modalLabel: Record<Exclude<typeof modal, null>, string> = {
    import: '导入数据', export: '导出报表', calc: '计算器', formula: '公式计算列', subset: '条件筛选',
    vault: '本机数据集库', findreplace: '查找替换', about: '关于本软件', help: '帮助主题', options: '选项与本地数据',
    sort: '排序', colstats: '列统计', random: '生成正态随机数据',
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(20,28,40,0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <button type="button" tabIndex={-1} aria-label="关闭弹窗" onClick={closeModal} style={{ position: 'absolute', inset: 0, border: 0, padding: 0, background: 'transparent', cursor: 'default' }} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={modalLabel[modal]} tabIndex={-1} onKeyDown={trapFocus} style={{ position: 'relative' }}>
        {modal === 'import' && <ImportModal />}
        {modal === 'export' && <ExportModal />}
        {modal === 'calc' && <CalcModal />}
        {modal === 'formula' && <FormulaModal />}
        {modal === 'subset' && <SubsetModal />}
        {modal === 'vault' && <VaultModal />}
        {modal === 'findreplace' && <FindReplaceModal />}
        {modal === 'about' && <AboutModal />}
        {modal === 'help' && <HelpModal onClose={closeModal} />}
        {modal === 'options' && <OptionsModal onClose={closeModal} />}
        {modal === 'sort' && <SortModal />}
        {modal === 'colstats' && <ColStatsModal />}
        {modal === 'random' && <RandomModal />}
      </div>
    </div>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  const isError = /(失败|错误|损坏|无法|未能|不完整|异常|拒绝|不可用|不足|超限)/.test(toast);
  return (
    <div role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'} aria-atomic="true" style={{ position: 'fixed', bottom: 40, right: 26, zIndex: 400, background: '#26303c', color: '#fff', padding: '12px 18px', borderRadius: 8, boxShadow: '0 12px 30px rgba(10,20,40,0.3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: isError ? '#e25555' : '#43c46e' }} />
      {toast}
    </div>
  );
}
