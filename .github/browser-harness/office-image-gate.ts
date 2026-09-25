import JSZip from 'jszip';
import { assessSpcCharts, buildData, computeVarModel, DEFAULT_RULE_K } from '../../src/core';
import { buildExportJob } from '../../src/platform/report';
import { DEFAULT_SPC_RULES } from '../../src/store/appStore';
import { runSpecialExportGate } from './special-export-gate';

type RasterMetrics = {
  name: string;
  width: number;
  height: number;
  nonWhitePixels: number;
  colorBuckets: number;
  chromaticBuckets: number;
};

type GateResult = {
  status: 'passed' | 'failed';
  message?: string;
  stack?: string;
  word?: { media: number; blips: number; imageRelationships: number; metrics: RasterMetrics[] };
  ppt?: { media: number; blips: number; imageRelationships: number; metrics: RasterMetrics[] };
  special?: Awaited<ReturnType<typeof runSpecialExportGate>>;
};

declare global {
  interface Window { __RELEASE_GATE_RESULT__?: GateResult }
}

function assertGate(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function relationshipTargets(xml: string): string[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"/g)].map((match) => match[1]);
}

async function rasterMetrics(bytes: Uint8Array, name: string): Promise<RasterMetrics> {
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/png' }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    assertGate(context, `${name}: 无法取得真实 Canvas 2D 上下文`);
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhitePixels = 0;
    const colors = new Set<number>();
    const chromatic = new Set<number>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha < 240 || (red >= 248 && green >= 248 && blue >= 248)) continue;
      nonWhitePixels += 1;
      const bucket = (red >> 5) << 6 | (green >> 5) << 3 | (blue >> 5);
      colors.add(bucket);
      if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 24) chromatic.add(bucket);
    }
    return {
      name,
      width: bitmap.width,
      height: bitmap.height,
      nonWhitePixels,
      colorBuckets: colors.size,
      chromaticBuckets: chromatic.size,
    };
  } finally {
    bitmap.close();
  }
}

async function mediaMetrics(zip: JSZip, prefix: string): Promise<RasterMetrics[]> {
  const names = Object.keys(zip.files).filter((name) => name.startsWith(prefix) && /\.png$/i.test(name));
  assertGate(names.length >= 4, `${prefix}: 应至少包含 4 张真实 PNG，实际 ${names.length}`);
  return Promise.all(names.map(async (name) => {
    const entry = zip.file(name);
    assertGate(entry, `${name}: ZIP 媒体项缺失`);
    const metrics = await rasterMetrics(await entry.async('uint8array'), name);
    assertGate(metrics.width === 1920, `${name}: 栅格宽度应为 1920，实际 ${metrics.width}`);
    assertGate([500, 560, 600].includes(metrics.height), `${name}: 非预期栅格高度 ${metrics.height}`);
    assertGate(metrics.nonWhitePixels >= 1_000, `${name}: 非白像素过少 (${metrics.nonWhitePixels})`);
    assertGate(metrics.colorBuckets >= 4, `${name}: 色阶不足 (${metrics.colorBuckets})`);
    assertGate(metrics.chromaticBuckets >= 2, `${name}: 缺少多色图形像素 (${metrics.chromaticBuckets})`);
    return metrics;
  }));
}

function assertExpectedChartSizes(metrics: RasterMetrics[], label: string) {
  const heights = metrics.map((item) => item.height);
  assertGate(heights.filter((height) => height === 500).length >= 2, `${label}: 缺少位置图/离散图尺寸`);
  assertGate(heights.includes(560), `${label}: 缺少概率图尺寸`);
  assertGate(heights.includes(600), `${label}: 缺少直方图尺寸`);
}

