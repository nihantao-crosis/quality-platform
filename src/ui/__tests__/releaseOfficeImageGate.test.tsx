/**
 * @vitest-environment jsdom
 * OOXML 单元门禁：真实 buildExportJob 必须把 PNG 媒体关系写进 Word/PPT。
 * SVG 的真实浏览器栅格尺寸/像素门禁由 .github/browser-harness 独立覆盖；本文件只用
 * 确定性的 16×16 双色 PNG 隔离验证 OOXML wiring，不再以 1×1 mock 冒充图像质量证据。
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessSpcCharts, buildData, computeVarModel, DEFAULT_RULE_K } from '../../core';
import { DEFAULT_SPC_RULES } from '../../store/appStore';
import { buildExportJob } from '../../platform/report';

const RELATIONSHIP_FIXTURE_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR42mOQTLn0HxnfkTNCwYTkGYaBAaRqQJcfDgaMpoPRdADEAETmPJ/7/skvAAAAAElFTkSuQmCC',
  'base64',
));

class LoadedImage {
  onload: ((this: GlobalEventHandlers, event: Event) => unknown) | null = null;
  onerror: OnErrorEventHandler = null;
  private value = '';

  set src(value: string) {
    this.value = value;
    queueMicrotask(() => this.onload?.call(this as unknown as GlobalEventHandlers, new Event('load')));
  }

  get src(): string { return this.value; }
}

const data = buildData();
const model = computeVarModel(
  'release-office-gate.mtw',
  ['直径1', '直径2', '直径3', '直径4', '直径5'],
  data.subs.map((subgroup) => subgroup.vals),
);
const spec = { lsl: 24.9, tgt: 25, usl: 25.1 };
const assessment = assessSpcCharts(model, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'xbar-r');

function relationshipTargets(xml: string): string[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"/g)].map((match) => match[1]);
}

async function nonEmptyPngMedia(zip: JSZip, prefix: string): Promise<string[]> {
  const names = Object.keys(zip.files).filter((name) => name.startsWith(prefix) && /\.png$/i.test(name));
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const bytes = await zip.file(name)!.async('uint8array');
    expect(bytes.byteLength, name).toBeGreaterThan(24);
    expect(Array.from(bytes.slice(0, 8)), name).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(header.getUint32(16), `${name} width`).toBe(16);
    expect(header.getUint32(20), `${name} height`).toBe(16);
  }
  return names;
}

describe('release Office SVG→PNG gate', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', LoadedImage);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, writable: true, value: vi.fn(() => 'blob:release-office-gate'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, writable: true, value: vi.fn(() => undefined),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([RELATIONSHIP_FIXTURE_PNG], { type: 'image/png' }));
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('buildExportJob embeds non-empty PNG media and image relationships without fallback placeholders', async () => {
    const [wordJob, pptJob] = await Promise.all([
      buildExportJob('word', model, spec, assessment),
      buildExportJob('ppt', model, spec, assessment),
    ]);
    expect(wordJob.ext).toBe('docx');
    expect(pptJob.ext).toBe('pptx');
    expect(wordJob.bytes?.byteLength).toBeGreaterThan(0);
    expect(pptJob.bytes?.byteLength).toBeGreaterThan(0);

    const [word, ppt] = await Promise.all([
      JSZip.loadAsync(wordJob.bytes!),
      JSZip.loadAsync(pptJob.bytes!),
    ]);
    const wordMedia = await nonEmptyPngMedia(word, 'word/media/');
    const pptMedia = await nonEmptyPngMedia(ppt, 'ppt/media/');
    // OOXML writers may deduplicate four byte-identical fixture images to one media part.
    expect(wordMedia.length).toBeGreaterThan(0);
    expect(pptMedia.length).toBeGreaterThan(0);

    const wordDocument = await word.file('word/document.xml')!.async('string');
    const wordRelationships = await word.file('word/_rels/document.xml.rels')!.async('string');
    const wordTargets = relationshipTargets(wordRelationships).filter((target) => target.includes('media/'));
    expect(wordTargets.length).toBeGreaterThan(0);
    expect((wordDocument.match(/<a:blip\b/g) ?? [])).toHaveLength(4);
    expect(wordRelationships).toContain('/relationships/image');
    expect(wordDocument).not.toContain('图表位图生成失败');

    const slideNames = Object.keys(ppt.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => ppt.file(name)!.async('string')))).join('\n');
    const slideRelationshipNames = Object.keys(ppt.files)
      .filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name));
    const slideRelationships = (await Promise.all(
      slideRelationshipNames.map((name) => ppt.file(name)!.async('string')),
    )).join('\n');
    const pptTargets = relationshipTargets(slideRelationships).filter((target) => target.includes('../media/'));
    expect(pptTargets.length).toBeGreaterThan(0);
    expect((slideXml.match(/<a:blip\b/g) ?? [])).toHaveLength(4);
    expect(slideRelationships).toContain('/relationships/image');
    expect(slideXml).not.toContain('图表生成失败，请导出“图文报告”查看完整图形');
  }, 30_000);
});
