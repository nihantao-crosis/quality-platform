/**
 * 报表内容生成 — 导出功能的真实载荷,全部指标由 /core 引擎从活动数据集实时计算。
 * excel → 工作表 CSV;其余格式 → 中文文本报告。
 */
import type { ExportFmt } from '../store/appStore';
import {
  nf, fmtCap, computeCapability, capabilityInputError, oneWayAnova, computeGageRR,
  anovaGroups, gageStudyData, GAGE_TOLERANCE, type VarModel,
  assessCapability, evaluateAndersonDarling,
  type SpcAssessment, type SpecLimits,
} from '../core';
import { reportContextText, reportSpecText, withinSigmaLabel } from './reportLabels';

const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

export type ReportSpec = SpecLimits;

export function worksheetCsv(M: VarModel): string {
  const head = [M.hasSubgroups ? '子组' : '观测', ...M.colNames];
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

// 通用报告判异由调用方按「用户当前规则/K」计算后传入；
// 本函数不再内置 DEFAULT_RULES。页面专项报告仍使用自身 AnalysisReportPayload，不经这条通用文本路径。
export function textReport(
  M: VarModel,
  spec: ReportSpec,
  assessment: SpcAssessment,
  capabilityModel: VarModel = M,
  capabilitySpcViolations: number = assessment.chartPointCount,
): string {
  const C = capabilityModel;
  // 能力输入闸门:规格与数据量纲不匹配(1000σ 哨兵)等情况下,能力章节写「未运行」而非让整份导出失败
  const capError = capabilityInputError(C.all, C.sigmaWithin, spec);
  const cap = capError ? null : computeCapability(C.all, C.sigmaWithin, spec);
  const violationEvents = assessment.events;
  const anova = M.isDemo ? oneWayAnova(anovaGroups().map((g) => g.vals)) : null;
  const gage = M.isDemo ? computeGageRR(gageStudyData(), { mode: 'width', value: GAGE_TOLERANCE }) : null;
  const L: string[] = [];
  L.push('════════════════════════════════════════');
  L.push('  质量分析报告 · ' + M.name);
  L.push('  质量分析平台 Quality Analytics Platform v' + (typeof __APP_VERSION__ === 'undefined' ? '开发版' : __APP_VERSION__));
  L.push('  生成时间: ' + new Date().toLocaleString('zh-CN'));
  L.push('════════════════════════════════════════');
  L.push('');
  L.push('【数据集】');
  L.push(`  ${reportContextText(M, C)} · SPC 列: ${M.colNames.join(' / ')}`);
  if (C !== M) L.push(`  能力列: ${C.colNames.join(' / ')}`);
  L.push(`  能力口径均值 ${nf(C.oMean, 4)} · σ整体 ${nf(C.oSd, 4)} · ${withinSigmaLabel(C)} ${nf(C.sigmaWithin, 4)}`);
  L.push('');
  if (M.hasSubgroups) {
    L.push('【SPC · X̄-R 控制图】');
    L.push(`  中心线 X̄ ${nf(M.xbarbar, 3)} · UCL ${nf(M.uclX, 3)} · LCL ${nf(M.lclX, 3)} · R̄ ${nf(M.rbar, 3)}`);
  } else {
    L.push('【SPC · I-MR 控制图】');
    L.push(`  中心线 X̄ ${nf(M.indMean, 3)} · UCL ${nf(M.iUcl, 3)} · LCL ${nf(M.iLcl, 3)} · MR̄ ${nf(M.mrbar, 3)}`);
  }
  L.push('  ' + assessment.verdictLine);
  if (violationEvents.length > 0) {
    // 三个计数各自标注口径,避免「结论 N 点、明细 M 行」观感矛盾(明细行按 点×准则 展开,可多于点数)
    L.push(`  判异明细（各图累计 ${assessment.chartPointCount} 个失控点：${assessment.locationLabel} 图 ${assessment.locationPoints} 个 + ${assessment.dispersionLabel} 图 ${assessment.dispersionPoints} 个；去重${assessment.analysisUnitLabel} ${assessment.uniqueAnalysisUnitCount} 个）:`);
    violationEvents.forEach((v) => L.push(`    · ${v.chart} 图 · 点 ${v.i + 1} · 准则 ${v.rule} · ${v.desc}`));
  }
  L.push('');
  L.push('【过程能力】规格 ' + reportSpecText(spec, 2));
  if (!cap) {
    L.push(`  能力分析未运行: ${capError}`);
  } else {
    L.push(`  Cp ${fmtCap(cap.cp)} · Cpk ${nf(cap.cpk, 2)} · Pp ${fmtCap(cap.pp)} · Ppk ${nf(cap.ppk, 2)}`);
    L.push(`  CPU ${fmtCap(cap.cpu)} · CPL ${fmtCap(cap.cpl)} · Z.bench ${nf(cap.zBench, 2)} · 西格玛水平 ${nf(cap.sigmaLevel, 2)}σ`);
    L.push(`  PPM 合计（整体）${Math.round(cap.ppm.overall.total).toLocaleString()}`);
    // P0-4:判定必须消费唯一判定器——失控时不得写无警示的「能力充足」。
    const capAd = evaluateAndersonDarling(C.all).result;
    const capAssessment = assessCapability({
      cpk: cap.cpk, verdict: cap.verdict, adP: capAd ? capAd.p : null, n: C.all.length,
      // 保持能力判定既有的「位置图点数 + 离散图点数」口径，但复用上方结果，不再二次重算。
      spcViolations: capabilitySpcViolations,
    });
    L.push(`  判定: ${capAssessment.status}`);
    if (capAssessment.spcViolations > 0) L.push(`  ⚠ ${capAssessment.headline}`);
  }
  L.push('');
  if (gage && anova) {
    L.push('【测量系统 Gage R&R · 演示研究】');
    L.push(`  合计 Gage R&R ${nf(gage.totalGageRR, 1)}% (%研究变异) · ${gage.verdict === 'acceptable' ? '可接受' : gage.verdict === 'marginal' ? '临界' : '不可接受'} (AIAG)`);
    L.push('');
    L.push(`【方差分析 · 演示研究】直径 ~ 设备: F=${nf(anova.fStat, 2)}, P=${nf(anova.pValue, 3)} (${anova.significant ? '显著' : '不显著'})`);
    L.push('');
  }
  L.push('—— 本报告由统计引擎实时计算生成 ——');
  return L.join('\n');
}

import type { ExportJob } from './adapter';
import type { AnalysisReportPayload } from './analysisReportModel';

/**
 * 导出任务构建。重量级依赖（SheetJS/docx/pptxgenjs/react-dom-server）
 * 全部动态加载：导出发生时才拉取对应 chunk,主包保持轻量。
 */
export async function buildExportJob(
  fmt: ExportFmt,
  M: VarModel,
  spec: ReportSpec,
  // 必填:通用报告的 SPC 判异结果,由调用方按用户当前规则/K 计算(assessSpcCharts)。
  // 设为必填而非可选回落——v1.42.2 的教训正是"漏掉的调用点静默退回 DEFAULT_RULES"。
  assessment: SpcAssessment | null,
  analysis?: AnalysisReportPayload,
  capabilityModel: VarModel = M,
  capabilitySpcViolations: number | null = assessment?.chartPointCount ?? null,
): Promise<ExportJob> {
  if (!analysis && !assessment) throw new Error('通用报告必须提供当前 SPC 判异结果');
  const stamp = new Date().toISOString().slice(0, 10);
  const base = analysis?.title.replace(/[\\/:*?"<>|]/g, '_') || M.name.replace(/\.[^.]+$/, '');
  if (fmt === 'excel') {
    const { buildXlsx } = await import('./xlsxExport');
    return {
      defaultName: `${base}_${stamp}`,
      ext: 'xlsx',
      filterLabel: 'Excel 工作簿',
      bytes: buildXlsx(M, spec, assessment, analysis, capabilityModel, capabilitySpcViolations),
    };
  }
  if (fmt === 'pdf') {
    // 图文报告：自包含 HTML(内嵌 SVG 图表),浏览器打开后打印即得 PDF
    const { buildHtmlReport } = await import('./htmlReport');
    return {
      defaultName: `${base}_${stamp}`,
      ext: 'html',
      filterLabel: '图文报告 (打开后打印为 PDF)',
      text: buildHtmlReport(M, spec, assessment, analysis, capabilityModel, capabilitySpcViolations),
    };
  }
  // Office 真渲染：图表位图化失败(无 canvas 环境)时降级为纯表格文档
  const office = await import('./officeExport');
  let images: Awaited<ReturnType<typeof office.renderReportImages>> = {};
  try {
    images = await office.renderReportImages(M, spec, assessment, analysis, capabilityModel);
  } catch { /* 降级 */ }
  if (fmt === 'ppt') {
    return {
      defaultName: `${base}_${stamp}`,
      ext: 'pptx',
      filterLabel: 'PowerPoint 演示文稿',
      bytes: await office.buildPptx(M, spec, images, assessment, analysis, capabilityModel, capabilitySpcViolations),
    };
  }
  return {
    defaultName: `${base}_${stamp}`,
    ext: 'docx',
    filterLabel: 'Word 文档',
    bytes: await office.buildDocx(M, spec, images, assessment, analysis, capabilityModel, capabilitySpcViolations),
  };
}