async function runGate(): Promise<GateResult> {
  const data = buildData();
  const model = computeVarModel(
    'release-office-browser-gate.mtw',
    ['直径1', '直径2', '直径3', '直径4', '直径5'],
    data.subs.map((subgroup) => subgroup.vals),
  );
  const spec = { lsl: 24.9, tgt: 25, usl: 25.1 };
  const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');
  const [wordJob, pptJob] = await Promise.all([
    buildExportJob('word', model, spec, assessment),
    buildExportJob('ppt', model, spec, assessment),
  ]);
  assertGate(wordJob.ext === 'docx' && wordJob.bytes, 'Word 构建未返回 DOCX 字节');
  assertGate(pptJob.ext === 'pptx' && pptJob.bytes, 'PPT 构建未返回 PPTX 字节');

  const [word, ppt] = await Promise.all([JSZip.loadAsync(wordJob.bytes), JSZip.loadAsync(pptJob.bytes)]);
  const [wordMetrics, pptMetrics] = await Promise.all([
    mediaMetrics(word, 'word/media/'),
    mediaMetrics(ppt, 'ppt/media/'),
  ]);
  assertExpectedChartSizes(wordMetrics, 'Word');
  assertExpectedChartSizes(pptMetrics, 'PPT');

  const wordDocumentEntry = word.file('word/document.xml');
  const wordRelationshipsEntry = word.file('word/_rels/document.xml.rels');
  assertGate(wordDocumentEntry && wordRelationshipsEntry, 'Word OOXML 主文档或关系文件缺失');
  const [wordDocument, wordRelationships] = await Promise.all([
    wordDocumentEntry.async('string'), wordRelationshipsEntry.async('string'),
  ]);
  const wordBlips = (wordDocument.match(/<a:blip\b/g) ?? []).length;
  const wordTargets = relationshipTargets(wordRelationships).filter((target) => target.includes('media/'));
  assertGate(wordBlips === 4, `Word 应引用 4 张图，实际 ${wordBlips}`);
  assertGate(wordTargets.length >= 4, `Word 图片关系不足，实际 ${wordTargets.length}`);
  assertGate(wordRelationships.includes('/relationships/image'), 'Word 缺少 image relationship 类型');

  const slideNames = Object.keys(ppt.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slideRelationshipNames = Object.keys(ppt.files)
    .filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name));
  const [slideXmlParts, slideRelationshipParts] = await Promise.all([
    Promise.all(slideNames.map(async (name) => ppt.file(name)!.async('string'))),
    Promise.all(slideRelationshipNames.map(async (name) => ppt.file(name)!.async('string'))),
  ]);
  const slideXml = slideXmlParts.join('\n');
  const slideRelationships = slideRelationshipParts.join('\n');
  const pptBlips = (slideXml.match(/<a:blip\b/g) ?? []).length;
  const pptTargets = relationshipTargets(slideRelationships).filter((target) => target.includes('../media/'));
  assertGate(pptBlips === 4, `PPT 应引用 4 张图，实际 ${pptBlips}`);
  assertGate(pptTargets.length >= 4, `PPT 图片关系不足，实际 ${pptTargets.length}`);
  assertGate(slideRelationships.includes('/relationships/image'), 'PPT 缺少 image relationship 类型');

  return {
    status: 'passed',
    word: { media: wordMetrics.length, blips: wordBlips, imageRelationships: wordTargets.length, metrics: wordMetrics },
    ppt: { media: pptMetrics.length, blips: pptBlips, imageRelationships: pptTargets.length, metrics: pptMetrics },
    special: await runSpecialExportGate(),
  };
}

const status = document.getElementById('gate-status');
void runGate().then((result) => {
  window.__RELEASE_GATE_RESULT__ = result;
  document.documentElement.dataset.releaseGate = 'passed';
  if (status) status.textContent = JSON.stringify(result);
}).catch((error: unknown) => {
  const result: GateResult = {
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  window.__RELEASE_GATE_RESULT__ = result;
  document.documentElement.dataset.releaseGate = 'failed';
  if (status) status.textContent = JSON.stringify(result);
});
