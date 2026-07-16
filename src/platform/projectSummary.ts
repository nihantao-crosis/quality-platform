/**
 * 项目汇总报告 — 把项目里所有已保存分析导出成一份自包含 HTML(打印即 PDF)。
 * 这是「积累分析」的兑现:一份可交付的质量汇总,而非单次分析。
 */
import type { SavedAnalysis } from '../store/analyses';

const CSS = `
  body { font-family: "IBM Plex Sans", "PingFang SC", "Microsoft YaHei", sans-serif; color: #2a333f; margin: 0; padding: 32px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8a929d; font-size: 12.5px; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; margin: 8px 0 22px; flex-wrap: wrap; }
  .card { border: 1px solid #e2e5ea; border-radius: 6px; padding: 12px 18px; min-width: 120px; }
  .card .n { font-size: 26px; font-weight: 700; font-family: "IBM Plex Mono", monospace; }
  .card .l { font-size: 12px; color: #8a929d; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { border: 1px solid #e2e5ea; padding: 7px 10px; text-align: left; }
  th { background: #f4f6f8; color: #5b6472; font-weight: 600; }
  td.mono { font-family: "IBM Plex Mono", monospace; color: #5b6472; }
  .badge { display: inline-block; padding: 1px 9px; border-radius: 9px; font-size: 11px; font-weight: 600; }
  .footer { margin-top: 28px; color: #9aa2ad; font-size: 11px; border-top: 1px solid #eef0f3; padding-top: 10px; }
  @media print { body { padding: 0; } tr { break-inside: avoid; } }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** P1-3:颜色只放行严格 hex;其余一律回退中性色,杜绝 style 属性注入。 */
const safeColor = (s: string, fallback: string) => /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;

const KIND_LABEL: Record<string, string> = {
  spc: 'SPC 控制图', capability: '过程能力', gagerr: '测量系统', anova: '假设检验',
  pareto: '帕累托/因果', doe: '实验设计', aql: '抽样检验',
};

export function buildProjectSummary(projectName: string, saved: SavedAnalysis[]): string {
  const byKind = new Map<string, number>();
  const datasets = new Set<string>();
  saved.forEach((a) => {
    byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    datasets.add(a.datasetName);
  });
  const fmt = (t: number) => new Date(t).toLocaleString('zh-CN');

  const cards = [
    ['分析总数', String(saved.length)],
    ['涉及数据集', String(datasets.size)],
    ['分析类型', String(byKind.size)],
  ];

  const rows = saved
    .map(
      (a) => `<tr>
        <td>${esc(a.title)}</td>
        <td>${esc(KIND_LABEL[a.kind] ?? a.kind)}</td>
        <td class="mono">${esc(a.datasetName)}</td>
        <td class="mono">${esc(a.metric)}</td>
        <td><span class="badge" style="background:${safeColor(a.statusBg, '#eef1f4')};color:${safeColor(a.statusColor, '#5b6472')}">${esc(a.status)}</span></td>
        <td class="mono">${fmt(a.createdAt)}</td>
      </tr>`,
    )
    .join('');

  const body =
    saved.length === 0
      ? '<p style="color:#9aa2ad">项目中暂无已保存的分析。在各分析模块点「保存到项目」后再生成汇总。</p>'
      : `<table>
          <tr><th>分析</th><th>类型</th><th>数据集</th><th>关键指标</th><th>状态</th><th>保存时间</th></tr>
          ${rows}
        </table>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>项目汇总 · ${esc(projectName)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>项目分析汇总 · ${esc(projectName)}</h1>
<div class="sub">生成于 ${new Date().toLocaleString('zh-CN')} · 质量分析平台</div>
<div class="cards">
  ${cards.map(([l, n]) => `<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}
</div>
${body}
<div class="footer">本汇总由质量分析平台从已保存的分析记录生成 · 打印本页（⌘/Ctrl+P）即可保存为 PDF</div>
</body>
</html>`;
}
