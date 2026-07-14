/**
 * 报表内容生成 — 导出功能的真实载荷,全部指标由 /core 引擎从活动数据集实时计算。
 * excel → 工作表 CSV;其余格式 → 中文文本报告。
 */
import type { ExportFmt } from '../store/appStore';
import {
  nf, fmtCap, computeCapability, evalRules, DEFAULT_RULES, oneWayAnova, computeGageRR,
  anovaGroups, gageStudyData, GAGE_TOLERANCE, type VarModel,
} from '../core';

const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

export interface ReportSpec {
  lsl: number;
  tgt: number;
  usl: number;
}

export function worksheetCsv(M: VarModel): string {
  const head = ['子组', ...M.colNames];
  if (M.hasSubgroups) head.push('均值', '极差');
  if (M.isDemo) head.push('操作员', '日期', '班次');
  const rows = M.subs.map((s, i) => {
    const r: (string | number)[] = [s.i, ...s.vals.map((v) => nf(v, 3))];
    if (M.hasSubgroups) r.push(nf(s.mean, 3), nf(s.range, 3));
    if (M.isDemo) r.push(OPS[i % 3], '2026-06-' + String((i % 28) + 1).padStart(2, '0'), SHIFTS[i % 3]);
    return r;
  });
  return [head, ...rows].map((r) => r.join(',')).join('\n');
}

export function textReport(M: VarModel, spec: ReportSpec): string {
  const cap = computeCapability(M.all, M.sigmaWithin, spec);
  const means = M.subs.map((s) => s.mean);
  const sig = (M.uclX - M.xbarbar) / 3;
  const { list } = evalRules(means, M.xbarbar, sig, DEFAULT_RULES);
  const anova = oneWayAnova(anovaGroups().map((g) => g.vals));
  const gage = computeGageRR(gageStudyData(), GAGE_TOLERANCE);
  const L: string[] = [];
  L.push('════════════════════════════════════════');
  L.push('  质量分析报告 · ' + M.name);
  L.push('  质量分析平台 Quality Analytics Platform v1.0');
  L.push('  生成时间: ' + new Date().toLocaleString('zh-CN'));
  L.push('════════════════════════════════════════');
  L.push('');
  L.push('【数据集】');
  L.push(`  ${M.k} 子组 × ${M.n} 测量值 = ${M.all.length} 观测 · 列: ${M.colNames.join(' / ')}`);
  L.push(`  均值 ${nf(M.oMean, 4)} · σ整体 ${nf(M.oSd, 4)} · σ组内 ${nf(M.sigmaWithin, 4)}`);
  L.push('');
  if (M.hasSubgroups) {
    L.push('【SPC · X̄-R 控制图】');
    L.push(`  中心线 X̄ ${nf(M.xbarbar, 3)} · UCL ${nf(M.uclX, 3)} · LCL ${nf(M.lclX, 3)} · R̄ ${nf(M.rbar, 3)}`);
  } else {
    L.push('【SPC · I-MR 控制图】');
    L.push(`  中心线 X̄ ${nf(M.indMean, 3)} · UCL ${nf(M.iUcl, 3)} · LCL ${nf(M.iLcl, 3)} · MR̄ ${nf(M.mrbar, 3)}`);
  }
  if (list.length === 0) L.push('  ✓ 未检出失控点，过程受控');
  else {
    L.push(`  ✗ 检出 ${list.length} 项失控（Nelson 准则）:`);
    list.forEach((v) => L.push(`    · 点 ${v.i + 1} · 准则 ${v.rule} · ${v.desc}`));
  }
  L.push('');
  L.push('【过程能力】规格 ' + nf(spec.lsl, 2) + ' / ' + nf(spec.tgt, 2) + ' / ' + nf(spec.usl, 2));
  L.push(`  Cp ${fmtCap(cap.cp)} · Cpk ${nf(cap.cpk, 2)} · Pp ${fmtCap(cap.pp)} · Ppk ${nf(cap.ppk, 2)}`);
  L.push(`  CPU ${fmtCap(cap.cpu)} · CPL ${fmtCap(cap.cpl)} · Z.bench ${nf(cap.zBench, 2)} · 西格玛水平 ${nf(cap.sigmaLevel, 2)}σ`);
  L.push(`  PPM 合计（整体）${Math.round(cap.ppm.overall.total).toLocaleString()}`);
  L.push(`  判定: ${cap.verdict === 'sufficient' ? '能力充足 (Cpk ≥ 1.33)' : cap.verdict === 'marginal' ? '能力临界 (1.0 ≤ Cpk < 1.33)' : '能力不足 (Cpk < 1.0)'}`);
  L.push('');
  L.push('【测量系统 Gage R&R · 演示研究】');
  L.push(`  合计 Gage R&R ${nf(gage.totalGageRR, 1)}% (%研究变异) · ${gage.verdict === 'acceptable' ? '可接受' : gage.verdict === 'marginal' ? '临界' : '不可接受'} (AIAG)`);
  L.push('');
  L.push(`【方差分析 · 演示研究】直径 ~ 设备: F=${nf(anova.fStat, 2)}, P=${nf(anova.pValue, 3)} (${anova.significant ? '显著' : '不显著'})`);
  L.push('');
  L.push('—— 本报告由统计引擎实时计算生成 ——');
  return L.join('\n');
}

import type { ExportJob } from './adapter';

/**
 * 导出任务构建。重量级依赖（SheetJS/docx/pptxgenjs/react-dom-server）
 * 全部动态加载：导出发生时才拉取对应 chunk,主包保持轻量。
 */
export async function buildExportJob(fmt: ExportFmt, M: VarModel, spec: ReportSpec): Promise<ExportJob> {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = M.name.replace(/\.[^.]+$/, '');
  if (fmt === 'excel') {
    const { buildXlsx } = await import('./xlsxExport');
    return {
      defaultName: `${base}_${stamp}`,
      ext: 'xlsx',
      filterLabel: 'Excel 工作簿',
      bytes: buildXlsx(M, spec),
    };
  }
  if (fmt === 'pdf') {
    // 图文报告：自包含 HTML(内嵌 SVG 图表),浏览器打开后打印即得 PDF
    const { buildHtmlReport } = await import('./htmlReport');
    return {
      defaultName: `质量分析报告_${stamp}`,
      ext: 'html',
      filterLabel: '图文报告 (打开后打印为 PDF)',
      text: buildHtmlReport(M, spec),
    };
  }
  // Office 真渲染：图表位图化失败(无 canvas 环境)时降级为纯表格文档
  const office = await import('./officeExport');
  let images: Awaited<ReturnType<typeof office.renderReportImages>> = {};
  try {
    images = await office.renderReportImages(M, spec);
  } catch { /* 降级 */ }
  if (fmt === 'ppt') {
    return {
      defaultName: `质量分析报告_${stamp}`,
      ext: 'pptx',
      filterLabel: 'PowerPoint 演示文稿',
      bytes: await office.buildPptx(M, spec, images),
    };
  }
  return {
    defaultName: `质量分析报告_${stamp}`,
    ext: 'docx',
    filterLabel: 'Word 文档',
    bytes: await office.buildDocx(M, spec, images),
  };
}
