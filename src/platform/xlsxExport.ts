/**
 * 真 Excel (.xlsx) 导出 — SheetJS 生成多 sheet 工作簿：数据 / 统计摘要 / 失控点。
 * 两端共用（桌面经 Rust 落盘,Web 走 blob 下载）。
 */
import * as XLSX from 'xlsx';
import {
  nf, computeCapability, evalRules, type VarModel,
} from '../core';
import type { ReportSpec } from './report';

export function buildXlsx(M: VarModel, spec: ReportSpec): Uint8Array {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 数据
  const head = ['子组', ...M.colNames, ...(M.hasSubgroups ? ['均值', '极差'] : [])];
  const dataRows = M.subs.map((s) => [
    s.i,
    ...s.vals,
    ...(M.hasSubgroups ? [Number(nf(s.mean, 4)), Number(nf(s.range, 4))] : []),
  ]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...dataRows]), '数据');

  // Sheet 2: 统计摘要
  const cap = computeCapability(M.all, M.sigmaWithin, spec);
  const summary: (string | number)[][] = [
    ['质量分析平台 · 统计摘要', ''],
    ['工作表', M.name],
    ['子组数 k', M.k],
    ['子组大小 n', M.n],
    ['观测数 N', M.all.length],
    ['均值', Number(nf(M.oMean, 5))],
    ['σ 组内', Number(nf(M.sigmaWithin, 5))],
    ['σ 整体', Number(nf(M.oSd, 5))],
    ['', ''],
    ['规格 LSL / 目标 / USL', `${spec.lsl} / ${spec.tgt} / ${spec.usl}`],
    ['Cp', Number(nf(cap.cp, 3))],
    ['Cpk', Number(nf(cap.cpk, 3))],
    ['Pp', Number(nf(cap.pp, 3))],
    ['Ppk', Number(nf(cap.ppk, 3))],
    ['Cpm', Number(nf(cap.cpm, 3))],
    ['Z.bench', Number(nf(cap.zBench, 3))],
    ['西格玛水平', Number(nf(cap.sigmaLevel, 3))],
    ['PPM 合计（整体）', Math.round(cap.ppm.overall.total)],
    ['判定', cap.verdict === 'sufficient' ? '能力充足' : cap.verdict === 'marginal' ? '能力临界' : '能力不足'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '统计摘要');

  // Sheet 3: 失控点（X̄ 图 Nelson 全准则）
  const means = M.subs.map((s) => s.mean);
  const sig = (M.uclX - M.xbarbar) / 3;
  const { list } = evalRules(means, M.xbarbar, sig, { r1: true, r2: true, r3: true, r4: true });
  const violRows: (string | number)[][] = [['点号', 'Nelson 准则', '描述']];
  list.forEach((v) => violRows.push([v.i + 1, v.rule, v.desc]));
  if (list.length === 0) violRows.push(['—', '—', '未检出失控点，过程受控']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(violRows), '失控点');

  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
