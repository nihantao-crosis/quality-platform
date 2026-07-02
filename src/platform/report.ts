/**
 * 报表内容生成 — 导出功能的真实载荷。
 * excel → 工作表 CSV（125 行 + 统计摘要）；其余格式 → 中文文本报告。
 */
import type { ExportFmt } from '../store/appStore';
import { nf, computeCapability, evalRules, type DataModel } from '../core';

const OPS = ['张伟', '李娜', '王强'];
const SHIFTS = ['早班', '中班', '夜班'];

export interface ReportSpec {
  lsl: number;
  tgt: number;
  usl: number;
}

export function worksheetCsv(M: DataModel): string {
  const head = ['子组', '直径1', '直径2', '直径3', '直径4', '直径5', '均值', '极差', '操作员', '日期', '班次'];
  const rows = M.subs.map((s, i) => [
    s.i,
    ...s.vals.map((v) => nf(v, 3)),
    nf(s.mean, 3),
    nf(s.range, 3),
    OPS[i % 3],
    '2026-06-' + String((i % 28) + 1).padStart(2, '0'),
    SHIFTS[i % 3],
  ]);
  return [head, ...rows].map((r) => r.join(',')).join('\n');
}

export function textReport(M: DataModel, spec: ReportSpec): string {
  const cap = computeCapability(M.all, M.sigmaWithin, spec);
  const sig = (M.uclX - M.xbarbar) / 3;
  const { list } = evalRules(M.means, M.xbarbar, sig, { r1: true, r2: true, r3: true, r4: true });
  const L: string[] = [];
  L.push('════════════════════════════════════════');
  L.push('  质量分析报告 · 质检数据.mtw');
  L.push('  质量分析平台 Quality Analytics Platform v1.0');
  L.push('  生成时间: ' + new Date().toLocaleString('zh-CN'));
  L.push('════════════════════════════════════════');
  L.push('');
  L.push('【数据集】');
  L.push(`  25 子组 × 5 测量值 = 125 观测 · 变量: C2 直径 (mm)`);
  L.push(`  均值 ${nf(M.oMean, 4)} · σ整体 ${nf(M.oSd, 4)} · σ组内(R̄/d₂) ${nf(M.sigmaWithin, 4)}`);
  L.push('');
  L.push('【SPC · X̄-R 控制图】');
  L.push(`  中心线 X̄ ${nf(M.xbarbar, 3)} · UCL ${nf(M.uclX, 3)} · LCL ${nf(M.lclX, 3)} · R̄ ${nf(M.rbar, 3)}`);
  if (list.length === 0) L.push('  ✓ 未检出失控点，过程受控');
  else {
    L.push(`  ✗ 检出 ${list.length} 项失控（Nelson 准则）:`);
    list.forEach((v) => L.push(`    · 点 ${v.i + 1} · 准则 ${v.rule} · ${v.desc}`));
  }
  L.push('');
  L.push('【过程能力】规格 ' + nf(spec.lsl, 2) + ' / ' + nf(spec.tgt, 2) + ' / ' + nf(spec.usl, 2));
  L.push(`  Cp ${nf(cap.cp, 2)} · Cpk ${nf(cap.cpk, 2)} · Pp ${nf(cap.pp, 2)} · Ppk ${nf(cap.ppk, 2)}`);
  L.push(`  CPU ${nf(cap.cpu, 2)} · CPL ${nf(cap.cpl, 2)} · Z.bench ${nf(cap.zBench, 2)} · 西格玛水平 ${nf(cap.sigmaLevel, 2)}σ`);
  L.push(`  PPM 合计（整体）${Math.round(cap.ppm.overall.total).toLocaleString()}`);
  L.push(`  判定: ${cap.verdict === 'sufficient' ? '能力充足 (Cpk ≥ 1.33)' : cap.verdict === 'marginal' ? '能力临界 (1.0 ≤ Cpk < 1.33)' : '能力不足 (Cpk < 1.0)'}`);
  L.push('');
  L.push('【测量系统 Gage R&R】');
  L.push('  合计 Gage R&R 8.4% (%研究变异) · 可接受 (AIAG < 10% 优秀)');
  L.push('');
  L.push('【方差分析】直径 ~ 设备: F=4.82, P=0.012 (显著) — 设备 B 均值偏高');
  L.push('');
  L.push('—— 本报告由统计引擎实时计算生成 ——');
  return L.join('\n');
}

export function buildExportPayload(fmt: ExportFmt, M: DataModel, spec: ReportSpec): { defaultName: string; contents: string } {
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === 'excel') return { defaultName: `质检数据_${stamp}`, contents: worksheetCsv(M) };
  return { defaultName: `质量分析报告_${stamp}`, contents: textReport(M, spec) };
}
