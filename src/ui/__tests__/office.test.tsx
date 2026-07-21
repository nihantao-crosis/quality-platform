/**
 * Office 导出测试 — node 环境无 canvas,验证无图降级路径产出合法 OOXML(ZIP)。
 * @vitest-environment jsdom
 */
import JSZip from 'jszip';
import { DEFAULT_SPC_RULES } from '../../store/appStore';
import { describe, it, expect } from 'vitest';
import { assessSpcCharts, DEFAULT_RULE_K, type NelsonRules } from '../../core';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { buildData, computeVarModel } from '../../core';

const D = buildData();
const M = computeVarModel('质检数据.mtw', ['直径1', '直径2', '直径3', '直径4', '直径5'], D.subs.map((s) => s.vals), { isDemo: true });
const SPEC = { lsl: 24.9, tgt: 25.0, usl: 25.1 };
const R_ONLY = computeVarModel(
  'R-only.csv',
  ['a', 'b'],
  [...Array.from({ length: 24 }, () => [9, 11]), [0, 20]],
);
const R1_ONLY = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const RULES_OFF: NelsonRules = { r1: false, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const K12 = computeVarModel(
  'K2-12.csv',
  ['a', 'b'],
  [...Array.from({ length: 24 }, () => [1, 1]), [-24, -24]],
);

// 两份字节不同的最小 PNG，用于验证 OOXML 中位置图和离散图都真正入包。
const PNG_A = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const PNG_B = new Uint8Array([...PNG_A, 0]);

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b; // 'PK'

describe('Office 真渲染导出（无图降级）', () => {
  it('Word .docx 为合法 ZIP 且非空', async () => {
    const bytes = await buildDocx(M, SPEC, {}, assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K));
    expect(isZip(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(2000);
  });
  it('PowerPoint .pptx 为合法 ZIP 且非空', async () => {
    const bytes = await buildPptx(M, SPEC, {}, assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K));
    expect(isZip(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(10000);
  });

  it('Word 通用报告 OOXML 含 R 图标题且实际嵌入两张 SPC 图', async () => {
    const assessment = assessSpcCharts(R_ONLY, R1_ONLY, DEFAULT_RULE_K);
    expect(assessment.locationPoints).toBe(0);
    expect(assessment.dispersionPoints).toBe(1);
    const bytes = await buildDocx(R_ONLY, { lsl: 0, tgt: 10, usl: 20 }, { xbar: PNG_A, dispersion: PNG_B }, assessment);
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir);

    expect(documentXml).toContain('X̄ 控制图（位置）');
    expect(documentXml).toContain('R 控制图（离散）');
    expect(documentXml).toContain('各图累计 1 个失控点');
    expect(documentXml).toContain('去重子组 1 个');
    expect(media).toHaveLength(2);
  });

  it('PowerPoint 通用报告 OOXML 含独立 R 图 slide 且实际嵌入两张 SPC 图', async () => {
    const assessment = assessSpcCharts(R_ONLY, R1_ONLY, DEFAULT_RULE_K);
    const bytes = await buildPptx(R_ONLY, { lsl: 0, tgt: 10, usl: 20 }, { xbar: PNG_A, dispersion: PNG_B }, assessment);
    const zip = await JSZip.loadAsync(bytes);
    const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => zip.file(name)!.async('string')))).join('\n');
    const locationSlideXml = await zip.file('ppt/slides/slide3.xml')!.async('string');
    const dispersionSlideXml = await zip.file('ppt/slides/slide4.xml')!.async('string');
    const media = Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/') && !zip.files[name].dir);

    expect(slideXml).toContain('SPC 位置图（X̄）');
    expect(slideXml).toContain('SPC 离散图（R）');
    expect(slideXml).toContain('各图累计 1 个失控点');
    expect(slideXml).toContain('去重子组 1 个');
    expect(locationSlideXml).toContain('SPC 位置图（X̄）');
    expect(locationSlideXml).not.toContain('R图点25(准则1');
    expect(dispersionSlideXml).toContain('SPC 离散图（R）');
    expect(dispersionSlideXml).toContain('R图点25(准则1：');
    expect(media).toHaveLength(2);
  });

  it('K2=12 的 Word/PPT 摘要显式声明截断，总数仍与 24 条完整明细一致', async () => {
    const assessment = assessSpcCharts(K12, { ...RULES_OFF, r2: true }, { ...DEFAULT_RULE_K, k2: 12 });
    expect(assessment.events).toHaveLength(24);
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(K12, { lsl: -30, tgt: 0, usl: 30 }, {}, assessment),
      buildPptx(K12, { lsl: -30, tgt: 0, usl: 30 }, {}, assessment),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');
    const locationSlideXml = await pptx.file('ppt/slides/slide3.xml')!.async('string');

    expect(wordXml).toContain('各图累计 24 个失控点');
    expect(wordXml).toContain('连续 12 点落在中心线同一侧');
    expect(wordXml).toContain('摘要仅列前 12 项；共 24 项，完整明细请导出 Excel');
    expect(slideXml).toContain('各图累计 24 个失控点');
    expect(slideXml).toContain('连续 12 点落在中心线同一侧');
    expect(slideXml).toContain('摘要仅列前 8 项；该图共 24 项，完整明细请导出 Excel');
    expect(locationSlideXml).toContain('normAutofit');
  });

  it('常量数据时 Word/PPT 不因 AD 不可计算失败，且保留能力、SPC 与正态性说明', async () => {
    const constant = computeVarModel('常量.csv', ['a', 'b'], Array.from({ length: 20 }, () => [1, 1]));
    const assessment = assessSpcCharts(constant, RULES_OFF, DEFAULT_RULE_K);
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(constant, { lsl: 0, tgt: 1, usl: 2 }, {}, assessment),
      buildPptx(constant, { lsl: 0, tgt: 1, usl: 2 }, {}, assessment),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');

    for (const content of [wordXml, slideXml]) {
      expect(content).toContain('能力分析未运行');
      expect(content).toContain('未检出失控点');
      expect(content).toContain('数据无可估计变异，正态性不可判定');
    }
  });

  it('I-MR 的 Word/PPT 把 n=1 数据称为单值观测，并标明 MR̄/d₂(2)', async () => {
    const model = computeVarModel('单值.csv', ['x'], Array.from({ length: 20 }, (_, index) => [10 + (index % 3) * 0.1]));
    const assessment = assessSpcCharts(model, RULES_OFF, DEFAULT_RULE_K);
    const [docxBytes, pptxBytes] = await Promise.all([
      buildDocx(model, { lsl: 9, tgt: 10, usl: 11 }, {}, assessment),
      buildPptx(model, { lsl: 9, tgt: 10, usl: 11 }, {}, assessment),
    ]);
    const [docx, pptx] = await Promise.all([JSZip.loadAsync(docxBytes), JSZip.loadAsync(pptxBytes)]);
    const wordXml = await docx.file('word/document.xml')!.async('string');
    const slideNames = Object.keys(pptx.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXml = (await Promise.all(slideNames.map((name) => pptx.file(name)!.async('string')))).join('\n');

    for (const content of [wordXml, slideXml]) {
      expect(content).toContain('20 个单值观测');
      expect(content).toContain('σ 组内 (MR̄/d₂(2))');
      expect(content).not.toContain('20 子组 × 1 测量');
    }
  });
});
