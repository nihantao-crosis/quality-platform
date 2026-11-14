/** @vitest-environment jsdom */
/**
 * fix2611a G25c-export C1(附录 F.2-5):SPC 与能力用不同变量时,四种导出(HTML/Word/PPT/Excel)
 * 与纯文本报告都写明能力变量名与数据口径,文案与能力页「能力数据口径」逐字同源;
 * Excel 另附能力源数据表。C===M 时不出现该行(输出与 HEAD 逐字相同由基线对拍另行核对)。
 */
import { createElement } from 'react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { assessSpcCharts, computeVarModel, DEFAULT_RULE_K, type VarModel } from '../../core';
import { buildActiveAnalysisExport } from '../../platform/activeAnalysisReport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { textReport } from '../../platform/report';
import { buildXlsx, capabilityDataSheetRows } from '../../platform/xlsxExport';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { resolveCapabilityMeasurementData, useData } from '../../store/dataStore';
import { Capability } from '../pages/Capability';
import { chartTokens } from '../tokens';

const SPEC = { lsl: 24.5, tgt: 25, usl: 25.5 };
const COLUMNS = ['A', '外径'];

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function worksheetRows(): number[][] {
  const random = lcg(17);
  return Array.from({ length: 42 }, () => [
    Math.round((25 + (random() - 0.5) * 0.2) * 1000) / 1000,
    Math.round((25.05 + (random() - 0.5) * 0.3) * 1000) / 1000,
  ]);
}

function officeText(xml: string): string {
  return [...xml.matchAll(/<(?:w|a):t(?: [^>]*)?>(.*?)<\/(?:w|a):t>/g)].map((match) => match[1]).join('\n');
}

async function zipText(bytes: Uint8Array, pattern: RegExp): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => pattern.test(name)).sort();
  return officeText((await Promise.all(names.map((name) => zip.file(name)!.async('string')))).join('\n'));
}

const unescapeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useData.getState().importMatrix('双变量.csv', COLUMNS, worksheetRows());
  useApp.setState({
    page: 'dashboard', modal: null, exportFmt: 'pdf',
    spcDataLayout: 'individuals', spcValueCol: 'A', spcSubgroupCol: null, spcStageCol: null, spcSigmaMethod: 'classic',
    spcType: 'i-mr', capSubgroupMode: 'const', capSubgroupSize: 5, capValueCol: '外径', capSubgroupIdCol: null,
    spcRules: DEFAULT_SPC_RULES, spcRuleK: DEFAULT_RULE_K,
    lsl: SPEC.lsl, tgt: SPEC.tgt, usl: SPEC.usl, lslOn: true, uslOn: true,
    capabilityWarningAcknowledgement: null,
  });
});

afterEach(() => cleanup());

interface Exported {
  model: VarModel;
  capabilityModel: VarModel;
  capabilitySource?: { variableName: string; note: string } | null;
}

