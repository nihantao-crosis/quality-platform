/** @vitest-environment jsdom */
/**
 * fix2611a G25c-export C3(附录 F.2-11):四种导出 + 纯文本报告的能力表术语一致
 * (「西格玛水平」「PPM 合计（整体）」,单一来源 reportLabels.CAPABILITY_TERMS)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { assessSpcCharts, computeVarModel, DEFAULT_RULE_K } from '../../core';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import * as reportLabels from '../../platform/reportLabels';
import { textReport } from '../../platform/report';
import { buildXlsx } from '../../platform/xlsxExport';
import { DEFAULT_SPC_RULES } from '../../store/appStore';

const SPEC = { lsl: 24.5, tgt: 25, usl: 25.5 };
const SIGMA_LEVEL = '西格玛水平';
const PPM_OVERALL = 'PPM 合计（整体）';
const LEGACY = ['σ 水平', 'PPM(整体)'];

function officeRuns(xml: string): string[] {
  return [...xml.matchAll(/<(?:w|a):t(?: [^>]*)?>(.*?)<\/(?:w|a):t>/g)].map((match) => match[1]);
}

async function zipRuns(bytes: Uint8Array, pattern: RegExp): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => pattern.test(name)).sort();
  return (await Promise.all(names.map((name) => zip.file(name)!.async('string')))).flatMap(officeRuns);
}

describe('C3 · 能力表术语跨格式一致', () => {
  const rows = Array.from({ length: 30 }, (_, i) => [25 + ((i * 37) % 11 - 5) * 0.02]);
  const M = computeVarModel('t.csv', ['A'], rows);
  const assessment = assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');

  it('reportLabels 导出唯一术语表', () => {
    const terms = (reportLabels as unknown as { CAPABILITY_TERMS?: Record<string, string> }).CAPABILITY_TERMS;
    expect(terms).toMatchObject({ sigmaLevel: SIGMA_LEVEL, ppmOverall: PPM_OVERALL });
  });

  it('HTML / 文本 / Excel / Word / PPT 均用同一术语,不再出现旧写法', async () => {
    const html = buildHtmlReport(M, SPEC, assessment);
    const text = textReport(M, SPEC, assessment);
    const wb = XLSX.read(buildXlsx(M, SPEC, assessment), { type: 'array' });
    const xlsxLabels = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['统计摘要'], { header: 1, raw: false }).map((row) => row[0]);
    const word = await zipRuns(await buildDocx(M, SPEC, {}, assessment), /^word\/document\.xml$/);
    const ppt = await zipRuns(await buildPptx(M, SPEC, {}, assessment), /^ppt\/slides\/slide\d+\.xml$/);
    for (const [name, content] of [['html', html], ['text', text], ['xlsx', xlsxLabels.join('\n')], ['word', word.join('\n')], ['ppt', ppt.join('\n')]] as const) {
      expect(content, name).toContain(SIGMA_LEVEL);
      expect(content, name).toContain(PPM_OVERALL);
      for (const legacy of LEGACY) expect(content, `${name}:${legacy}`).not.toContain(legacy);
    }
    expect(word).toContain(SIGMA_LEVEL);
    expect(word).toContain(PPM_OVERALL);
    expect(ppt).toContain(SIGMA_LEVEL);
    expect(ppt).toContain(PPM_OVERALL);
  });

  it('源码守卫:导出模块不再各自硬写能力术语字面量', () => {
    for (const file of ['htmlReport.tsx', 'officeExport.tsx', 'xlsxExport.ts', 'report.ts']) {
      const source = readFileSync(resolve(__dirname, '../../platform', file), 'utf8');
      for (const literal of [SIGMA_LEVEL, PPM_OVERALL, ...LEGACY]) {
        expect(source.includes(`'${literal}'`) || source.includes(` ${literal} `), `${file}:${literal}`).toBe(false);
      }
    }
  });
});
