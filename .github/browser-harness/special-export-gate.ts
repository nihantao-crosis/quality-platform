import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { computeVarModel } from '../../src/core';
import { platform, type ExportJob } from '../../src/platform/adapter';
import { useApp } from '../../src/store/appStore';
import { useData } from '../../src/store/dataStore';
import { Modals } from '../../src/ui/shell/Modals';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 真 Chrome：大表专项状态 → 真实导出按钮 → 格式产物，不绕过 ExportModal。 */
export async function runSpecialExportGate() {
  const total = 20_002;
  const model = computeVarModel('专项导出验收', ['Dose', 'Y'],
    Array.from({ length: total }, (_, i) => [i % 2, 10 + (i % 17) / 10 + (i % 2) * 4]));
  useData.setState({ model, textCols: [{ name: '设备', values: Array.from({ length: total }, (_, i) => i % 2 ? 'B' : 'A') }], pendingCells: [] });
  useApp.setState({ page: 'anova', anovaMode: 'stacked', anovaFactorName: 'Dose', anovaRespName: 'Y', busyOverlay: null });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const originalExport = platform.exportFile;
  const results: Array<{ format: string; bytes: number; images: number }> = [];
  try {
    flushSync(() => root.render(createElement(Modals)));
    for (const format of ['pdf', 'excel', 'word', 'ppt'] as const) {
      let accept!: (job: ExportJob) => void;
      const jobReady = new Promise<ExportJob>((resolve) => { accept = resolve; });
      platform.exportFile = async (job) => { accept(job); return null; };
      flushSync(() => useApp.setState({ modal: 'export', exportFmt: format }));
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '导出');
      check(button && !button.disabled, `${format}: 未找到可用的真实导出按钮`);
      button.click();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const job = await Promise.race([
        jobReady,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${format}: 专项导出超时`)), 45_000); }),
      ]).finally(() => clearTimeout(timeout));
      const expectedExtension = { pdf: 'html', excel: 'xlsx', word: 'docx', ppt: 'pptx' }[format];
      check(job.ext === expectedExtension, `${format}: 实际文件类型 ${job.ext} 不符`);
      let text = job.text ?? '';
      let images = 0;
      if (format === 'excel') {
        check(job.bytes, 'Excel: 缺少文件字节');
        const container = await JSZip.loadAsync(job.bytes);
        check(container.file('xl/workbook.xml'), 'Excel: 不是实际 XLSX 工作簿');
        const book = XLSX.read(job.bytes, { type: 'array' });
        text = book.SheetNames.map((name) => XLSX.utils.sheet_to_csv(book.Sheets[name])).join('\n');
      } else if (format === 'word' || format === 'ppt') {
        check(job.bytes, `${format}: 缺少文件字节`);
        const zip = await JSZip.loadAsync(job.bytes);
        const documents = Object.keys(zip.files).filter((name) => format === 'word'
          ? name === 'word/document.xml' : /^ppt\/slides\/slide\d+\.xml$/.test(name));
        text = (await Promise.all(documents.map((name) => zip.file(name)!.async('string')))).join('\n');
        const mediaNames = Object.keys(zip.files).filter((name) => /^(word|ppt)\/media\/.*\.png$/.test(name));
        const relationNames = Object.keys(zip.files).filter((name) => format === 'word'
          ? name === 'word/_rels/document.xml.rels' : /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name));
        const relationships = (await Promise.all(relationNames.map((name) => zip.file(name)!.async('string')))).join('\n');
        images = mediaNames.length;
        check(images === 3, `${format}: ANOVA 应包含 3 张专项图，实际 ${images}`);
        check((text.match(/<a:blip\b/g) ?? []).length === 3, `${format}: 图形引用不完整`);
        check((relationships.match(/relationships\/image/g) ?? []).length === 3, `${format}: 图片关系不完整`);
        // 不仅数图片：逐个证明正文 r:embed 能解析到真实的媒体 ZIP 条目。
        const parser = new DOMParser();
        for (const documentName of documents) {
          const slash = documentName.lastIndexOf('/');
          const directory = documentName.slice(0, slash + 1);
          const relationsName = `${directory}_rels/${documentName.slice(slash + 1)}.rels`;
          const documentXml = parser.parseFromString(await zip.file(documentName)!.async('string'), 'application/xml');
          const blips = [...documentXml.getElementsByTagNameNS('*', 'blip')];
          if (!blips.length) continue;
          const relationFile = zip.file(relationsName);
          check(relationFile, `${documentName}: 缺少关系文件`);
          const relationXml = parser.parseFromString(await relationFile.async('string'), 'application/xml');
          const relations = [...relationXml.getElementsByTagNameNS('*', 'Relationship')];
          for (const blip of blips) {
            const id = blip.getAttribute('r:embed');
            const relation = relations.find((item) => item.getAttribute('Id') === id);
            check(relation && relation.getAttribute('Type')?.endsWith('/image'), `${documentName}: ${id} 没有图片关系`);
            const target = relation.getAttribute('Target');
            check(target && relation.getAttribute('TargetMode') !== 'External', `${documentName}: 媒体必须内嵌`);
            const mediaPath = new URL(target, `https://artifact.invalid/${directory}`).pathname.slice(1);
            check(mediaNames.includes(mediaPath) && zip.file(mediaPath), `${documentName}: ${id} 指向缺失图片 ${mediaPath}`);
          }
        }
        for (const name of mediaNames) {
          const bytes = await zip.file(name)!.async('uint8array');
          const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: 'image/png' }));
          try {
            check(bitmap.width === 1920 && [640, 560].includes(bitmap.height), `${name}: 专项栅格尺寸不符`);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            check(context, `${name}: Canvas 不可用`);
            context.drawImage(bitmap, 0, 0);
            const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let visible = 0;
            for (let offset = 0; offset < rgba.length; offset += 4) {
              if (rgba[offset + 3] > 240 && Math.min(rgba[offset], rgba[offset + 1], rgba[offset + 2]) < 220) visible++;
            }
            check(visible > 1000, `${name}: 图像内容为空或异常稀少`);
          } finally { bitmap.close(); }
        }
      }
      check(text.includes('方差分析') && text.includes('设备'), `${format}: 丢失专项类型或实际因子标签`);
      check(!text.includes('Y vs Dose'), `${format}: 使用了失效的因子名称`);
      check(text.includes(`表格共 ${total} 行`), `${format}: 丢失原始总行数`);
      check(text.includes('仅列前'), `${format}: 缺少明细截断说明`);
      results.push({ format: job.ext, bytes: job.bytes?.byteLength ?? new TextEncoder().encode(job.text).length, images });
      flushSync(() => useApp.setState({ modal: null }));
    }
    return { observations: total, formats: results };
  } finally {
    platform.exportFile = originalExport;
    flushSync(() => root.unmount());
    host.remove();
  }
}