describe('C1 · 能力变量与数据口径写进四种导出', () => {
  it('Dashboard 通用导出:C≠M 时各格式均含与能力页逐字相同的「能力数据口径」行,Excel 附能力源数据', async () => {
    const exported = buildActiveAnalysisExport() as unknown as Exported;
    const M = exported.model;
    const C = exported.capabilityModel;
    expect(C).not.toBe(M);
    expect(M.colNames).toEqual(['A']);
    const prepared = resolveCapabilityMeasurementData(useData.getState().model, useData.getState().textCols);
    const expected = `能力数据口径：${prepared.note}；变量：${prepared.variableName}；实际观测 N=${C.all.length}`;
    expect(prepared.variableName).toBe('外径');
    expect(exported.capabilitySource).toEqual({ variableName: prepared.variableName, note: prepared.note });

    // 能力页同源:页面那一行就是导出写的这一行(页面另以「。」收尾)
    useApp.setState({ page: 'capability' });
    const page = render(createElement(Capability, { T: chartTokens('经典', true) }));
    expect(page.container.textContent).toContain(`${expected}。`);
    cleanup();

    const assessment = assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');
    const options = { capabilitySource: exported.capabilitySource ?? null };
    const html = buildHtmlReport(M, SPEC, assessment, undefined, C, null, options as never);
    expect(unescapeXml(html)).toContain(expected);
    expect(textReport(M, SPEC, assessment, C, assessment.chartPointCount, options as never)).toContain(expected);
    const docx = await zipText(await buildDocx(M, SPEC, {}, assessment, undefined, C, null, options as never), /^word\/document\.xml$/);
    expect(unescapeXml(docx)).toContain(expected);
    const pptx = await zipText(await buildPptx(M, SPEC, {}, assessment, undefined, C, null, options as never), /^ppt\/slides\/slide\d+\.xml$/);
    expect(unescapeXml(pptx)).toContain(expected);

    const wb = XLSX.read(buildXlsx(M, SPEC, assessment, undefined, C, null, options as never), { type: 'array' });
    const summary = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['统计摘要'], { header: 1, raw: false });
    expect(summary.some((row) => row.includes(expected))).toBe(true);
    expect(wb.SheetNames).toContain('能力数据');
    const capRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['能力数据'], { header: 1, raw: true });
    expect(capRows[0]).toEqual(['子组', ...C.colNames, '均值', '极差']);
    expect(capRows).toHaveLength(C.k + 1);
    expect(capRows.slice(1).map((row) => row.slice(1, 1 + C.n))).toEqual(C.subs.map((s) => s.vals));
    // SPC 数据页仍只导出 SPC 模型
    const dataRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['数据'], { header: 1, raw: true });
    expect(dataRows[0]).toEqual(['观测', 'A']);
  });

  it('未带口径来源的直接调用(C≠M)仍写明能力变量名与数据结构,各格式同一行', async () => {
    const M = computeVarModel('m.csv', ['A'], worksheetRows().map((row) => [row[0]]));
    const C = computeVarModel('m.csv', ['外径'], worksheetRows().map((row) => [row[1]]));
    const expected = `能力数据口径：${C.all.length} 个单值观测；变量：外径；实际观测 N=${C.all.length}`;
    const assessment = assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');
    expect(unescapeXml(buildHtmlReport(M, SPEC, assessment, undefined, C))).toContain(expected);
    expect(textReport(M, SPEC, assessment, C)).toContain(expected);
    expect(unescapeXml(await zipText(await buildDocx(M, SPEC, {}, assessment, undefined, C), /^word\/document\.xml$/))).toContain(expected);
    expect(unescapeXml(await zipText(await buildPptx(M, SPEC, {}, assessment, undefined, C), /^ppt\/slides\/slide\d+\.xml$/))).toContain(expected);
    const wb = XLSX.read(buildXlsx(M, SPEC, assessment, undefined, C), { type: 'array' });
    const summary = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['统计摘要'], { header: 1, raw: false });
    expect(summary.some((row) => row.includes(expected))).toBe(true);
  });

  it('能力源数据页受 Excel 单表行数上限约束,超限时末行写截断说明', () => {
    const C = computeVarModel('m.csv', ['外径'], worksheetRows().map((row) => [row[1]]));
    const rows = capabilityDataSheetRows(C, 6);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(['观测', '外径']);
    expect(rows.slice(1, 5).map((row) => row[1])).toEqual(C.subs.slice(0, 4).map((s) => s.vals[0]));
    expect(String(rows[5][0])).toContain(`表格共 ${C.subs.length} 行，Excel仅列前 4 行`);
    expect(capabilityDataSheetRows(C)).toHaveLength(C.subs.length + 1);
  });

  it('C===M:任何格式都不出现「能力数据口径」行,Excel 不附能力数据表', async () => {
    const M = computeVarModel('m.csv', ['A'], worksheetRows().map((row) => [row[0]]));
    const assessment = assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');
    expect(buildHtmlReport(M, SPEC, assessment)).not.toContain('能力数据口径');
    expect(textReport(M, SPEC, assessment)).not.toContain('能力数据口径');
    expect(await zipText(await buildDocx(M, SPEC, {}, assessment), /^word\/document\.xml$/)).not.toContain('能力数据口径');
    expect(await zipText(await buildPptx(M, SPEC, {}, assessment), /^ppt\/slides\/slide\d+\.xml$/)).not.toContain('能力数据口径');
    const wb = XLSX.read(buildXlsx(M, SPEC, assessment), { type: 'array' });
    expect(wb.SheetNames).toEqual(['数据', '统计摘要', '失控点']);
  });
});
