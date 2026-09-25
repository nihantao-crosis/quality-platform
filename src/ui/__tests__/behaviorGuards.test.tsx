/** 行为级守护矩阵(闭环审核:20 条「守护无效」整改)。
 *
 * 立此文件的判据只有一条:**把实现改回旧行为,本文件必须转红**。
 * 每条用例都断言「行为本体」而非提示文案/存在性——旧批次的教训是
 * 「测试只断言截断说明、删掉 slice 仍全绿」这类空洞守护。
 * @vitest-environment jsdom */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import {
  computeDescriptive, worksheetResourceError, medianCiAchieved,
  detectFactorial, analyzeFactorial, factorialCornerOptimum,
  computeVarModel, assessSpcCharts, DEFAULT_RULE_K, parseMatrix, parseCategoryCounts, probPlotPoints, invNorm,
  computeGageRR, linearRegression, confoundedInteractionNote, buildDoeConclusion, doeInteractionNote, median, minitabQuantile, type GageObservation,
} from '../../core';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { cancelPendingDatasetWork, useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { preserveCorruptStore, QUARANTINE_STORAGE_KEY } from '../../store/quarantine';
import { projectStoreValidationError, buildProjectJson } from '../../platform/project';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { buildHtmlReport } from '../../platform/htmlReport';
import { buildXlsx } from '../../platform/xlsxExport';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';
import { mesStart, mesStop } from '../../platform/mes';
import { chartTokens, tickDecimals, tickLabel, tickFormatter, niceTicks } from '../tokens';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlChart } from '../charts/ControlChart';
import { Histogram } from '../charts/Histogram';
import { NormalProbPlot } from '../charts/NormalProbPlot';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { errText, assertXlsxArchiveBudget } from '../../platform/adapter';
import { boxplotStats, sampleOutliers } from '../charts/gagePanels';
import { BoxPlot, MiniHist, IndividualValuePlot, IntervalPlot } from '../charts/misc';
import { InteractionPlot } from '../charts/doe';
import { ScatterPlot } from '../charts/ScatterPlot';
import { Summary } from '../pages/Summary';
import { EffectsNormalPlot } from '../charts/EffectsNormalPlot';
import { Spc } from '../pages/Spc';
import { MenuBar } from '../shell/MenuBar';
import { Modals } from '../shell/Modals';

const T = chartTokens('经典', true);

/** 把 SVG 里的数字文本按坐标轴分组:X 轴标签共享同一 y、Y 轴标签共享同一 x。
 * 自审:此前把两条轴的标签混在一起判重复,必然假红。 */
function axisGroups(markup: string): Array<[string, string[]]> {
  const nodes = [...markup.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)]
    .map((m) => ({ attrs: m[1], text: m[2] }))
    .filter((n) => /^[-+]?[\d.]/.test(n.text));
  const byY = new Map<string, string[]>();
  const byX = new Map<string, string[]>();
  for (const n of nodes) {
    const y = /y="([-\d.]+)"/.exec(n.attrs)?.[1];
    const x = /x="([-\d.]+)"/.exec(n.attrs)?.[1];
    if (y) { const g = byY.get(y) ?? []; g.push(n.text); byY.set(y, g); }
    if (x) { const g = byX.get(x) ?? []; g.push(n.text); byX.set(x, g); }
  }
  return [
    ...[...byY.entries()].filter(([, g]) => g.length > 1).map(([k, g]) => [`X(y=${k})`, g] as [string, string[]]),
    ...[...byX.entries()].filter(([, g]) => g.length > 1).map(([k, g]) => [`Y(x=${k})`, g] as [string, string[]]),
  ];
}

beforeEach(() => {
  // 持久化失败用例会故意留下 fail-closed 标记；测试隔离需显式提交丢弃，
  // 不能靠 resetDemo 绕过产品的未保存替换闸门。
  cancelPendingDatasetWork();
  localStorage.clear();
  mesStop();
  useData.getState().resetDemo();
  useData.setState({ recents: [] }); // 复审 P3:跨用例状态泄漏
  // 自审 P3:此前只重置三个键,activeVar/hypoTab/regXName 等实测跨用例残留
  useApp.setState({
    spcRules: DEFAULT_SPC_RULES, spcRuleK: DEFAULT_RULE_K, page: 'spc',
    spcType: 'xbar-r', spcStageCol: null, spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
    activeVar: '', hypoTab: 'anova', regXName: null, regYName: null, selSub: null,
  });
});

const bigAnalysis = (rows: number) => ({
  kind: 'spc', title: '大表', subtitle: 's', generatedAt: '2026-07-26',
  summary: ['ok'], warnings: [],
  tables: [{ title: '观测', headers: ['序号', '值'], rows: Array.from({ length: rows }, (_, i) => [i + 1, i]) }],
  charts: [],
}) as never;
const M3 = () => computeVarModel('w.csv', ['x'], [[1], [2], [3]]);
const SPEC = { lsl: 0, tgt: 2, usl: 4 };

// ──────────────── 导出行为本体 ────────────────
describe('导出上限:断言真实产出规模,而非截断文案', () => {
  it('Word 专项表只写 2000 个数据行(删掉 slice 即红)', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(M3(), SPEC, {}, null, bigAnalysis(2500)));
    const xml = await zip.file('word/document.xml')!.async('string');
    // 表格行 = 1 表头 + 2000 数据行;截断说明是段落不是行
    const rowCount = (xml.match(/<w:tr[ >]/g) ?? []).length;
    expect(rowCount).toBe(2001);
    expect(xml).not.toMatch(/<w:t[^>]*>2400<\/w:t>/);
  });

  it('HTML 专项表只写 2000 个数据行 + 1 行截断说明(第三轮曾声称已做实为未做)', () => {
    const html = buildHtmlReport(M3(), SPEC, null, bigAnalysis(2500));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table')!;
    // 1 表头 + 2000 数据 + 1 截断说明
    expect(table.querySelectorAll('tr')).toHaveLength(2002);
    expect(html).not.toContain('>2400<');
    expect(html).toContain('图文报告仅列前 2000 行');
  });

  it('HTML 未超限时不加截断行(上限不误伤常规表)', () => {
    const html = buildHtmlReport(M3(), SPEC, null, bigAnalysis(10));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('table')!.querySelectorAll('tr')).toHaveLength(11);
    expect(html).not.toContain('仅列前');
  });

  it('PPT 表格幻灯片数被 20 页封顶(删掉 slice 即红)', async () => {
    const zip = await JSZip.loadAsync(await buildPptx(M3(), SPEC, {}, null, bigAnalysis(1000)));
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    // 1000 行 / 每页 14 行 = 72 页;封顶后表格页 ≤20,加封面/结论/截断页仍应远小于 72
    // 1000 行 → 未封顶时 72 页;封顶 20 页表格 + 少量固定页
    // (复审 P3:写死 23 会让任何非表格幻灯片的增减都变成假红)
    expect(slides.length).toBeGreaterThan(20);
    expect(slides.length).toBeLessThanOrEqual(26);
  });

  it('PPT 图片等比缩放:高度钳到 5.4 时宽度同步收缩(只钳高不缩宽即红)', async () => {
    // 高瘦专项图 ratio=900/400=2.25 → 未钳位时 h=25.9in,必然触发钳位
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const tallAnalysis = {
      kind: 'gagerr', title: '高瘦图', subtitle: 's', generatedAt: '2026-07-26',
      summary: ['ok'], warnings: [], tables: [],
      charts: [{ title: '六联图', svg: '<svg/>', width: 400, height: 900 }],
    } as never;
    const zip = await JSZip.loadAsync(await buildPptx(M3(), SPEC, { analysis: [png] }, null, tallAnalysis));
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const xml = (await Promise.all(names.map((n) => zip.file(n)!.async('string')))).join('');
    const exts = [...xml.matchAll(/cx="(\d+)" cy="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    // 找到那张图:cy 应为 5.4in = 4937760 EMU(钳位后)
    const clamped = exts.filter(([, cy]) => Math.abs(cy - 4937760) < 20000);
    expect(clamped.length).toBeGreaterThan(0);
    // 等比后宽 = 5.4/2.25 = 2.4in = 2194560 EMU;只钳高不缩宽会是 11.5in = 10515600
    for (const [cx] of clamped) {
      expect(cx).toBeLessThan(3000000);
      expect(Math.abs(cx - 2194560)).toBeLessThan(20000);
    }
  });

  it('Word 位图缺失时插入占位说明(删掉降级分支即红)', async () => {
    const M = computeVarModel('r.csv', ['x'], [[1], [2], [3], [4]]);
    const a = assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');
    const zip = await JSZip.loadAsync(await buildDocx(M, SPEC, {}, a));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('图表位图生成失败');
    expect(zip.file(/word\/media\//).length).toBe(0);
    // 对照:传入真实位图时必须有 media 且没有占位说明(证明上面两条有区分力)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const withImg = await JSZip.loadAsync(await buildDocx(M, SPEC, { xbar: png, dispersion: png, hist: png, prob: png }, a));
    const xml2 = await withImg.file('word/document.xml')!.async('string');
    expect(withImg.file(/word\/media\//).length).toBeGreaterThan(0);
    expect(xml2).not.toContain('图表位图生成失败');
  });

  it('Excel 明细上限 20000 行:超限截断且写明总数', () => {
    const M = computeVarModel('r.csv', ['x'], [[1], [2], [3], [4]]);
    const a = assessSpcCharts(M, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');
    const many = { ...a, events: Array.from({ length: 20005 }, (_, k) => ({ i: k, rule: 1, desc: 'x', chart: 'I' })) };
    const wb = XLSX.read(buildXlsx(M, SPEC, many as never), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets['失控点'], { header: 1 });
    expect(rows.length).toBe(1 + 20000 + 1);
  });
});

// ──────────────── 判异/绘图行为 ────────────────
describe('SPC 与绘图行为本体', () => {
  it('分阶段 R 图:段内 0 失控时页面 R 图无红点(把 set 移回 if 内即红)', () => {
    // 前 12 组极差 0.1、后 6 组极差 2:段内各自受控,但全局 R-UCL 会把后段判成超限
    const rows: number[][] = [];
    for (let i = 0; i < 12; i++) rows.push([10 + (i % 2) * 0.02, 10.1, 10, 10.1 - (i % 3) * 0.01, 10]);
    for (let i = 0; i < 6; i++) rows.push([20 + (i % 2) * 0.3, 22, 20, 21.5, 20.4]);
    useData.getState().importMatrix('分阶段.csv', ['a', 'b', 'c', 'd', 'e'], rows, [
      { name: '阶段', values: [...Array(12).fill('前'), ...Array(6).fill('后')] },
    ]);
    // 显式行式布局:列名不同的多数值列在 auto 下会被判角色歧义而不出图
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcStageCol: '阶段', spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null, spcRules: DEFAULT_SPC_RULES, spcRuleK: DEFAULT_RULE_K });
    const { container } = render(createElement(Spc, { T }));
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    // R 图(第二张)不得出现红点:段内判异为空,图必须消费空集而非回退全局限值自算
    const redInDispersion = svgs.slice(1).reduce((n, svg) => n + svg.querySelectorAll('circle[fill="#d21f26"]').length, 0);
    expect(redInDispersion).toBe(0);
    // 结论区同样写「无失控」,与图一致
    expect(container.textContent ?? '').not.toMatch(/R 图检出 [1-9]/);
  });

  it('ControlChart 契约:空集压制回退自算,不传则自算(证明上面的断言有区分力)', () => {
    const withEmpty = render(createElement(ControlChart, {
      T, data: [0.1, 0.1, 2, 2], cl: 0.1, ucl: 0.3, lcl: 0, clLabel: 'R', h: 200,
      violations: new Set<number>(),
    }));
    expect(withEmpty.container.querySelectorAll('circle[fill="#d21f26"]')).toHaveLength(0);
    const auto = render(createElement(ControlChart, {
      T, data: [0.1, 0.1, 2, 2], cl: 0.1, ucl: 0.3, lcl: 0, clLabel: 'R', h: 200,
    }));
    expect(auto.container.querySelectorAll('circle[fill="#d21f26"]').length).toBeGreaterThan(0);
  });

  it('ControlChart 失控点必留集合有 2000 上限(删掉上限即红:节点数暴涨)', () => {
    const n = 20000;
    const data = Array.from({ length: n }, (_, i) => i); // 单调上升
    const viol = new Set(Array.from({ length: n }, (_, i) => i)); // 全部失控
    const { container } = render(createElement(ControlChart, {
      T, data, cl: n / 2, ucl: n, lcl: 0, clLabel: 'X̄', h: 200, violations: viol,
    }));
    // keep 上限 2000 + 分桶抽稀 → 圆点数远小于 20000
    expect(container.querySelectorAll('circle').length).toBeLessThan(3000);
  });

  it('概率图打点是 Benard(i−0.3)/(n+0.4):与 Blom 逐位可分', () => {
    const pts = probPlotPoints([5, 1, 3, 2, 4]);
    expect(pts[0].z).toBeCloseTo(invNorm(0.7 / 5.4), 10);
    // 外部锚点(复审 P3:仅用生产 invNorm 自算属自证):Φ⁻¹(0.12963) = −1.12817(标准正态表)
    expect(pts[0].z).toBeCloseTo(-1.12817, 4);
    expect(Math.abs(pts[0].z - invNorm(0.625 / 5.25))).toBeGreaterThan(0.04); // Blom 会差 0.05
  });

  it('DOE 效应正态图同样是 Benard:cy 像素与解析式逐位吻合(改回 Blom 即红)', () => {
    const terms = [
      { name: 'A', effect: -3, sig: false }, { name: 'B', effect: -1, sig: false },
      { name: 'C', effect: 0.5, sig: false }, { name: 'D', effect: 2, sig: false },
      { name: 'E', effect: 4, sig: false },
    ];
    const h = 260;
    const { container } = render(createElement(EffectsNormalPlot, { T, terms, me: 99, h } as never));
    const cys = [...container.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cy'))).sort((a, b) => a - b);
    expect(cys).toHaveLength(5);
    // 组件几何:m.t=18, m.b=42(见 EffectsNormalPlot),ph = h − m.t − m.b;
    // zTop = max(2.2, |z|max)*1.1,Y(z) = m.t + (1 − (z + zTop)/(2·zTop))·ph
    const zOf = (pp: number) => invNorm(pp);
    const zsBenard = [0.7, 1.7, 2.7, 3.7, 4.7].map((k) => zOf(k / 5.4));
    const zsBlom = [0.625, 1.625, 2.625, 3.625, 4.625].map((k) => zOf(k / 5.25));
    const yOf = (zs: number[]) => {
      const zTop = Math.max(2.2, ...zs.map(Math.abs)) * 1.1;
      const m = { t: 22, b: 40 }; // 与 EffectsNormalPlot.tsx:32 一致
      const ph = h - m.t - m.b;
      return zs.map((z) => m.t + (1 - (z + zTop) / (2 * zTop)) * ph).sort((a, b) => a - b);
    };
    const expBenard = yOf(zsBenard);
    const expBlom = yOf(zsBlom);
    // 两公式的首点像素必须可分,否则本断言无区分力
    expect(Math.abs(expBenard[0] - expBlom[0])).toBeGreaterThan(0.5);
    cys.forEach((cy, i) => expect(cy).toBeCloseTo(expBenard[i], 3));
  });

  it('回归方程符号取斜率:导出报告对负斜率写 −(改回截距符号即红)', () => {
    useData.getState().importMatrix('回归.csv', ['X', 'Y'], [[1, 20], [2, 18], [3, 16], [4, 14], [5, 12]]);
    useApp.setState({ page: 'anova', hypoTab: 'reg', regXName: 'X', regYName: 'Y' });
    const report = buildActiveAnalysisReport();
    expect(report).toBeDefined();
    const text = (report!.summary ?? []).join(' ');
    // 真实载荷:斜率 −2、截距 22 → 必须写「22.000000 − 2.000000 × X」
    expect(text).toMatch(/−\s*2\.0+\s*×/);
    expect(text).not.toMatch(/\+\s*2\.0+\s*×/); // 取截距符号会写成 +
  });

  it('ndc 用 AIAG 常数 1.41 而非精确 √2:判别夹具上分档不同(改回 √2 即红)', () => {
    // 数值搜索得到的判别夹具:σ部件/σGRR ≈ 6.3730 → 1.41× = 8.986 → 8;√2× = 9.013 → 9
    const obs: GageObservation[] = [];
    for (let part = 0; part < 10; part++) {
      for (let operator = 0; operator < 2; operator++) {
        for (let trial = 0; trial < 3; trial++) {
          obs.push({
            part, operator, trial,
            value: part * 0.575 + operator * 0.05 + (trial - 1) * 0.3 + ((part * 7 + operator * 3 + trial) % 5) * 0.02,
          });
        }
      }
    }
    const gage = computeGageRR(obs, null);
    const ratio = gage.components.find((c) => c.key === 'part')!.sd / gage.components.find((c) => c.key === 'grr')!.sd;
    // 判别窗口 [5/√2, 5/1.41) = [3.5355,3.5461) 的 √2 倍档位;断言落在窗口内即可,
    // 不把 ratio 钉死(复审 P3:toBeCloseTo(…,3) 比判别窗口紧约 19 倍,口径微调即假红)
    expect(ratio).toBeGreaterThan(6.3640);
    expect(ratio).toBeLessThan(6.3829);
    expect(Math.floor(1.41 * ratio)).toBe(8);
    expect(Math.floor(Math.SQRT2 * ratio)).toBe(9); // 两常数在此夹具确实分档
    expect(gage.ndc).toBe(8); // 实现必须取 AIAG 的 1.41
  });
});

// ──────────────── 数据入口/安全行为 ────────────────
describe('数据入口与安全行为本体', () => {
  it('CSV 严格数值:「1O」「0x10」不再被静默取成 1/0,而是计入跳过行', () => {
    // 列内 ≥80% 为数值 → 列保留、坏行剔除(旧实现会把 1O 静默取成 1、0x10 取成 0)
    const good = Array.from({ length: 9 }, (_, i) => `${i + 1},${i + 1}`);
    const r = parseMatrix(['x,y', ...good, '1O,90', '0x10,80'].join('\n'));
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.skippedRows).toBe(2);
    expect(r.rows).toHaveLength(9);
    expect(r.colNames).toEqual(['x', 'y']);
    expect(r.rows.some(([x]) => x === 0)).toBe(false); // 0x10 → 0 的旧行为
    // 坏值占多数时列整体降级为文本列,同样不会产出被误解析的数值
    const r2 = parseMatrix(['x,y', '1,2', '1O,3', '0x10,4', '5,6'].join('\n'));
    expect('error' in r2).toBe(false); // 复审 P3:无此断言时解析器改为拒绝该输入会静默全绿
    if ('error' in r2) return;
    expect(r2.colNames).toEqual(['y']);
    expect(r2.textCols[0].values).toContain('1O');
  });

  it('xlsx 原始数值 + 日期语义(去掉 rawNumbers 或 cellDates 任一即红)', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['日期', '值'],
      [new Date(2026, 2, 15), 12345.678901234],
      [new Date(2026, 2, 16), 23456.789012345],
    ]);
    // 千分位显示格式:非 rawNumbers 时 sheet_to_csv 会输出 "12,346"
    sheet['B2'].z = '#,##0';
    sheet['B3'].z = '#,##0';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'S1');
    const out = await xlsxBytesToCsv(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
    expect('csv' in out).toBe(true);
    if (!('csv' in out)) return;
    // rawNumbers:原始全精度值,不是格式化文本
    expect(out.csv).toContain('12345.678901234');
    expect(out.csv).not.toContain('12,346');
    // cellDates:日期列仍是日期文本,不退化为 Excel 序列号(46096 之类)
    expect(out.csv).not.toMatch(/\n4[5-7]\d{3},/);
    expect(out.csv).toMatch(/\n\d{1,2}\/\d{1,2}\/\d{2,4},/);
  });

  it('stackColumns 复用 20 万行上限(删掉闸门即红)', () => {
    // 5 万行 × 5 列 = 25 万 > 20 万
    const rows = Array.from({ length: 50000 }, (_, i) => [i, i, i, i, i]);
    useData.getState().importMatrix('宽表.csv', ['a', 'b', 'c', 'd', 'e'], rows);
    expect(() => useData.getState().stackColumns()).toThrow(/行上限/);
    expect(useData.getState().model.name).toBe('宽表.csv');
  });

  it('importPareto 写入口四规则与项目校验器同口径', () => {
    const store = useData.getState();
    expect(store.importPareto('', [{ name: 'a', count: 1 }]).rejected).toBeTruthy();
    expect(store.importPareto('p', [{ name: ' ', count: 1 }]).rejected).toBeTruthy();
    expect(store.importPareto('p', [{ name: 'a', count: 0 }, { name: 'b', count: 0 }]).rejected).toBeTruthy();
    const ok = store.importPareto('p', [{ name: 'a', count: 3 }, { name: '  ', count: 1 }]);
    expect(ok.rejected).toBeUndefined();
    expect(ok.droppedRows).toBe(1);
    // 落盘载荷必须能通过项目校验器(这是本条修复的真实目的)
    expect(projectStoreValidationError('qp-pareto-v1', useData.getState().paretoModel)).toBeNull();
  });

  it('MES:切换到「同名」数据集后 tick 也不追加(只有名称/意图守卫能拦,mesRunning 标志拦不住)', () => {
    vi.useFakeTimers();
    try {
      useData.getState().importMatrix('MES 实时采集', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]]);
      mesStart();
      vi.advanceTimersByTime(1700);
      const grown = useData.getState().model.k;
      expect(grown).toBeGreaterThan(2);
      // 关键:重新导入「同名」数据集——mesRunning 仍为 true 的分支下,
      // 只有 importMatrix 经 beginDatasetReplacement 置位才能阻止污染
      useData.getState().importMatrix('MES 实时采集', ['a', 'b', 'c', 'd', 'e'], [[7, 7, 7, 7, 7], [8, 8, 8, 8, 8], [9, 9, 9, 9, 9]]);
      const k0 = useData.getState().model.k;
      expect(k0).toBe(3);
      vi.advanceTimersByTime(4000);
      expect(useData.getState().model.k).toBe(3); // 一行都不许追加
      expect(useData.getState().model.subs[0].vals[0]).toBe(7);
      expect(useData.getState().model.n).toBe(5); // 列结构与 MES 子组一致,列数守卫不参与——检验的确实是闸门
      expect(useData.getState().mesRunning).toBe(false);
    } finally { mesStop(); vi.useRealTimers(); }
  });

  it('不变量守护:遍历 dataStore 全部动作,替换活动数据集的必须过闸门(新增动作默认被检查)', () => {
    const src = readFileSync('src/store/dataStore.ts', 'utf8');
    // 自审 P2:动作清单的真值源改为 **DataState 接口声明**——正则扫实现体会漏掉
    // `name: identifier,` 等写法(新动作静默放行),扫得太宽又会把对象字面量键当成动作。
    const ifaceStart = src.indexOf('interface DataState {');
    expect(ifaceStart).toBeGreaterThan(0);
    const iface = src.slice(ifaceStart, src.indexOf('\n}', ifaceStart));
    // 接口里的方法声明:`name(...): T;` 或 `name: (...) => T;`
    const declared = [...iface.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*(?:\(|:\s*\()/gm)].map((m) => m[1]);
    expect(declared.length, 'DataState 接口方法解析失败').toBeGreaterThan(20);
    // 实现体:按顶层属性起始位置切块
    const implRe = /^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(?:async\s+)?(?:\(|function\b)/gm;
    const marks: Array<{ name: string; at: number }> = [];
    for (let m = implRe.exec(src); m; m = implRe.exec(src)) marks.push({ name: m[1], at: m.index });
    // 接口声明的每个方法都必须能在实现里找到(改名/删除会被抓到)
    const implNames = new Set(marks.map((m) => m.name));
    const notImplemented = declared.filter((d) => !implNames.has(d));
    expect(notImplemented, `接口声明了但实现扫描没找到(写法超出扫描能力):${notImplemented.join('、')}`).toEqual([]);
    const bodyOf = (i: number) => src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    // 白名单 = 明确「不替换活动数据集」的动作。新增动作不在此列 → 默认要求过闸门,
    // 必须显式加白名单才能豁免(复审 P2:旧版是硬编码 10 个名字,32 个动作里 22 个从不检查)。
    // 白名单 = 逐个确认「不替换活动分析数据集」的动作(改名/删除会被下方 stale 检查抓到)
    const EXEMPT = new Set([
      // 内部工具/生命周期
      'beforeMutation', 'beforeExport', 'projectStoreOverrides',
      // 同数据集内编辑
      'updateCell', 'addSubgroupRow', 'deleteRow', 'undoEdit', 'redoEdit', 'sortBy',
      'renameColumn', 'deleteColumn', 'insertColumn', 'addFormulaColumn', 'findReplace',
      'writeAnalysisColumns',
      // 最近列表 / 帕累托模型(不动变量数据集)
      // importPareto 只停 MES、不推进 datasetIntentRevision(帕累托模型独立于工作表),
      // 单独由下方「importPareto 只停采不作废在途恢复」一条守护
      'removeRecent', 'clearPareto', 'importPareto',
      // MES 自身路径(过闸门会自杀)
      'startMesDataset', 'appendSubgroup', 'setMesRunning',
    ]);
    const missing: string[] = [];
    marks.forEach((mk, i) => {
      if (!declared.includes(mk.name) || EXEMPT.has(mk.name)) return;
      const body = bodyOf(i);
      // 自审 P3:注释里出现该调用不算过闸门,先剥注释
      const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const gated = code.includes('beginDatasetReplacement()')
        || /get\(\)\.(importMatrix|importCounts|importPareto|loadRecent)\(/.test(code);
      if (!gated) missing.push(mk.name);
    });
    expect(missing, `以下动作未过数据集替换闸门,也不在豁免名单:${missing.join('、')}`).toEqual([]);
    // 豁免名单本身也要真存在,防止改名后白名单静默失效
    const names = new Set(marks.map((m) => m.name));
    const stale = [...EXEMPT].filter((n) => !names.has(n));
    expect(stale, `豁免名单里已不存在的动作:${stale.join('、')}`).toEqual([]);
  });

  it('闸门行为本体:每个导入类动作在 MES 运行中被调用都会自停(源码扫描的行为背书)', () => {
    vi.useFakeTimers();
    try {
      const calls: Array<[string, () => void]> = [
        ['importMatrix', () => useData.getState().importMatrix('A', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]])],
        ['importCounts', () => useData.getState().importCounts('p', 'B', [1, 2, 3], 50)],
        ['resetDemo', () => useData.getState().resetDemo()],
        ['newWorksheet', () => useData.getState().newWorksheet()],
        ['saveAsCopy', () => useData.getState().saveAsCopy()],
      ];
      for (const [label, run] of calls) {
        useData.getState().importMatrix('种子', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]]);
        mesStart();
        vi.advanceTimersByTime(1700);
        expect(useData.getState().mesRunning, `${label} 前 MES 未启动`).toBe(true);
        run();
        expect(useData.getState().mesRunning, `${label} 未停掉 MES 采集`).toBe(false);
        mesStop();
      }
    } finally { mesStop(); vi.useRealTimers(); }
  });

  it('MES:切换到异名数据集同样自停', () => {
    vi.useFakeTimers();
    try {
      useData.getState().importMatrix('真实A.csv', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]]);
      mesStart();
      vi.advanceTimersByTime(1700);
      useData.getState().importMatrix('真实B.csv', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3]]);
      const k0 = useData.getState().model.k;
      vi.advanceTimersByTime(4000);
      expect(useData.getState().model.k).toBe(k0);
      expect(useData.getState().mesRunning).toBe(false);
    } finally { mesStop(); vi.useRealTimers(); }
  });

  it('隔离区:二次损坏保首份证据,且隔离区自身始终通过项目校验器', () => {
    preserveCorruptStore('qp-pareto-v1', '{"first":1}', '首次损坏');
    preserveCorruptStore('qp-pareto-v1', '{"second":2}', '二次损坏');
    const map = JSON.parse(localStorage.getItem(QUARANTINE_STORAGE_KEY) ?? '{}');
    expect(Object.keys(map)).toEqual(['qp-pareto-v1']);
    expect(map['qp-pareto-v1'].raw).toBe('{"first":1}'); // 首份证据保留
    // 关键:隔离区自身必须能过校验器,否则 .qproj 导出会被整体阻断
    expect(projectStoreValidationError(QUARANTINE_STORAGE_KEY, map)).toBeNull();
  });

  it('隔离区:非白名单 key 不进隔离区,但也不阻断该 key 的写入', () => {
    preserveCorruptStore('qp-pareto-v1', '{"a":1}', '合法');
    // 自审 P2:返回 false 会让 dataStore 把该 key 永久挂进写保护、提示还错报「存储已满」
    const ok = preserveCorruptStore('随便一个key', '{"b":2}', '非白名单');
    expect(ok, '非白名单 key 不该触发写保护').toBe(true);
    const map = JSON.parse(localStorage.getItem(QUARANTINE_STORAGE_KEY) ?? '{}');
    expect(Object.keys(map)).toEqual(['qp-pareto-v1']);
    expect(projectStoreValidationError(QUARANTINE_STORAGE_KEY, map)).toBeNull();
  });
});

// ──────────────── 本批 P1 修复的行为守护(终审指出此前零覆盖) ────────────────
describe('闭环批 P1 守护', () => {
  it('tickDecimals 钳位:次正规/常量列不抛错,且 1e-11~1e-100 量程刻度不被压塌', () => {
    // 抛错侧:钳位缺失时 toFixed 收到 324/Infinity 位直接 RangeError
    const subnormal = [1e-320, 2e-320, 3e-320];
    const markup = renderToStaticMarkup(createElement(Histogram, {
      T, data: subnormal, mu: 2e-320, sigmaWithin: 1e-321, sigmaOverall: 1e-321,
      lsl: null, usl: null, tgt: 2e-320, h: 210,
    } as never));
    // 复审 P2:旧版只断言 not.toThrow,而实际产物里全部柱子是 y="NaN" height="NaN"
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('Infinity');
    // 正态曲线不得因非有限点被整条丢弃。
    // 如实说明:pdf 的方差守卫与 polyline 的有限性过滤互为兜底,单独撤掉任一层本用例都不转红;
    // 本夹具真正守住的是 Histogram 的 lo/hi 溢出域钳位(见下方 rect 断言)。
    const curves = [...markup.matchAll(/points="([^"]*)"/g)].map((m) => m[1].trim());
    expect(curves.length).toBeGreaterThan(0);
    for (const pts of curves) expect(pts.split(' ').filter(Boolean).length).toBeGreaterThan(10);
    // 极端量程夹具:守住 lo/hi 溢出域钳位(polyline 过滤那一层由 pdf 兜底,单独不可检)
    const wide = renderToStaticMarkup(createElement(Histogram, {
      T, data: [-1e308, 0, 1e308], mu: 0, sigmaWithin: 1e307, sigmaOverall: 1e307,
      lsl: null, usl: null, tgt: 0, h: 210,
    } as never));
    expect(wide).not.toContain('NaN');
    expect(wide).not.toContain('Infinity');
    // 自审 P3:去掉溢出域守卫后 hi-lo=Infinity,柱子 x/width 全是 NaN;
    // 但仅断言「不含 NaN」不足以区分(polyline 过滤会吞掉),再断言柱子确实画出来了
    const rects = [...wide.matchAll(/<rect[^>]*x="([-\d.]+)"[^>]*width="([-\d.]+)"/g)]
      .map(([, x, w]) => ({ x: Number(x), w: Number(w) }));
    // 排除整幅背景矩形(w≈960),只看柱子
    const bars = rects.filter((r) => r.w < 900);
    expect(bars.length, '柱子未渲染').toBeGreaterThan(0);
    // 溢出域守卫失效 → hi-lo=Infinity → t 全为 NaN → 所有柱子塌到同一个 x
    // (X 的钳位把 NaN 兜成 0,不抛错也不留 NaN,故必须断言「分布开」而非「非 NaN」)
    expect(new Set(bars.map((r) => Math.round(r.x))).size, `柱子全部塌在同一位置:${bars.map((r) => r.x).join(',')}`).toBeGreaterThan(3);
    for (const r of bars) {
      expect(Number.isFinite(r.x)).toBe(true);
      expect(r.x + r.w, `柱子越出画布:right=${r.x + r.w}`).toBeLessThanOrEqual(961);
    }
    // 可用性侧:钳到 10 会把这段量程的刻度全压成同一标签(闭环终审 P2)
    expect(tickDecimals([1e-15, 1e-15 + 1e-22, 1e-15 + 2e-22])).toBeGreaterThan(10);
    expect(tickDecimals([1e-15, 1e-15 + 1e-22, 1e-15 + 2e-22])).toBeLessThanOrEqual(100);
    expect(tickDecimals([0, 0, 0])).toBe(0); // step<=0 → 0 位
    // 可读性由 tickFormatter 负责(复审 P3:钳到 100 只是把 RangeError 换成不可读标签)
    expect(tickLabel(1.5e20, 0)).toBe('1.5e20');
    expect(tickLabel(-0, 2)).not.toMatch(/^-/); // 不得印出「-0」/「-0.00」
    // 常规量程走定点;保真度要求下位数由「标签必须还原到真值」决定,不再是死板的 dp
    expect(tickLabel(12.3456, 2)).not.toMatch(/e-?\d/);
    expect(Number(tickLabel(12.3456, 2))).toBeCloseTo(12.3456, 3);
  });

  it('描述统计导出侧 tgtLabel:直方图规格线标「均值」而非「目标」', () => {
    useData.getState().importMatrix('描述.csv', ['测量'], [[1], [2], [3], [4], [5], [6], [7], [8]]);
    useApp.setState({ page: 'summary', activeVar: '测量' });
    const report = buildActiveAnalysisReport();
    const svg = (report?.charts ?? []).map((c) => c.svg).join('');
    expect(svg).toContain('均值');
    expect(svg).not.toContain('>目标<');
  });

  it('DOE 混杂交互提示:页面三分支与导出报告同源(恒 null 即红)', () => {
    const note = confoundedInteractionNote([
      { term: 'B×D', with: '区组 2', relation: 'same' },
      { term: 'A×B×C', with: '区组 2', relation: 'same' },
    ]);
    expect(note).toContain('B×D');
    expect(note).toContain('无法检验');
    expect(confoundedInteractionNote([])).toBeNull();
    expect(confoundedInteractionNote(undefined)).toBeNull();
    // 自审 P2/P3:源码切片 + 别名白名单三轮都被证明空洞(保形重写一律绕过)。
    // 结论文本已下沉到 core 的 buildDoeConclusion,可直接构造四种 status 做**行为断言**。
    const aliases = [
      { term: 'B×D', with: '区组 2', relation: 'same' as const },
      { term: 'A×B×C', with: '区组 2', relation: 'same' as const },
    ];
    const base = {
      aliases, hasSignificantInteraction: false, sigTermNames: ['A', 'B'],
      detail: '残差自由度 4', factorCount: 4, respName: 'Y', settings: 'A=+1', tieCount: 3, fixedSettings: 'A=+1',
    };
    const STATUSES = ['no-significant-effect', 'significant-curvature', 'tied', 'unique'] as const;
    for (const status of STATUSES) {
      const text = buildDoeConclusion({ ...base, status });
      expect(text, `分支 ${status} 未带混杂提示`).toContain('无法检验');
      expect(text).toContain('B×D');
    }
    // 对照:无别名时四个分支都不得出现该提示(证明断言有区分力)
    for (const status of STATUSES) {
      const text = buildDoeConclusion({ ...base, status, aliases: [] });
      expect(text, `分支 ${status} 在无别名时仍报混杂`).not.toContain('无法检验');
    }
    // 显著交互时:tied/unique 分支改说「已综合显著交互作用」
    for (const status of ['tied', 'unique'] as const) {
      const text = buildDoeConclusion({ ...base, status, hasSignificantInteraction: true });
      expect(text).toContain('已综合显著交互作用');
    }
  });
});

// ──────────────── 终审补:第三份箱线实现与 project 错误消息 ────────────────
describe('终审整改守护', () => {
  it('描述统计页箱线与共享实现逐位一致(第三份独立须端即红)', () => {
    // [0,0,0,0,0,1000]:共享实现 whiskerHi=q3=250;旧的「最内侧实测值」给 0(须反向)
    const data = [0, 0, 0, 0, 0, 1000];
    const box = boxplotStats(data);
    expect(box.whiskerHi).toBeCloseTo(box.q3, 10);
    useData.getState().importMatrix('箱线.csv', ['测量'], data.map((v) => [v]));
    useApp.setState({ page: 'summary', activeVar: '测量' });
    const { container } = render(createElement(Summary, { T }));
    // 页面须端线段的 x 必须落在 q3 对应位置而非 0(用 SVG 线段坐标反查)
    const lines = [...container.querySelectorAll('svg line')].map((l) => ({
      x1: Number(l.getAttribute('x1')), x2: Number(l.getAttribute('x2')),
    }));
    expect(lines.length).toBeGreaterThan(0);
    // 上须:从 q3 向右延伸到 whiskerHi;两者相等时线段长度为 0——旧实现会反向(x2 < x1)
    const reversed = lines.filter((l) => l.x2 < l.x1 - 0.5);
    expect(reversed).toHaveLength(0);
  });

  it('帕累托类别上限守卫真实生效(禁用即红)', () => {
    const names = Array.from({ length: 60001 }, (_, i) => `类${i}`).join(',');
    const counts = Array.from({ length: 60001 }, () => '1').join(',');
    for (const text of [
      Array.from({ length: 60001 }, (_, i) => `类${i},1`).join('\n'), // 默认两列
      `${names}\n${counts}`,                                          // 横排转置
    ]) {
      const r = parseCategoryCounts(text);
      expect('error' in r && r.error).toContain('类别数超过');
    }
  });

  it('standardize 的有限性屏障有 UI 兜底:菜单入口不产生未捕获异常并给出 toast', () => {
    useData.getState().importMatrix('极值.csv', ['C1', 'C2'], [[-1e308, 1], [1e308, 2], [1, 3]]);
    // core 屏障真实触发
    expect(() => useData.getState().standardize()).toThrow();
    const before = useData.getState().model.name;
    // 菜单入口:渲染 MenuBar 并点「标准化」,断言无未捕获异常、有 toast、数据未被替换
    const toasts: string[] = [];
    const origToast = useApp.getState().showToast;
    useApp.setState({ showToast: (t: string) => { toasts.push(t); } });
    try {
      const { container } = render(createElement(MenuBar, { wsName: '极值.csv' }));
      // 「标准化（列 z-score）」在「计算」菜单下
      const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '计算');
      expect(btn, '未找到「计算」菜单').toBeTruthy();
      fireEvent.click(btn!);
      const item = [...document.querySelectorAll('button, [role="menuitem"]')]
        .find((b) => (b.textContent ?? '').includes('标准化'));
      expect(item, '未找到「标准化」菜单项').toBeTruthy();
      expect(() => fireEvent.click(item!)).not.toThrow(); // 不自带 catch:未捕获异常即红
      expect(toasts.some((t) => t.length > 0), '未给出任何提示').toBe(true);
      expect(useData.getState().model.name).toBe(before); // 失败时不得替换数据集
    } finally {
      useApp.setState({ showToast: origToast });
    }
  });

  it('project 错误消息用 errText:Tauri 字符串拒绝不再被吞成「未知错误」', () => {
    const src = readFileSync('src/platform/project.ts', 'utf8');
    // 不得再有独立的 instanceof Error 三元实现(那正是把字符串拒绝吞掉的写法)
    expect(src).not.toMatch(/error instanceof Error && error\.message \? error\.message : '未知错误'/);
    expect(src).toContain('const errorMessage = errText;');
    // errText 本体对字符串拒绝给原文
    expect(errText('db_put_dataset failed: disk full')).toBe('db_put_dataset failed: disk full');
    expect(errText(new Error('boom'))).toBe('boom');
    // 兜底(复审 P2:此前空 message / 非 Error 会显示 undefined、[object Object])
    expect(errText(new Error(''))).toBe('未知错误');
    expect(errText(undefined)).toBe('未知错误');
    expect(errText(null)).toBe('未知错误');
    expect(errText('')).toBe('未知错误');
    expect(errText(Object.create(null))).toBe('未知错误'); // String() 会抛,必须被吞住
  });
});

// ──────────────── 独立复审整改守护 ────────────────
describe('复审整改守护', () => {
  const zeroVarStudy = () => {
    const obs: GageObservation[] = [];
    for (let part = 0; part < 5; part++) {
      for (let operator = 0; operator < 2; operator++) {
        for (let trial = 0; trial < 3; trial++) obs.push({ part, operator, trial, value: 0.1 + part * 0.7 });
      }
    }
    return obs;
  };

  it('零测量变异:不得判出「显著交互」,ndc 为 ∞(精确零守卫拦不住浮点残渣)', () => {
    const g = computeGageRR(zeroVarStudy(), null);
    // ssError/ssInter 都是 1e-31 量级的浮点残渣,不是精确 0
    expect(g.interaction).not.toBeNull();
    expect(g.interaction!.pValue).toBe(1);
    expect(g.interaction!.fStat).toBe(0);
    expect(g.interaction!.retained).toBe(false);
    expect(g.ndc).toBe(Infinity);
    expect(g.components.find((c) => c.key === 'grr')!.sd).toBeLessThan(1e-12);
  });

  it('ndc 对单位缩放不变:同一研究换记录单位,ndc 逐位相同(绝对下限兜底即红)', () => {
    // 自审 P2:vGRR/vTotal 已还原到原始单位,判据里加 Math.max(vTotal,1) 会让
    // vTotal<1 时退化成绝对阈值 → 同一份研究以「米」记录 ndc=∞、以「毫米」记录 ndc=22
    const study = (k: number): GageObservation[] => {
      const out: GageObservation[] = [];
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
      for (let part = 0; part < 10; part++) {
        for (let operator = 0; operator < 3; operator++) {
          for (let trial = 0; trial < 3; trial++) {
            out.push({ part, operator, trial, value: (50 + part * 0.03 + rnd() * 0.02) * k });
          }
        }
      }
      return out;
    };
    const base = computeGageRR(study(1), null);
    expect(base.ndc).toBeGreaterThan(1);
    expect(Number.isFinite(base.ndc)).toBe(true);
    for (const k of [1e-3, 1e-6, 1e-9, 1e3, 1e6]) {
      const g = computeGageRR(study(k), null);
      expect(g.ndc, `单位 ×${k} 时 ndc 变了`).toBe(base.ndc);
      expect(g.totalGageRR).toBeCloseTo(base.totalGageRR, 9);
      expect(g.interaction!.pValue).toBeCloseTo(base.interaction!.pValue, 9);
    }
  });

  it('importPareto 只停 MES,不推进数据集意图版本(帕累托模型独立于工作表)', () => {
    vi.useFakeTimers();
    try {
      useData.getState().importMatrix('工作表', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]]);
      mesStart();
      vi.advanceTimersByTime(1700);
      expect(useData.getState().mesRunning).toBe(true);
      const wsBefore = useData.getState().model.name; // mesStart 会改名为「MES 实时采集」
      const kBefore = useData.getState().model.k;
      useData.getState().importPareto('缺陷', [{ name: '划伤', count: 3 }]);
      // 停采:MES 会往工作表追加,帕累托导入后不应继续
      expect(useData.getState().mesRunning).toBe(false);
      // 工作表本身不受影响
      expect(useData.getState().model.name).toBe(wsBefore);
      expect(useData.getState().model.k).toBe(kBefore);
      // 不得推进 datasetIntentRevision(模块内变量,不可直接读)——源码约定:
      // importPareto 不调 beginDatasetReplacement,否则在途的 loadRecent/vault 恢复被作废
      const src = readFileSync('src/store/dataStore.ts', 'utf8');
      const at = src.indexOf('importPareto: (');
      const body = src.slice(at, src.indexOf('\n  clearPareto', at) > 0 ? src.indexOf('\n  clearPareto', at) : at + 2000);
      const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code.includes('beginDatasetReplacement()'), 'importPareto 不应推进数据集意图版本').toBe(false);
      expect(code.includes('setMesRunning(false)'), 'importPareto 应停掉模拟采集').toBe(true);
    } finally { mesStop(); vi.useRealTimers(); }
  });

  it('隔离区二次损坏后持久化通道仍通(返回 false 会永久锁死该 key)', () => {
    // 自审 P1:返回值语义是「证据是否已安全保存」,不是「本次原文是否写入」。
    // 返回 false 会让 dataStore 的 protectedCorruptStores 永远清不掉 → saveJson
    // 对该 key 永久失败,.qproj 导出被锁死,且提示错报「存储已满」。
    expect(preserveCorruptStore('qp-pareto-v1', '{"first":1}', '首次')).toBe(true);
    expect(preserveCorruptStore('qp-pareto-v1', '{"second":2}', '二次')).toBe(true);
    const map = JSON.parse(localStorage.getItem(QUARANTINE_STORAGE_KEY) ?? '{}');
    expect(map['qp-pareto-v1'].raw).toBe('{"first":1}'); // 首份证据仍是首份
    // 返回值语义 = 「是否可以安全覆盖 live 值」。非白名单 key 不属项目持久化范围,
    // 跳过存证但**不得阻断写入**(自审 P2:返回 false 会让 dataStore 永久锁死该 key)
    expect(preserveCorruptStore('不在白名单的key', '{"x":1}', '非法')).toBe(true);
    // 真正失败的情形(配额满,连证据都没保住)才返回 false —— 见「配额满」用例
  });

  it('正态概率图主渲染路径有具名 aria-label(此前只加在「无数据」降级分支上)', () => {
    const markup = renderToStaticMarkup(createElement(NormalProbPlot, {
      T, data: [1, 2, 3, 4, 5, 6, 7, 8], h: 260,
    } as never));
    expect(markup).toContain('aria-label="正态概率图"');
    expect(markup).not.toContain('aria-label="统计图表"');
    // 空数据降级分支同样具名(两条路径都要有)
    const empty = renderToStaticMarkup(createElement(NormalProbPlot, { T, data: [], h: 260 } as never));
    expect(empty).toContain('aria-label="正态概率图"');
  });

  it('median 与 minitabQuantile 逐位一致,且能区分旧实现(夹具须能真产出反例)', () => {
    // 自审 P2:旧夹具用 LCG `seed*1103515245` 超出 2^53,双精度静默丢低位 → 有效尾数
    // 只有 ~35 位,a+b 永远精确无舍入,两种写法按构造逐位相同,守护恒真。
    // 改用 mulberry32(Math.imul,32 位整数安全)+ 跨量级取值,保证尾数满 53 位。
    let a = 0x9e3779b9;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // 旧实现基线(本地写死,不引用被测代码)——两者出现分歧才说明夹具有区分力
    const legacyMedian = (xs: number[]) => {
      const sorted = [...xs].sort((x, y) => x - y);
      const n = sorted.length;
      return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    };
    let divergences = 0;
    for (let k = 0; k < 3000; k++) {
      const n = 2 + (k % 9);
      const scale = 10 ** (-9 + (k % 19)); // 1e-9 ~ 1e9,覆盖真实测量量级
      const xs = Array.from({ length: n }, () => (rnd() - 0.5) * scale);
      const sorted = [...xs].sort((x, y) => x - y);
      expect(median(xs)).toBe(minitabQuantile(sorted, 0.5)); // 薄封装:逐位相等
      if (legacyMedian(xs) !== median(xs)) divergences++;
    }
    // 夹具自检:必须真能产出与旧实现的分歧,否则这条断言毫无区分力
    expect(divergences).toBeGreaterThan(0);
  });

  it('公式引擎的 median() 与 core median 同源(第三份实现即红)', () => {
    // 自审 P3:formula.ts 曾是第三份实现,同一列数据两条路径差 1ulp
    const col = [0.000005231015185600601, 0.00005792198304901877];
    useData.getState().importMatrix('中位数.csv', ['C1'], col.map((v) => [v]));
    const err = useData.getState().addFormulaColumn('中位', 'median(C1)');
    expect(err).toBeNull();
    const m = useData.getState().model;
    const computed = m.subs[0].vals[m.colNames.indexOf('中位')];
    expect(computed).toBe(median(col)); // 逐位相等,不是 toBeCloseTo
  });

});

// ──────────────── 自审整改:刻度记数法(轴级 + 渲染级) ────────────────
describe('刻度记数法守护', () => {
  const AXIS_CASES: Array<[string, number, number]> = [
    ['公差量级', 0.00005, 0.0002],
    ['常规量级', 1, 100],
    ['大数量级', 1e5, 1e7],
    ['极小量级', 1e-15, 3e-15],
    ['跨零', -0.0001, 0.0001],
  ];

  it('整轴统一记数法:同一坐标轴不得混用定点与指数,且标签两两可分', () => {
    for (const [name, lo, hi] of AXIS_CASES) {
      const ticks = niceTicks(lo, hi, 6);
      const labels = ticks.map(tickFormatter(ticks));
      const withExp = labels.filter((l) => /e-?\d/.test(l)).length;
      // 自审 P2:阈值曾按单个刻度判定 → 首个刻度切指数、其余定点
      expect(withExp === 0 || withExp === labels.length, `${name} 同轴混用了两种记数法:${labels.join(' | ')}`).toBe(true);
      // 自审 P2:指数分支曾固定 3 位有效数字丢弃 dp → 把 tickDecimals 刚保住的刻度重新压塌
      expect(new Set(labels).size, `${name} 刻度标签重复:${labels.join(' | ')}`).toBe(labels.length);
      for (const l of labels) expect(l.length, `${name} 标签过长:${l}`).toBeLessThan(16);
    }
  });

  it('指数模式的尾数位数随步长推出(固定 3 位有效数字即红)', () => {
    // 相对步长 1e-3 量级:固定 2 位小数的 toExponential 会把 5 个刻度压成同一串
    const ticks = [1.0000e-15, 1.0005e-15, 1.0010e-15, 1.0015e-15, 1.0020e-15];
    const labels = ticks.map(tickFormatter(ticks));
    expect(new Set(labels).size, `尾数位数不足,标签重复:${labels.join(' | ')}`).toBe(labels.length);
    for (const l of labels) expect(l).toMatch(/e-15$/);
  });

  it('直方图 X 轴刻度密度:常见工厂量程不得少于 5 个刻度', () => {
    // 闭环 P3:niceTicks 目标 6 经圆整后常只剩 3~4 个;已提到 8
    for (const [name, data] of [
      ['Ra', Array.from({ length: 50 }, (_, i) => 0.4 + (i % 13) * 0.1)],
      ['扭矩', Array.from({ length: 50 }, (_, i) => 10.5 + (i % 13) * 0.25)],
      ['无规格', Array.from({ length: 50 }, (_, i) => 6.5 + (i % 13) * 6.5)],
    ] as Array<[string, number[]]>) {
      const mu = data.reduce((a, b) => a + b, 0) / data.length;
      const markup = renderToStaticMarkup(createElement(Histogram, {
        T, data, mu, sigmaWithin: 1, sigmaOverall: 1, lsl: null, usl: null, tgt: mu, h: 210,
      } as never));
      const axis = [...markup.matchAll(/<text[^>]*y="196"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      expect(axis.length, `${name} X 轴刻度过少:${axis.join(' | ')}`).toBeGreaterThanOrEqual(5);
      expect(new Set(axis).size, `${name} X 轴刻度重复`).toBe(axis.length);
    }
  });

  it('正常工厂量程仍走定点(指数记数不得误伤 0.00005~0.0002 这类公差)', () => {
    const ticks = niceTicks(0.00005, 0.0002, 6);
    const labels = ticks.map(tickFormatter(ticks));
    for (const l of labels) expect(l).not.toMatch(/e-?\d/);
  });

  it('渲染级接线:各图表轴标签都经过 tickFormatter(留一处 nf 即红)', () => {
    // 闭环 P2:此前标题写 6 处、实际只渲染 3 处;ScatterPlot/EffectsNormalPlot/MiniHist 零覆盖
    const tiny = Array.from({ length: 20 }, (_, i) => 1e-15 + i * 1e-17);
    const extra = [
      renderToStaticMarkup(createElement(ScatterPlot, { T, xs: tiny, ys: tiny, slope: 1, intercept: 0, h: 240 } as never)),
      renderToStaticMarkup(createElement(EffectsNormalPlot, {
        T, terms: [{ name: 'A', effect: 1e-15 }, { name: 'B', effect: 2e-15 }, { name: 'C', effect: 3e-15 },
          { name: 'D', effect: 4e-15 }, { name: 'E', effect: 5e-15 }], pse: 1e-16, h: 260,
      } as never)),
      renderToStaticMarkup(createElement(MiniHist, { T, data: tiny, h: 200 } as never)),
    ];
    for (const mk of extra) {
      const ts = [...mk.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((t) => /^[-+]?[\d.]/.test(t));
      expect(ts.length).toBeGreaterThan(2);
      // 自审:黑名单式断言(比对写死的旧串)换个位数就逃逸;改为性质断言。
      // 一张图有 X/Y 两条轴,必须**按轴分组**再判重复(X 轴共享 y 坐标,Y 轴共享 x 坐标)。
      expect(ts.length).toBeGreaterThan(2);
      for (const t of ts) expect(t.length, `轴标签过长:${t}`).toBeLessThan(16);
      for (const [axisKey, group] of axisGroups(mk)) {
        if (group.length < 2) continue;
        expect(new Set(group).size, `${axisKey} 轴标签重复:${group.join(' | ')}`).toBe(group.length);
        const withE = group.filter((t) => /e-?\d/.test(t)).length;
        const nonZero = group.filter((t) => t !== '0').length;
        expect(withE === 0 || withE === nonZero, `${axisKey} 轴混用记数法:${group.join(' | ')}`).toBe(true);
      }
    }

    // 自审 P2:上一批只改了 helper,6 处图表接线零覆盖——正是「半边修」的对偶形态
    const ppm = Array.from({ length: 30 }, (_, i) => 0.0000012 + (i % 7) * 1e-9);
    const marks = [
      renderToStaticMarkup(createElement(Histogram, {
        T, data: ppm, mu: 0.0000015, sigmaWithin: 2e-9, sigmaOverall: 2e-9,
        lsl: null, usl: null, tgt: 0.0000015, h: 210,
      } as never)),
      renderToStaticMarkup(createElement(NormalProbPlot, { T, data: ppm, h: 240 } as never)),
      renderToStaticMarkup(createElement(ControlChart, {
        T, data: ppm, cl: 0.0000015, ucl: 0.0000021, lcl: 0.0000009, clLabel: 'X̄', h: 200,
        violations: new Set<number>(),
      } as never)),
    ];
    // 现代/高对比主题的 Y 轴走的是另一条分支,必须同样迁移(自审 P2:上一批只改了经典)
    for (const style of ['现代', '高对比'] as const) {
      const T2 = chartTokens(style, false);
      const mk = renderToStaticMarkup(createElement(ControlChart, {
        T: T2, data: ppm, cl: 0.0000015, ucl: 0.0000021, lcl: 0.0000009, clLabel: 'X̄', h: 200,
        violations: new Set<number>(),
      } as never));
      const ts = [...mk.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      const axisNums = ts.filter((t) => /^[-+]?[\d.]/.test(t));
      const collapsed2 = axisNums.filter((t) => t === '0.000' || t === '0.00' || t === '0');
      expect(collapsed2.length, `${style} 主题 Y 轴刻度塌陷:${axisNums.join(' | ')}`).toBeLessThan(2);
    }
    for (const markup of marks) {
      const texts = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      const numeric = texts.filter((t) => /^[-+]?[\d.]/.test(t) && t.length > 0);
      expect(numeric.length).toBeGreaterThan(2);
      // ppm 量级下若仍走 nf(v, 3) 会全部塌成「0.000」/「0」
      for (const t of numeric) expect(t.length, `刻度标签过长:${t}`).toBeLessThan(16);
      expect(numeric.filter((t) => /^-0(\.0*)?$/.test(t)), '印出了 -0').toEqual([]);
      for (const [axisKey, group] of axisGroups(markup)) {
        if (group.length < 2) continue;
        expect(new Set(group).size, `${axisKey} 刻度重复:${group.join(' | ')}`).toBe(group.length);
      }
    }
  });

  it('源码约定:图表目录不得直接调用/导入 tickDecimals(刻度位数只能经 tickFormatter)', () => {
    // 自审 P3:旧正则只认 `nf(…dp|dec|xDp|yDp|d)` 一种字面写法,换个变量名就绕过。
    // 改为语义约定:图表目录一律不得再引入 tickDecimals(刻度位数只能经 tickFormatter)。
    const dir = 'src/ui/charts';
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    const offenders = files.filter((f) => {
      // 剥注释后再判:注释里提到函数名不算违约
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return /\btickDecimals\s*\(/.test(code) || /\btickDecimals\b\s*[,}]/.test(code);
    });
    expect(offenders, `图表不得直接使用 tickDecimals(请改用 tickFormatter):${offenders.join('、')}`).toEqual([]);
  });
});

// ──────────────── 闭环验证整改守护 ────────────────
describe('闭环整改守护', () => {
  it('轴刻度位数不虚增:常规量程 + dec=4 时三主题都不得出现「10.0000」这类填充零', () => {
    // 闭环 P1:tickFormatter 吃了 cfg.dec 作 minDp,EWMA/CUSUM(dec=4)的轴从「10 | 15」
    // 虚增成「10.0000 | 15.0000」。现有「不得塌陷」断言查不出反方向,故另立一条夹住。
    const data = Array.from({ length: 20 }, (_, i) => 10 + (i % 5));
    for (const style of ['经典', '现代', '高对比'] as const) {
      const markup = renderToStaticMarkup(createElement(ControlChart, {
        T: chartTokens(style, style === '经典'), data, cl: 12, ucl: 16, lcl: 8,
        clLabel: 'X̄', h: 200, dec: 4, violations: new Set<number>(),
      } as never));
      const nums = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
        .map((m) => m[1]).filter((t) => /^-?\d+(\.\d+)?$/.test(t));
      expect(nums.length).toBeGreaterThan(3);
      // 整数量程的轴刻度不该带 4 位小数
      const inflated = nums.filter((t) => /\.\d{3,}$/.test(t));
      expect(inflated, `${style} 主题轴刻度位数虚增:${nums.slice(0, 6).join(' | ')}`).toEqual([]);
    }
  });

  it('点提示/限值位数不被近似值逼爆(把 cl/ucl/lcl 混进 dp 推导即红)', () => {
    // 闭环:chartNum 曾把限值混进 dp 推导,某个限值与刻度相差 1e-15 就把自动升位
    // 逼到 15 位,点提示变成「20.000000000000000」
    // 用可表示的邻接双精度值(写成字面量会被 no-loss-of-precision 拒绝,且实际就等于 20)
    const eps = Number.EPSILON * 20; // 20 的 ulp
    const data = [20, 20, 20 + eps, 20, 21, 19];
    const markup = renderToStaticMarkup(createElement(ControlChart, {
      T, data, cl: 20, ucl: 20 + 2 * eps, lcl: 20 - 2 * eps,
      clLabel: 'X̄', h: 200, dec: 3, violations: new Set<number>(),
    } as never));
    // 只看用户可见文本(<text>/<title>/aria-label),不看 SVG 坐标属性
    const visible = [
      ...[...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]),
      ...[...markup.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((m) => m[1]),
      ...[...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]),
    ];
    const longNums = visible.filter((t) => /-?\d+\.\d{8,}/.test(t));
    expect(longNums, `位数被逼爆:${longNums.slice(0, 3).join(' | ')}`).toEqual([]);
  });

  it('Dashboard 的颜色值必须是真常量而非字符串字面量(引号连带复制即红)', () => {
    // 闭环 P1:批量替换把 `#e23b3b` 换成了 `'STATUS_COLORS.bad'`(带引号),
    // 成了无效 CSS 值 —— lint/tsc/1061 项测试全部没拦住
    // 自审 P3:只查 3 个文件、且漏掉反引号变体 → 改为全仓递归扫描
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
      return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
    });
    const offenders: string[] = [];
    for (const f of walk('src')) {
      const text = readFileSync(f, 'utf8');
      // 单引号/双引号/反引号三种字面量里出现常量名 = 引号连带复制
      if (/['"`](STATUS_COLORS|MAX_[A-Z_]+|DEFAULT_[A-Z_]+)(\.\w+)?['"`]/.test(text)) offenders.push(f);
    }
    expect(offenders, `这些文件把常量引用写成了字符串字面量:${offenders.join('、')}`).toEqual([]);
  });

  it('定点模式重复标签自动升位(不升位即红)', () => {
    // 真实场景 = ControlChart 的 chartNum:轴刻度(步长 10)与限值(相差 1e-4)混在同一组,
    // 步长推出的 dp=0 会把 12.0001/12.0002 都印成「12」——两个不同的数给出同一标签
    const mixed = [0, 10, 20, 30, 40, 12.0001, 12.0002];
    const labels = mixed.map(tickFormatter(mixed));
    expect(new Set(labels).size, `不同数值给出同一标签:${labels.join(' | ')}`).toBe(labels.length);
    // 常规量程不受影响:不该无谓升位
    const plain = [0, 10, 20, 30, 40];
    expect(plain.map(tickFormatter(plain))).toEqual(['0', '10', '20', '30', '40']);
  });
});

// ──────────────── 闭环:半闭环条目补齐守护 ────────────────
describe('闭环补守护', () => {
  it('minitabQuantile 非有限输入契约:相等项短路、异号极值不上溢', () => {
    expect(minitabQuantile([], 0.5)).toBeNaN();
    expect(minitabQuantile([Infinity, Infinity], 0.5)).toBe(Infinity); // 差值式会给 NaN
    // **位置落在整数位次**(n=3 → (3+1)*0.5=2,fraction=0):加权式的 Inf*0 也是 NaN,
    // 必须由相等短路覆盖(自审教训:曾误判该短路冗余而删掉)
    expect(minitabQuantile([Infinity, Infinity, Infinity], 0.5)).toBe(Infinity);
    expect(minitabQuantile([-Infinity, -Infinity, -Infinity], 0.5)).toBe(-Infinity);
    expect(minitabQuantile([1, Infinity, Infinity], 0.5)).toBe(Infinity);
    expect(minitabQuantile([1, 2, 3], 0.5)).toBe(2); // 整数位次的常规值不受影响
    expect(minitabQuantile([-Infinity, -Infinity], 0.5)).toBe(-Infinity);
    expect(minitabQuantile([-1e308, 1e308], 0.5)).toBe(0); // (b-a) 上溢 → 两端加权
    expect(minitabQuantile([1e308, 1e308], 0.5)).toBe(1e308);
    expect(median([Infinity, Infinity])).toBe(Infinity);
    // 常规值不受影响
    expect(minitabQuantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(minitabQuantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.25, 12);
  });

  it('ndc/verdict/retained 对单位缩放不变', () => {
    // 如实说明:gage.ts 的 msScale 删掉 `, 1` 是**纯代码卫生**,不可观测——交互项 ANOVA
    // 跑在 normalized = centered/scale 上,量纲已被除掉。本用例真正守的是下面这条性质。
    const study = (k: number): GageObservation[] => {
      const out: GageObservation[] = [];
      let seed = 777;
      const rnd = () => { seed = (seed * 1103515 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
      for (let part = 0; part < 8; part++) {
        for (let operator = 0; operator < 3; operator++) {
          for (let trial = 0; trial < 3; trial++) {
            out.push({ part, operator, trial, value: (20 + part * 0.05 + operator * 0.01 + rnd() * 0.03) * k });
          }
        }
      }
      return out;
    };
    // 说明:缩放本身会带来 ~1e-12 的浮点噪声,故 p/F 用高精度近似;
    // **类别判定(retained/ndc)必须逐位相同**——判据一旦掺入量纲敏感项,这两个会整档跳变。
    const base = computeGageRR(study(1), null);
    for (const k of [1e-9, 1e-6, 1e-3, 1e3, 1e6]) {
      const g = computeGageRR(study(k), null);
      expect(g.interaction!.pValue, `k=${k} 时交互 p 变了`).toBeCloseTo(base.interaction!.pValue, 10);
      expect(g.interaction!.fStat).toBeCloseTo(base.interaction!.fStat, 8);
      expect(g.interaction!.retained, `k=${k} 时交互项保留与否变了`).toBe(base.interaction!.retained);
      expect(g.ndc, `k=${k} 时 ndc 变了`).toBe(base.ndc);
      expect(g.verdict).toBe(base.verdict);
    }
  });

  it('errText 契约:message 是抛异常的 getter 时也不穿透', () => {
    // 自审:instanceof / typeof 两条分支曾在 try 之外,message 抛异常会穿透调用方
    const evil = new Error('x');
    Object.defineProperty(evil, 'message', { get() { throw new Error('boom'); } });
    expect(() => errText(evil)).not.toThrow();
    expect(errText(evil)).toBe('未知错误');
    const evilObj = { get message() { throw new Error('boom'); } };
    expect(() => errText(evilObj)).not.toThrow();
  });

  it('sampleOutliers:极值必留、上限生效、口径两处一致', () => {
    const outliers = [...Array.from({ length: 600 }, (_, i) => -1000 - i), ...Array.from({ length: 300 }, (_, i) => 5000 + i)];
    const { shown, total } = sampleOutliers(outliers);
    expect(total).toBe(900);
    expect(shown.length).toBeLessThanOrEqual(502);
    // slice(0,500) 会让 5000+ 那批全部消失
    expect(Math.max(...shown)).toBe(Math.max(...outliers));
    expect(Math.min(...shown)).toBe(Math.min(...outliers));
    // 未超限时原样返回
    const small = [1, 2, 3];
    expect(sampleOutliers(small)).toEqual({ shown: small, total: 3 });
  });

  it('BoxPlot/IndividualValuePlot/IntervalPlot 的 Y 轴也走 tickFormatter(硬编码 nf(·,3) 即红)', () => {
    // 闭环 P2:这三处曾硬编码 nf(·,3),ppm 量程实测塌成 5 个「0.000」
    const tiny = Array.from({ length: 30 }, (_, i) => 0.0000012 + (i % 7) * 1e-9);
    const marks = [
      renderToStaticMarkup(createElement(BoxPlot, { T, groups: [{ name: 'g', vals: tiny }], h: 260 } as never)),
      renderToStaticMarkup(createElement(IndividualValuePlot, { T, groups: [{ name: 'g', vals: tiny }], h: 260 } as never)),
      // 自审 P2:守护标题写了 IntervalPlot 却从未渲染它 → 补上真渲染
      renderToStaticMarkup(createElement(IntervalPlot, { T, groups: [{ name: 'g', vals: tiny }, { name: 'h', vals: tiny.map((v) => v * 1.01) }], h: 260 } as never)),
    ];
    for (const mk of marks) {
      const ts = [...mk.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((t) => /^[-+]?[\d.]/.test(t));
      expect(ts.length).toBeGreaterThan(2);
      expect(ts.filter((t) => t === '0.000').length, `Y 轴塌陷:${ts.slice(0, 6).join(' | ')}`).toBe(0);
    }
  });

  it('闸门停采后立刻重启采集能真正启动(interval 残留会让 mesStart 静默早退)', () => {
    vi.useFakeTimers();
    try {
      useData.getState().importMatrix('A', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]]);
      mesStart();
      vi.advanceTimersByTime(1700);
      expect(useData.getState().mesRunning).toBe(true);
      // 闸门停采:只翻标志,interval 尚未自清
      useData.getState().importPareto('缺陷', [{ name: 'x', count: 1 }]);
      expect(useData.getState().mesRunning).toBe(false);
      // 在 interval 自清前(<800ms)立刻重启——必须真启动
      mesStart();
      expect(useData.getState().mesRunning, '重启被静默吞掉').toBe(true);
      const k0 = useData.getState().model.k;
      vi.advanceTimersByTime(2500);
      expect(useData.getState().model.k, '重启后未继续采集').toBeGreaterThan(k0);
    } finally { mesStop(); vi.useRealTimers(); }
  });

  it('隔离区损坏 + 配额满:不得覆盖 live 隔离区(旧证据是唯一一份)', () => {
    // 自审 P1:墓地写入失败时若继续写 live,唯一一份旧证据被销毁且返回 true 让调用方撤保护
    localStorage.setItem(QUARANTINE_STORAGE_KEY, '{损坏的 JSON');
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function patched(this: Storage, k: string, v: string) {
      if (k.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`)) throw new DOMException('quota', 'QuotaExceededError');
      return realSet.call(this, k, v);
    };
    try {
      const ok = preserveCorruptStore('qp-pareto-v1', '{"new":1}', '配额满');
      expect(ok, '配额满时必须返回 false').toBe(false);
      // live 隔离区不得被新 map 覆盖——旧证据必须原样还在
      expect(localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBe('{损坏的 JSON');
    } finally {
      Storage.prototype.setItem = realSet;
    }
  });

  it('隔离区墓地保留首份证据:二次损坏不得覆盖/删除最早那份', () => {
    // 自审 P3:此前是「只留最新一份」,第二次损坏会删掉最早也最完整的证据,
    // 与同文件其它分支的「首份最接近损坏前状态」原则正相反。
    localStorage.setItem(QUARANTINE_STORAGE_KEY, '{第一次损坏的原文');
    preserveCorruptStore('qp-pareto-v1', '{"a":1}', '第一次');
    const graves1 = Object.keys(localStorage).filter((k) => k.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`));
    expect(graves1.length, '首次损坏未生成墓地').toBe(1);
    const firstGrave = localStorage.getItem(graves1[0]);
    expect(firstGrave).toBe('{第一次损坏的原文');

    // 再次把隔离区弄坏 → 首份墓地必须原样保留
    localStorage.setItem(QUARANTINE_STORAGE_KEY, '{第二次损坏的原文');
    preserveCorruptStore('qp-pareto-v1', '{"b":2}', '第二次');
    const graves2 = Object.keys(localStorage).filter((k) => k.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`));
    expect(graves2.length, '墓地数量异常').toBe(1);
    expect(localStorage.getItem(graves2[0]), '首份墓地被第二次损坏覆盖/删除了').toBe('{第一次损坏的原文');
  });

  it('boxplotStats 入口统一过滤非有限值(两处消费方口径一致)', () => {
    const withNaN = [1, 2, Number.NaN, 3, 4, Infinity, 5];
    const clean = [1, 2, 3, 4, 5];
    expect(boxplotStats(withNaN)).toEqual(boxplotStats(clean));
  });

  it('通用箱线图离群圈有上限(删掉即红:900 个离群不得画 900 个圈)', () => {
    // 离群点必须落在 IQR 之外:主体要占 >75%(否则 q3 会被拉进离散群里,反而一个离群都没有)。
    // 3000 个 10 + 600 个远点 → q1=q3=10、IQR=0 → 600 个全是离群点(>500 上限)
    const vals = [...Array.from({ length: 3000 }, () => 10), ...Array.from({ length: 600 }, (_, i) => 1000 + i)];
    const markup = renderToStaticMarkup(createElement(BoxPlot, {
      T, groups: [{ name: 'g', vals }], h: 260,
    } as never));
    const circles = (markup.match(/<circle/g) ?? []).length;
    expect(circles, '离群点未渲染,夹具无效').toBeGreaterThan(100);
    expect(circles, `离群圈无上限:${circles} 个`).toBeLessThanOrEqual(520);
  });

  it('analyses.restore:非法 P 图快照不产生未捕获 rejection,且文案与 stash 副作用一致', async () => {
    const toasts: string[] = [];
    const origToast = useApp.getState().showToast;
    useApp.setState({ showToast: (t: string) => { toasts.push(t); } });
    try {
      // 必须是 P 图分析(走 importCounts 分支),否则 restore 会走 importMatrix 路径
      useData.getState().importCounts('p', '抽样.csv', [3, 5, 2, 4, 6], 50);
      useApp.setState({ page: 'spc', spcType: 'p' });
      const saved = useAnalyses.getState().saveCurrent();
      expect(saved, '保存分析失败,夹具无效').toBeTruthy();
      const id = saved!.id;
      // 注入非法计数(不良数 > 样本量)让 computePChart 抛
      useAnalyses.setState({
        saved: useAnalyses.getState().saved.map((a) => a.id === id
          ? { ...a, snapshot: { ...a.snapshot, pChartData: { name: '坏', counts: [900, 1, 2], sampleSize: 10 } } }
          : a),
      });
      // 必须 resolve 为 false 而非抛出(未捕获 rejection)
      await expect(useAnalyses.getState().restore(id)).resolves.toBe(false);
      expect(toasts.some((t) => t.includes('回看失败')), `未给出失败提示:${toasts.join(' / ')}`).toBe(true);
      // 未发生 stash 时文案必须说「当前数据未作更改」
      expect(toasts.some((t) => t.includes('当前数据未作更改'))).toBe(true);
    } finally {
      useApp.setState({ showToast: origToast });
    }
  });

  it('importMatrix 失败路径不推进闸门:抛错后 MES 仍在跑(闸门在校验之前即红)', () => {
    vi.useFakeTimers();
    try {
      useData.getState().importMatrix('种子', ['a', 'b', 'c', 'd', 'e'], [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]]);
      mesStart();
      vi.advanceTimersByTime(1700);
      expect(useData.getState().mesRunning).toBe(true);
      // 有限性屏障抛错
      expect(() => useData.getState().importMatrix('坏', ['x'], [[1], [Infinity]])).toThrow(/非有限数值/);
      expect(useData.getState().mesRunning, '导入失败却停了 MES:闸门跑到校验之前了').toBe(true);
      // 列结构错误(computeVarModel 抛)同样不得推进闸门
      expect(() => useData.getState().importMatrix('坏2', ['x', 'y'], [[1]])).toThrow();
      expect(useData.getState().mesRunning, 'computeVarModel 抛错却停了 MES').toBe(true);
      // 对照:合法导入必须真的停掉
      useData.getState().importMatrix('好', ['a', 'b', 'c', 'd', 'e'], [[3, 3, 3, 3, 3], [4, 4, 4, 4, 4]]);
      expect(useData.getState().mesRunning).toBe(false);
    } finally { mesStop(); vi.useRealTimers(); }
  });
});

// ──────────────── 复核整改守护 ────────────────
describe('复核整改守护', () => {
  it('tickFormatter 不印 -0:小负数在粗步长下被舍入成 -0 也要归零', () => {
    // 关键:Object.is(v,-0) 只覆盖真正的负零字面量,挡不住 -0.4 在 dp=0 时被印成「-0」
    // 夹具必须是**等距**序列,且首个刻度确实 ≈0(否则「标成 0」本身就是失真,
    // 自审 P1:旧夹具把 -0.4 标成「0」固化成期望值,反过来挡住了保真度修复)
    for (const ticks of [[-1e-9, 1, 2, 3], [-0.0004, 1, 2, 3], [-0, 0.5, 1, 1.5]]) {
      const labels = ticks.map(tickFormatter(ticks));
      expect(labels.filter((l) => /^-0(\.0*)?$/.test(l)), `印出 -0:${labels.join(' | ')}`).toEqual([]);
      // 位数由步长决定(0.5 步长下是「0.0」),只要求数值为 0 且无负号
      expect(Number(labels[0]), `首个刻度≈0:${labels.join(' | ')}`).toBe(0);
      expect(labels[0]).not.toMatch(/^-/);
    }
    // 真值离 0 有距离的刻度不得被抹成 0(保真度)
    const notZero = [-0.4, 10, 20, 30];
    expect(notZero.map(tickFormatter(notZero))[0]).toBe('-0.4');
    // 指数模式同理
    const tiny = [-1e-15, 5e-15, 1e-14];
    const expLabels = tiny.map(tickFormatter(tiny));
    expect(expLabels.filter((l) => /^-0(\.0*)?(e-?\d+)?$/.test(l))).toEqual([]);
    // 真负值不得被误伤
    const real = [-10, 0, 10];
    expect(real.map(tickFormatter(real))[0]).toBe('-10');
  });

  it('指数模式尊重 minDp(注释承诺的「限值由 cfg.dec 兜底」必须成立)', () => {
    // 用「多给位数才看得出差别」的值:整数倍的刻度会被尾零裁掉,看不出 minDp 生效
    const ticks = [1.234567e-6, 2.345678e-6, 3.456789e-6];
    const coarse = ticks.map(tickFormatter(ticks));
    const fine = ticks.map(tickFormatter(ticks, 10));
    expect(fine.join('|'), 'minDp 未生效').not.toBe(coarse.join('|'));
    for (const l of fine) expect(l).toMatch(/e-?\d/);
    expect(fine[0].length).toBeGreaterThan(coarse[0].length);
  });

  it('sampleOutliers 两分支同口径:都升序、都保留重数、极值必留', () => {
    // 自审 P1:曾为消除 cap 边界断崖给两侧都加去重 → 把「重复离群值的密集程度」抹掉
    // (同一个值出现 200 次只画 1 个圈),且未超限时报「抽样显示」是谎报。
    const dup = (n: number) => Array.from({ length: n }, (_, i) => (i % 3) + 1);
    const under = sampleOutliers(dup(499));
    const over = sampleOutliers(dup(501));
    expect(under.shown.length, '未超限必须原样返回全部(保留重数)').toBe(499);
    expect(over.shown.length).toBeLessThanOrEqual(502);
    expect(over.shown.filter((v) => v === 1).length, '超限抽样也要保留重数').toBeGreaterThan(1);
    // 两侧都升序
    for (const { shown } of [under, over]) {
      for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]);
    }
    // 乱序输入必须被排序(改回未排序即红)
    expect(sampleOutliers([3, 1, 2])).toEqual({ shown: [1, 2, 3], total: 3 });
    // 极值必留
    const spread = [...Array.from({ length: 600 }, (_, i) => -2000 - i), ...Array.from({ length: 300 }, (_, i) => 5000 + i)];
    const sampled = sampleOutliers(spread);
    expect(Math.min(...sampled.shown)).toBe(Math.min(...spread));
    expect(Math.max(...sampled.shown)).toBe(Math.max(...spread));
  });

  it('misc 三图的左槽自适应:标签两侧都不越界,绘图区不冲出 viewBox', () => {
    // 自审 P1:上一版夹具是单组 + 短标签,箱体 x≈210 而标签 x=54,`x <= plotLeft` 恒真,
    // 把实现改回旧行为仍全绿;且只查左边界,漏掉了「pw 不跟着收窄 → 右界越出 viewBox」。
    const W = 960;
    const tiny = (k: number) => Array.from({ length: 12 }, (_, i) => 1.23456789e-15 * (1 + k * 0.01) + i * 1e-18);
    const groups = Array.from({ length: 12 }, (_, k) => ({ name: `组${k}`, vals: tiny(k) }));
    const cases: Array<[string, string]> = [
      ['BoxPlot', renderToStaticMarkup(createElement(BoxPlot, { T, groups, h: 300 } as never))],
      ['IndividualValuePlot', renderToStaticMarkup(createElement(IndividualValuePlot, { T, groups, h: 300 } as never))],
      // 自审:标题写「三图」却只跑两图 → 补上 IntervalPlot
      ['IntervalPlot', renderToStaticMarkup(createElement(IntervalPlot, { T, groups, h: 300 } as never))],
    ];
    for (const [name, markup] of cases) {
      const labels = [...markup.matchAll(/<text[^>]*x="([-\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)]
        .map((m) => ({ x: Number(m[1]), t: m[2] }));
      expect(labels.length, `${name} 未取到 Y 轴刻度标签`).toBeGreaterThan(2);
      const plotLeft = Math.min(
        ...[...markup.matchAll(/<rect[^>]*x="([-\d.]+)"/g)].map((mm) => Number(mm[1])).filter((v) => v > 0),
        ...[...markup.matchAll(/<circle[^>]*cx="([-\d.]+)"/g)].map((mm) => Number(mm[1])),
        Infinity,
      );
      for (const { x, t } of labels) {
        expect(x - t.length * 6, `${name} 标签左端被裁:「${t}」`).toBeGreaterThanOrEqual(-2);
        if (Number.isFinite(plotLeft)) {
          expect(x, `${name} 标签右端 ${x} 越过图元左界 ${plotLeft}:「${t}」`).toBeLessThanOrEqual(plotLeft);
        }
      }
      // 右侧不变量:**右留白必须保住**。m.l 加宽后若 pw 不跟着收窄,绘图区右界会从
      // W-m.r 推到 W-m.r+(新 m.l−旧 m.l),吃掉留白甚至冲出 viewBox。
      // 只断言「≤ W」抓不到——本夹具下越界后是 952,仍小于 960。
      const RIGHT_MARGIN = 30;
      const rights = [
        ...[...markup.matchAll(/<line[^>]*x2="([-\d.]+)"/g)].map((mm) => Number(mm[1])),
        // 排除整幅背景矩形
        ...[...markup.matchAll(/<rect[^>]*x="([-\d.]+)"[^>]*width="([-\d.]+)"/g)]
          .map((mm) => ({ x: Number(mm[1]), w: Number(mm[2]) }))
          .filter((r) => !(r.x === 0 && r.w >= W - 1)).map((r) => r.x + r.w),
        ...[...markup.matchAll(/<circle[^>]*cx="([-\d.]+)"/g)].map((mm) => Number(mm[1])),
      ].filter(Number.isFinite);
      expect(rights.length).toBeGreaterThan(0);
      expect(Math.max(...rights), `${name} 绘图区吃掉右留白(pw 未随 m.l 收窄)`)
        .toBeLessThanOrEqual(W - RIGHT_MARGIN + 1);
    }
  });

  it('描述统计页箱线的离群抽样落到消费点(改回 slice 即红)', () => {
    // 自审 P3:此前只守住 helper,Summary.tsx 的消费点改回 slice(0,500) 仍全绿
    const data = [
      ...Array.from({ length: 3000 }, () => 10),
      ...Array.from({ length: 600 }, (_, i) => -2000 - i),
      ...Array.from({ length: 300 }, (_, i) => 5000 + i),
    ];
    useData.getState().importMatrix('离群.csv', ['测量'], data.map((v) => [v]));
    useApp.setState({ page: 'summary', activeVar: '测量' });
    const { container } = render(createElement(Summary, { T }));
    const svgs = [...container.querySelectorAll('svg')];
    const box = svgs.find((sv) => (sv.getAttribute('aria-label') ?? '').includes('箱线图'));
    expect(box, '未找到箱线图').toBeTruthy();
    const cxs = [...box!.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cx')));
    expect(cxs.length).toBeGreaterThan(10);
    // slice(0,500) 只留最小的一批(boxplotStats 的 outliers 已按升序)→ 高端离群整批消失,
    // 圆圈全挤在左侧一小段。判据必须用**坐标轴跨度**,不能用「渲染点自身的中点」——
    // 后者在全挤左边时同样成立(自审:第一版守护就栽在这里)。
    const viewBox = (box!.getAttribute('viewBox') ?? '0 0 640 74').split(/\s+/);
    const axisWidth = Number(viewBox[2]);
    const spread = Math.max(...cxs) - Math.min(...cxs);
    expect(spread / axisWidth, `离群点只覆盖 ${(spread / axisWidth * 100).toFixed(0)}% 轴宽,高端离群被砍掉了`)
      .toBeGreaterThan(0.5);
    // 截断说明必须写明总数
    expect(box!.getAttribute('aria-label')).toMatch(/共 900 个离群观测/);
  });

  it('DOE 交互作用图 Y 轴走 tickFormatter:小量程刻度不塌(硬编码 nf(·,1) 即红)', () => {
    // 自审 P2:此前是写死旧串的黑名单式源码扫描,把 1 改成 1.0 即绕过
    const markup = renderToStaticMarkup(createElement(InteractionPlot, {
      T, c00: 0.0000012, c10: 0.0000016, c01: 0.0000014, c11: 0.0000019, labelA: 'A', labelB: 'B',
    }));
    const ts = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
      .filter((t) => /^[-+]?[\d.]/.test(t));
    expect(ts.length, '未取到刻度标签').toBeGreaterThan(2);
    for (const [axisKey, group] of axisGroups(markup)) {
      if (group.length < 2) continue;
      expect(new Set(group).size, `${axisKey} 刻度塌陷:${group.join(' | ')}`).toBe(group.length);
    }
  });
});

// ──────────────── 终局整改守护 ────────────────
describe('终局整改守护', () => {
  it('无具名 label 的图不得加 role="img"(否则图内文字对辅助技术整体消失)', () => {
    // 自审 P1:统一加 role="img"+兜底名让 21/26 张图退化成一句「统计图表」,
    // 刻度/UCL 文字与可点击点全部被遮蔽,换来的名称还没有信息量
    const withLabel = renderToStaticMarkup(createElement(Histogram, {
      T, data: [1, 2, 3, 4, 5], mu: 3, sigmaWithin: 1, sigmaOverall: 1,
      lsl: null, usl: null, tgt: 3, h: 210,
    } as never));
    expect(withLabel).toContain('role="img"');
    expect(withLabel).toMatch(/aria-label="[^"]+"/);
    expect(withLabel).not.toContain('aria-label="统计图表"'); // 不得是兜底名
    // 无具名 label 的图:不得有 role="img",也不得有兜底 aria-label
    const noLabel = renderToStaticMarkup(createElement(ScatterPlot, {
      T, xs: [1, 2, 3], ys: [2, 4, 6], slope: 2, intercept: 0, h: 200,
    } as never));
    expect(noLabel, '夹具漏传必填 props 导致 NaN 几何').not.toMatch(/="[^"]*NaN/);
    expect(noLabel, '无名图仍被 role="img" 遮蔽内部文字').not.toContain('role="img"');
    expect(noLabel).not.toContain('aria-label="统计图表"');
  });
});

// ──────────────── 终局补守护 ────────────────
describe('终局补守护', () => {
  it('隔离区二次损坏保留 latestRaw(新证据不得丢弃)', () => {
    preserveCorruptStore('qp-pareto-v1', '{"first":1}', '首次');
    preserveCorruptStore('qp-pareto-v1', '{"second":2}', '二次');
    const map = JSON.parse(localStorage.getItem(QUARANTINE_STORAGE_KEY) ?? '{}');
    expect(map['qp-pareto-v1'].raw, '首份证据必须保留').toBe('{"first":1}');
    expect(map['qp-pareto-v1'].latestRaw, '最新原文被丢弃了').toBe('{"second":2}');
    // 加了额外字段后仍须通过项目校验器(否则 .qproj 导出被整体阻断)
    expect(projectStoreValidationError(QUARANTINE_STORAGE_KEY, map)).toBeNull();
  });

  it('隔离区墓地键随 .qproj 一起导出(最需要证据的场景不得丢)', () => {
    localStorage.setItem(`${QUARANTINE_STORAGE_KEY}.corrupt-1700000000000-1`, '{坏 JSON 原文');
    const json = buildProjectJson('1.43.0', true);
    expect(json, '墓地证据未进 .qproj').toContain('corrupt-1700000000000-1');
    expect(json).toContain('坏 JSON 原文');
  });

  it('tickFormatter 位数不越界:升位不得绕开 toFixed 上限,指数位数不超 double 有效位', () => {
    // 指数分支:minExpDigits = ceil(minDp + log10(maxMag));大量级 + 高 minDp 会算出
    // 三位数的位数需求,超过 toExponential 的合法上限 100 直接抛 RangeError(自审 P3)
    const huge = [1e300, 2e300, 3e300];
    expect(() => huge.map(tickFormatter(huge, 10))).not.toThrow();
    for (const l of huge.map(tickFormatter(huge, 10))) {
      const mantissa = /^-?\d+\.?(\d*)e/.exec(l)?.[1] ?? '';
      expect(mantissa.length, `指数尾数 ${mantissa.length} 位超出 double 有效位`).toBeLessThanOrEqual(17);
    }
    // 次正规量程不抛错(既有回归)
    const subnormal = [1e-320, 1.5e-320, 2e-320];
    expect(() => subnormal.map(tickFormatter(subnormal))).not.toThrow();
    // 说明:定点分支的 100 位钳制在当前 niceTicks 口径下不可达(步长 <1e-100 时
    // lo+step 在 double 里就等于 lo,tickDecimals 返回 0),属纯防御,不宣称有守护。
  });

  it('BoxPlot 均值圈用过滤后的数据(含 NaN 的组不得渲染出 cy="NaN")', () => {
    const vals = [1, 2, Number.NaN, 3, 4, 5, Infinity, 6];
    const markup = renderToStaticMarkup(createElement(BoxPlot, {
      T, groups: [{ name: 'g', vals }], h: 260,
    } as never));
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('Infinity');
  });
});

// ──────────────── 终局补守护 2 ────────────────
describe('终局补守护2', () => {
  it('#14 控制图限值/σ带/点提示与轴刻度同记数法:ppm 下不得全塌成 0.000', () => {
    const ppm = Array.from({ length: 25 }, (_, i) => 0.0000012 + (i % 7) * 1e-9);
    const markup = renderToStaticMarkup(createElement(ControlChart, {
      T, data: ppm, cl: 0.0000015, ucl: 0.0000021, lcl: 0.0000009,
      clLabel: 'X̄', h: 200, dec: 3, violations: new Set<number>(),
    } as never));
    // 限值标签形如「UCL=…」「X̄=…」,首字符是字母,轴刻度正则取不到它们
    const named = [...markup.matchAll(/<text[^>]*>([A-Za-z\u0080-\uffff][^<]*?[=＝\s]\s*[-\d][^<]*)<\/text>/g)]
      .map((m) => m[1]);
    expect(named.length, `未取到限值标签:${markup.slice(0, 200)}`).toBeGreaterThan(2);
    const values = named.map((t) => t.replace(/^[^=＝\s]*[=＝\s]\s*/, ''));
    // cl/ucl/lcl 三个不同真值必须给出三个不同标签
    expect(new Set(values).size, `限值标签塌陷:${named.join(' | ')}`).toBe(values.length);
    for (const v of values) expect(v, `限值标签塌成 0:${v}`).not.toMatch(/^-?0(\.0+)?$/);
    // 点提示(title)同样不得塌
    const titles = [...markup.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((m) => m[1]);
    for (const t of titles) expect(t).not.toMatch(/[=＝]\s*0(\.0+)?(\s|$)/);
  });

  it('#20 箱线截断说明可达 + 极值必留(两半都守住)', () => {
    const vals = [
      ...Array.from({ length: 3000 }, () => 10),
      ...Array.from({ length: 600 }, (_, i) => -2000 - i),
    ];
    const markup = renderToStaticMarkup(createElement(BoxPlot, {
      T, groups: [{ name: 'g', vals }], h: 260,
    } as never));
    // (a) 截断说明必须落在 aria-label(挂 <title> 会被 role=img 压过)
    expect(markup, '截断说明不可达').toMatch(/aria-label="[^"]*共 600 个离群观测[^"]*"/);
    expect(markup, '有实质补充信息时才用 role=img').toContain('role="img"');
    // (b) 极值必留:最小离群点对应的圆圈必须在
    const cys = [...markup.matchAll(/<circle[^>]*cy="([-\d.]+)"/g)].map((m) => Number(m[1]));
    expect(cys.length).toBeGreaterThan(10);
    expect(Math.max(...cys) - Math.min(...cys), '离群圈未覆盖极值范围').toBeGreaterThan(20);
  });

  it('#24 回看失败文案两侧都对:有 stash 说「已另存为」,无 stash 说「未作更改」', async () => {
    const toasts: string[] = [];
    const origToast = useApp.getState().showToast;
    useApp.setState({ showToast: (t: string) => { toasts.push(t); } });
    try {
      useData.getState().importCounts('p', '抽样.csv', [3, 5, 2, 4, 6], 50);
      useApp.setState({ page: 'spc', spcType: 'p' });
      const saved = useAnalyses.getState().saveCurrent();
      const id = saved!.id;
      useAnalyses.setState({
        saved: useAnalyses.getState().saved.map((a) => a.id === id
          ? { ...a, snapshot: { ...a.snapshot, pChartData: { name: '坏', counts: [900, 1, 2], sampleSize: 10 } } }
          : a),
      });
      await expect(useAnalyses.getState().restore(id)).resolves.toBe(false);
      const fail = toasts.filter((t) => t.includes('回看失败'));
      expect(fail.length).toBeGreaterThan(0);
      // 无 stash 侧:必须说「未作更改」,不得说「已另存为」
      expect(fail.some((t) => t.includes('当前数据未作更改'))).toBe(true);
      expect(fail.some((t) => t.includes('已另存为')), '无 stash 却声称已另存').toBe(false);

      // ── 有 stash 侧:同名工作表内容不同 → 先另存副本,回放再失败 ──
      toasts.length = 0;
      useData.getState().importMatrix('工作表.csv', ['x'], [[1], [2], [3]]);
      useApp.setState({ page: 'summary', activeVar: 'x' });
      const saved2 = useAnalyses.getState().saveCurrent();
      expect(saved2, '保存工作表分析失败').toBeTruthy();
      // 当前工作表改成同名不同内容 → restore 时会先 saveAsCopy
      useData.getState().importMatrix('工作表.csv', ['x'], [[9], [8], [7]]);
      // 把快照数据污染成非有限值 → importMatrix 抛错
      useAnalyses.setState({
        saved: useAnalyses.getState().saved.map((a) => a.id === saved2!.id
          ? { ...a, snapshot: { ...a.snapshot, sourceData: { name: '工作表.csv', colNames: ['x'], rows: [[1], [Infinity]], textCols: [] } } }
          : a),
      });
      await expect(useAnalyses.getState().restore(saved2!.id)).resolves.toBe(false);
      const fail2 = toasts.filter((t) => t.includes('回看失败'));
      expect(fail2.length, `未产生回看失败提示:${toasts.join(' / ')}`).toBeGreaterThan(0);
      // 已另存副本 → 不得再说「当前数据未作更改」
      expect(fail2.some((t) => t.includes('已另存为')), `stash 已发生却未说明:${fail2.join(' / ')}`).toBe(true);
      expect(fail2.some((t) => t.includes('当前数据未作更改')), 'stash 已发生却声称未作更改').toBe(false);
    } finally {
      useApp.setState({ showToast: origToast });
    }
  });
});

// ──────────────── 终局补守护 3 ────────────────
describe('终局补守护3', () => {
  it('presorted:已排序输入不重复排序(median/描述统计各只排一次)', () => {
    const sorted = Array.from({ length: 200 }, (_, i) => i);
    let sortCalls = 0;
    const realSort = Array.prototype.sort;
    Array.prototype.sort = function counted(this: number[], cmp?: (a: number, b: number) => number) {
      sortCalls += 1;
      return realSort.call(this, cmp as never) as number[];
    } as typeof realSort;
    try {
      sortCalls = 0;
      expect(median(sorted, true)).toBe(minitabQuantile(sorted, 0.5, true));
      expect(sortCalls, `median(presorted) 触发了 ${sortCalls} 次排序`).toBe(0);
      sortCalls = 0;
      median(sorted); // 未声明已排序:允许排一次
      expect(sortCalls).toBe(1);
      sortCalls = 0;
      computeDescriptive(sorted);
      expect(sortCalls, `computeDescriptive 触发了 ${sortCalls} 次排序(q1/median/q3 应共用一次)`).toBeLessThanOrEqual(1);
    } finally {
      Array.prototype.sort = realSort;
    }
  });

  it('Modals 拖放失败:mock decodeTextFileBytes 抛错,toast 给出具体原因', async () => {
    // 自审:此前是「测试里自己重写一遍 detailOf 再断言自己」+ readFileSync 源码扫描,
    // 两种已知空洞形态叠加。改为真渲染 + mock 抛错 + 断言 toast。
    const adapter = await import('../../platform/adapter');
    const toasts: string[] = [];
    const origToast = useApp.getState().showToast;
    useApp.setState({ showToast: (t: string) => { toasts.push(t); }, modal: 'import' });
    const spy = vi.spyOn(adapter, 'decodeTextFileBytes');
    try {
      const { container } = render(createElement(Modals, {}));
      // 导入弹窗的 CSV/Excel 页签里那块虚线拖放区
      const drop = [...container.querySelectorAll('div')]
        .find((d) => (d.getAttribute('style') ?? '').includes('dashed'));
      expect(drop, '未找到拖放区').toBeTruthy();
      const fire = async (error: unknown, expectText: string, notText?: string) => {
        toasts.length = 0;
        spy.mockRejectedValueOnce(error);
        const file = new File(['x'], 'p.qproj', { type: 'application/json' });
        fireEvent.drop(drop!, { dataTransfer: { files: [file], types: ['Files'] } });
        await vi.waitFor(() => expect(toasts.length).toBeGreaterThan(0));
        expect(toasts.join(' | '), `期望包含「${expectText}」`).toContain(expectText);
        if (notText) expect(toasts.join(' | ')).not.toContain(notText);
      };
      // 有具体原因时原样透出(DOMException 的 String() 给出错误名,比兜底句更有信息)
      await fire(new Error('磁盘已满'), '磁盘已满', '源文件可能已被移动');
      await fire(new DOMException('', 'NotReadableError'), 'NotReadableError');
      // 只有连原因都取不到时才落到指向性兜底句
      await fire(new Error(''), '源文件可能已被移动或删除');
      await fire(undefined, '源文件可能已被移动或删除');
    } finally {
      spy.mockRestore();
      useApp.setState({ showToast: origToast, modal: null });
    }
  });
});

// ──────────────── 终局补守护 4 ────────────────
describe('终局补守护4', () => {
  it('含可点击点的控制图用 role="group" 而非 role="img"(否则交互点被压成 presentational)', () => {
    const data = [1, 2, 3, 4, 5];
    const withClick = renderToStaticMarkup(createElement(ControlChart, {
      T, data, cl: 3, ucl: 5, lcl: 1, clLabel: 'X̄', h: 200,
      violations: new Set<number>(), onPoint: () => {},
    } as never));
    expect(withClick).toContain('role="button"');
    expect(withClick, 'role="img" 会把可点击点整体压掉').not.toContain('role="img"');
    expect(withClick).toContain('role="group"');
    expect(withClick).toMatch(/aria-label="[^"]*控制图"/);
    // 无 onPoint 的静态图仍用 role="img"
    const staticChart = renderToStaticMarkup(createElement(ControlChart, {
      T, data, cl: 3, ucl: 5, lcl: 1, clLabel: 'X̄', h: 200, violations: new Set<number>(),
    } as never));
    expect(staticChart).toContain('role="img"');
    expect(staticChart).not.toContain('role="button"');
  });

  it('非白名单 key 不得触发 dataStore 的写保护(返回 false 会永久锁死该 key)', () => {
    expect(preserveCorruptStore('qp-pareto-v1', '{"ok":1}', '合法')).toBe(true);
    expect(preserveCorruptStore('完全陌生的key', '{"x":1}', '非白名单')).toBe(true);
    const map = JSON.parse(localStorage.getItem(QUARANTINE_STORAGE_KEY) ?? '{}');
    expect(Object.keys(map), '非白名单 key 不该进隔离区').toEqual(['qp-pareto-v1']);
    expect(projectStoreValidationError(QUARANTINE_STORAGE_KEY, map)).toBeNull();
  });
});

// ──────────────── 终局补守护 5 ────────────────
describe('终局补守护5', () => {
  it('BoxPlot 每组只算一次 boxplotStats/sampleOutliers(截断说明与渲染共用)', async () => {
    const gage = await import('../charts/gagePanels');
    const statsSpy = vi.spyOn(gage, 'boxplotStats');
    const sampleSpy = vi.spyOn(gage, 'sampleOutliers');
    try {
      const groups = Array.from({ length: 3 }, (_, k) => ({
        name: `g${k}`, vals: Array.from({ length: 20 }, (_, i) => i + k),
      }));
      renderToStaticMarkup(createElement(BoxPlot, { T, groups, h: 260 } as never));
      // 3 组 → 各一次;退回「截断说明与渲染各算一遍」会变成 6 次
      expect(statsSpy.mock.calls.length, `boxplotStats 调用 ${statsSpy.mock.calls.length} 次`).toBeLessThanOrEqual(3);
      expect(sampleSpy.mock.calls.length, `sampleOutliers 调用 ${sampleSpy.mock.calls.length} 次`).toBeLessThanOrEqual(3);
    } finally {
      statsSpy.mockRestore();
      sampleSpy.mockRestore();
    }
  });

  it('轴格式化器每图只构造常数次(退回刻度 map 内重建即红)', async () => {
    const tokensMod = await import('../tokens');
    const spy = vi.spyOn(tokensMod, 'tickFormatter');
    try {
      const groups = [{ name: 'g', vals: Array.from({ length: 20 }, (_, i) => i) }];
      renderToStaticMarkup(createElement(BoxPlot, { T, groups, h: 260 } as never));
      // fmtY 一次 + axisLeft 内 fiveTickFormatter 一次 = 2;在 map 内重建会 ≥6
      expect(spy.mock.calls.length, `tickFormatter 构造 ${spy.mock.calls.length} 次`).toBeLessThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });
});

// ──────────────── 刻度保真度守护 ────────────────
describe('刻度保真度守护', () => {
  const fiveEqual = (lo: number, hi: number) => Array.from({ length: 5 }, (_, g) => hi - ((hi - lo) * g) / 4);

  it('标签必须能还原到刻度真值(等距序列不得被舍成不等距)', () => {
    // 自审 P1:tickDecimals 对降序序列(step<0)返回 0,把 72.30/67.90/63.50 标成
    // 「72|68|64|59|55」,步差看起来 4/4/5/4,标签与网格线真值最多差半个步长。
    const cases: Array<[string, number[]]> = [
      ['抗拉强度', fiveEqual(54.7, 72.3)],
      ['扭矩', fiveEqual(9.2, 16.4)],
      ['小量程', fiveEqual(0.00312, 0.00877)],
      ['大量程', fiveEqual(12345, 98765)],
      ['跨零', fiveEqual(-3.7, 4.9)],
      ['圆整', niceTicks(0, 100, 6)],
    ];
    for (const [name, ticks] of cases) {
      const labels = ticks.map(tickFormatter(ticks));
      const step = Math.abs(ticks[1] - ticks[0]);
      // (a) 每个标签解析回来必须贴近真值
      labels.forEach((l, i) => {
        const back = Number(l.replace('e', 'e'));
        expect(Number.isFinite(back), `${name} 标签不可解析:${l}`).toBe(true);
        expect(Math.abs(back - ticks[i]), `${name} 标签「${l}」偏离真值 ${ticks[i]}`).toBeLessThanOrEqual(step * 0.05);
      });
      // (b) 等距序列的标签差也必须等距(舍入不得制造 4/4/5/4 这种视觉失真)
      const diffs = labels.slice(1).map((l, i) => Math.abs(Number(l) - Number(labels[i])));
      const spread = Math.max(...diffs) - Math.min(...diffs);
      expect(spread, `${name} 标签步差不等:${labels.join(' | ')}`).toBeLessThanOrEqual(step * 0.1);
    }
  });

  it('tickDecimals 对降序序列同样按步长量级给位数(不取绝对值即红)', () => {
    // 自审 P1:降序序列 step<0 走 `step<=0 → return 0` 分支。
    // 保真度循环会兜住它,但 tickDecimals 作为独立导出函数本身必须正确。
    // 步长 <1 的降序序列才检验得到 abs:step=-0.4 时旧写法直接 return 0
    expect(tickDecimals([0.8, 0.4, 0]), '降序序列被判成 0 位').toBe(1);
    expect(tickDecimals([0, 0.4, 0.8])).toBe(1); // 升序同值,两者必须一致
    expect(tickDecimals([0.008, 0.006, 0.004])).toBe(3);
    expect(tickDecimals([0.004, 0.006, 0.008])).toBe(3);
    // 步长 ≥1 时本就是 0 位(位数由下游保真度循环按需补)
    expect(tickDecimals([72.3, 67.9, 63.5])).toBe(0);
    expect(tickDecimals([30, 20, 10])).toBe(0);
    expect(tickDecimals([5, 5, 5])).toBe(0); // 常量列
  });

  it('圆整刻度不因保真度虚增位数', () => {
    expect(niceTicks(0, 100, 6).map(tickFormatter(niceTicks(0, 100, 6)))).toEqual(['0', '20', '40', '60', '80', '100']);
    const t = niceTicks(0, 50, 5);
    for (const l of t.map(tickFormatter(t))) expect(l).not.toMatch(/\.0+$/);
  });

  it('渲染级:等分刻度图表的轴标签与真值一致(五处调用方)', () => {
    const vals = Array.from({ length: 30 }, (_, i) => 54.7 + (i % 11) * 1.76);
    const groups = [{ name: 'A', vals }, { name: 'B', vals: vals.map((v) => v + 0.9) }];
    const marks: Array<[string, string]> = [
      ['BoxPlot', renderToStaticMarkup(createElement(BoxPlot, { T, groups, h: 300 } as never))],
      ['IndividualValuePlot', renderToStaticMarkup(createElement(IndividualValuePlot, { T, groups, h: 300 } as never))],
      ['IntervalPlot', renderToStaticMarkup(createElement(IntervalPlot, { T, groups, h: 300 } as never))],
      ['InteractionPlot', renderToStaticMarkup(createElement(InteractionPlot, {
        T, c00: 54.7, c10: 62.1, c01: 58.4, c11: 72.3, labelA: 'A', labelB: 'B',
      }))],
    ];
    for (const [name, markup] of marks) {
      const axis = [...markup.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)]
        .map((m) => Number(m[1])).filter(Number.isFinite);
      expect(axis.length, `${name} 未取到 Y 轴刻度`).toBeGreaterThanOrEqual(4);
      const diffs = axis.slice(1).map((v, i) => Math.abs(v - axis[i]));
      const spread = Math.max(...diffs) - Math.min(...diffs);
      const step = diffs[0] || 1;
      expect(spread, `${name} 轴标签步差不等(舍入失真):${axis.join(' | ')}`).toBeLessThanOrEqual(step * 0.1);
    }
  });
});

// ──────────────── 分层整改守护 ────────────────
describe('分层整改守护', () => {
  it('DOE:显著交互与区组混杂可并存,两句提示都要给', () => {
    const aliases = [{ term: 'B×D', with: '区组 2', relation: 'same' as const }];
    const both = doeInteractionNote({ hasSignificantInteraction: true, aliases });
    expect(both, '显著交互时吞掉了混杂提示').toContain('无法检验');
    expect(both).toContain('已综合显著交互作用');
    // 无混杂时不得凭空加提示
    expect(doeInteractionNote({ hasSignificantInteraction: true, aliases: [] }))
      .toBe('已综合显著交互作用，不按主效应符号独立推荐。');
    // 四个结论分支在「显著交互 + 混杂」下都要带混杂原文
    for (const status of ['tied', 'unique'] as const) {
      const text = buildDoeConclusion({
        status, aliases, hasSignificantInteraction: true, sigTermNames: ['A'],
        detail: 'd', factorCount: 4, respName: 'Y', settings: 'A=+1', tieCount: 2, fixedSettings: 'A=+1',
      });
      expect(text, `${status} 分支缺混杂提示`).toContain('无法检验');
    }
  });

  it('只剩墓地键时报「没有可导出的持久化数据」而非打偏成自校验失败', () => {
    // 自审 P3:空判据按 stores 长度判,墓地键会让它非空 → 绕过 → 下游自校验拒绝,
    // 用户拿到的是错误方向的文案。改按 PROJECT_KEYS 命中数判。
    localStorage.clear();
    localStorage.setItem(`${QUARANTINE_STORAGE_KEY}.corrupt-1700000000000`, '{坏原文');
    expect(() => buildProjectJson('1.43.0', false)).toThrow(/没有可导出的持久化数据/);
  });

  it('无补充信息的图不加 role="img"(图内刻度/UCL 文字须保持可读)', () => {
    // 自审 P3:只要有 label 就套 role="img",整棵子树被压成 presentational,
    // 屏幕阅读器读到的只剩一句「箱线图」,图内 5 个刻度值与组名全部消失。
    const plain = renderToStaticMarkup(createElement(BoxPlot, {
      T, groups: [{ name: 'g', vals: [1, 2, 3, 4, 5, 6, 7, 8] }], h: 260,
    } as never));
    expect(plain, '无截断说明时不该套 role=img').not.toContain('role="img"');
    expect(plain).toMatch(/<text[^>]*>[\d.]+<\/text>/); // 刻度文字仍在且可读
    // 有截断说明(实质补充信息)时才用 role=img + 具名
    const truncated = renderToStaticMarkup(createElement(BoxPlot, {
      T, groups: [{ name: 'g', vals: [...Array.from({ length: 3000 }, () => 10), ...Array.from({ length: 600 }, (_, i) => -2000 - i)] }], h: 260,
    } as never));
    expect(truncated).toContain('role="img"');
    expect(truncated).toMatch(/aria-label="[^"]*共 600 个离群观测/);
  });
});

// ──────────────── 蜂群审查整改守护 ────────────────
describe('蜂群审查整改守护', () => {
  it('P1-01 副本未落盘时不得声称「已另存」,更不得覆盖当前编辑', async () => {
    // saveAsCopy 必须返回持久化结果,调用方据此决定能否回放
    useData.getState().importMatrix('原.csv', ['a'], [[1], [2], [3]]);
    const r = useData.getState().saveAsCopy();
    expect(typeof r, 'saveAsCopy 仍只返回名字').toBe('object');
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('outcome');
    expect(typeof r.outcome.persisted).toBe('boolean');

    // 落盘失败(配额满)时 restore 必须取消回看,而不是提示「已另存」后覆盖
    const toasts: string[] = [];
    const origToast = useApp.getState().showToast;
    useApp.setState({ showToast: (t: string) => { toasts.push(t); } });
    const realSet = Storage.prototype.setItem;
    try {
      useData.getState().importMatrix('研究.csv', ['x'], [[1], [2], [3]]);
      useApp.setState({ page: 'summary', activeVar: 'x' });
      const saved = useAnalyses.getState().saveCurrent();
      expect(saved).toBeTruthy();
      // 当前工作表改成同名不同内容 → restore 会先 saveAsCopy
      useData.getState().importMatrix('研究.csv', ['x'], [[9], [8], [7]]);
      const before = useData.getState().model.subs.map((sub) => sub.vals[0]);
      // 让所有 localStorage 写入失败(模拟配额满)
      Storage.prototype.setItem = function blocked() {
        throw new DOMException('quota', 'QuotaExceededError');
      } as typeof realSet;
      toasts.length = 0;
      await expect(useAnalyses.getState().restore(saved!.id)).resolves.toBe(false);
      expect(toasts.some((t) => t.includes('副本未能保存')), `未拒绝回看:${toasts.join(' / ')}`).toBe(true);
      expect(toasts.some((t) => t.includes('已先另存为')), '副本没落盘却声称已另存').toBe(false);
      Storage.prototype.setItem = realSet;
      // 当前编辑必须原样还在
      expect(useData.getState().model.subs.map((sub) => sub.vals[0])).toEqual(before);
    } finally {
      Storage.prototype.setItem = realSet;
      useApp.setState({ showToast: origToast });
    }
  });

  it('P1-02 工作表资源预算是唯一校验器,.qproj/写入口都强制复用', () => {
    // core 校验器本体
    expect(worksheetResourceError({ rows: 2_500_000, cols: 1 })).toMatch(/行上限/);
    expect(worksheetResourceError({ rows: 2, cols: 2_500_000 })).toMatch(/列上限/);
    expect(worksheetResourceError({ rows: 150_000, cols: 100 })).toMatch(/单元格总数/);
    expect(worksheetResourceError({ rows: 2, cols: 2, maxCellChars: 99_999 })).toMatch(/字符上限/);
    expect(worksheetResourceError({ rows: 1000, cols: 10 })).toBeNull();

    // 写入口:超限必须抛,不能写进 store
    const before = useData.getState().model.name;
    expect(() => useData.getState().importMatrix(
      '超大.csv', ['a'], Array.from({ length: 250_000 }, (_, i) => [i]),
    )).toThrow(/行上限/);
    expect(useData.getState().model.name, '超限数据仍被写入').toBe(before);

    // .qproj 校验器:结构合法但维度超限必须拒绝(此前只查结构与有限数)
    const huge = {
      name: '大表', colNames: ['a'],
      rows: Array.from({ length: 250_000 }, (_, i) => [i]),
      savedAt: new Date().toISOString(),
    };
    expect(projectStoreValidationError('qp-dataset-v1', huge), '.qproj 未复用维度预算').toMatch(/资源上限/);
    // 合法尺寸仍放行
    const ok = { name: '小表', colNames: ['a'], rows: [[1], [2], [3]], savedAt: new Date().toISOString() };
    expect(projectStoreValidationError('qp-dataset-v1', ok)).toBeNull();
  });

  it('P2-01 CSV 列数与单元格预算(两行 × 250 万列不得被解析成功)', () => {
    const wide = ['a'.repeat(1), ...Array.from({ length: 9999 }, (_, i) => `c${i}`)].join(',');
    const r = parseMatrix([wide, wide.replace(/c\d+/g, '1'), wide.replace(/c\d+/g, '2')].join('\n'));
    expect('error' in r && r.error, `9999 列未被拒:${JSON.stringify(r).slice(0, 120)}`).toMatch(/列上限|单元格总数/);
  });
});

// ──────────────── 蜂群 P2 整改守护 ────────────────
describe('蜂群 P2 整改守护', () => {
  const gageStudy = (opts: { partStep: number; inter: number; err: number }): GageObservation[] => {
    const out: GageObservation[] = [];
    for (let part = 0; part < 5; part++) {
      for (let operator = 0; operator < 2; operator++) {
        for (let trial = 0; trial < 3; trial++) {
          const inter = (part % 2 === 0 ? 1 : -1) * (operator === 0 ? 1 : -1) * opts.inter;
          const err = (((part * 7 + operator * 3 + trial) % 5) - 2) * opts.err;
          out.push({ part, operator, trial, value: 1000 + part * opts.partStep + inter + err });
        }
      }
    }
    return out;
  };

  it('P2-06 大部件效应不得污染近零判断:真实的微小交互必须给出有限 F', () => {
    // 此前用 1e-12 × max(所有 MS) 判近零,部件 MS 比误差大 4~6 个数量级,
    // 把真实的微小交互与误差一起抹成零(F=0、p=1、retained=false、ndc=∞)
    // 判别夹具:部件效应 1e4/步(量程 4e4),交互 1e-2、误差 4e-3 —— 两者相对量程都在
    // 1e-12×msPart 之下(旧代码把它们一起抹零 → F=0/p=1/ndc=∞),但都远高于浮点噪声界。
    const g = computeGageRR(gageStudy({ partStep: 1e4, inter: 1e-2, err: 4e-3 }), null);
    expect(g.interaction).not.toBeNull();
    expect(Number.isFinite(g.interaction!.fStat), `交互 F 被抹成 ${g.interaction!.fStat}`).toBe(true);
    expect(g.interaction!.fStat, '真实交互被判成 0').toBeGreaterThan(5);
    expect(g.interaction!.fStat).toBeLessThan(100); // 有限且合理,不是 Infinity
    expect(g.interaction!.retained).toBe(true);
    expect(Number.isFinite(g.ndc), `ndc 被抹成 ${g.ndc}`).toBe(true);
    // ndc 的近零阈值同样要收紧到机器精度量级:vGRR/vTotal 落在 (ε×64, 1e-12) 之间时,
    // 旧的 1e-12 会把「极小但真实」的 GRR 抹成 ∞
    const grrRatio = gageStudy({ partStep: 1e4, inter: 1e-2, err: 4e-3 });
    const gr = computeGageRR(grrRatio, null);
    expect(gr.ndc).toBeLessThan(1e7);
    // 对照:真零变异仍须给 F=0 / p=1 / ndc=∞
    const zero = gageStudy({ partStep: 0.7, inter: 0, err: 0 });
    const gz = computeGageRR(zero, null);
    expect(gz.interaction!.fStat).toBe(0);
    expect(gz.interaction!.pValue).toBe(1);
    expect(gz.ndc).toBe(Infinity);
  });

  it('P2-07 回归对合法单位缩放稳定:1e-300~1e154 都给出同一斜率', () => {
    const base = { xs: [1, 2, 3, 4, 5], ys: [2, 4, 6, 8, 10] };
    for (const k of [1, 1e-170, 1e-300, 1e154]) {
      const r = linearRegression(base.xs.map((v) => v * k), base.ys.map((v) => v * k));
      expect(r.slope, `k=${k} 斜率漂移`).toBeCloseTo(2, 10);
      expect(r.r2, `k=${k} R² 非有限`).toBeCloseTo(1, 10);
      expect(Number.isFinite(r.intercept), `k=${k} 截距非有限`).toBe(true);
    }
    // 真正无变异仍须拒绝
    expect(() => linearRegression([5, 5, 5], [1, 2, 3])).toThrow(/无变异/);
    // 非有限输出必须抛错而不是静默给 NaN
    const rr = linearRegression([1, 2, 3], [1, 2, 3]);
    expect(Number.isFinite(rr.slope)).toBe(true);
  });
});

// ──────────────── 蜂群 P2-05 / P3 守护 ────────────────
describe('蜂群 P2-05 与 P3 守护', () => {
  it('P2-05 不显著项不得参与角点排序(噪声不能固化成「唯一最优」)', () => {
    // A 主导且显著、B 效应极小不显著:B 的方向不该被判成有统计证据
    const a = [-1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1];
    const b = [-1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1];
    const y = a.map((av, i) => 50 + 10 * av + 0.0005 * b[i] + (((i % 3) - 1) * 0.4));
    const detected = detectFactorial([{ name: 'A', values: a }, { name: 'B', values: b }], y);
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design);
    const termA = result.terms.find((t) => t.name === 'A')!;
    const termB = result.terms.find((t) => t.name === 'B')!;
    expect(termA.sig, 'A 应显著').toBe(true);
    expect(termB.sig, 'B 应不显著(夹具无效)').toBe(false);
    const optimum = factorialCornerOptimum(result, detected.design, 'maximize');
    // B 不显著 → 不参与排序 → B 的两个水平应并列(而不是被噪声定成唯一)
    expect(optimum.unique, `不显著的 B 被固化成唯一方向:${JSON.stringify(optimum.ties?.map((t) => t.coded))}`).toBe(false);
    expect(optimum.ties.length).toBeGreaterThanOrEqual(2);
    // A 的方向在所有并列角点里必须一致(它有统计证据)
    const aLevels = new Set(optimum.ties.map((t) => t.coded[0]));
    expect(aLevels.size, 'A 显著却未定向').toBe(1);
  });

  it('P3-01 n<6 时中位数区间标注实际覆盖率而非 95%', () => {
    expect(medianCiAchieved(2)).toBeCloseTo(0.5, 10);
    expect(medianCiAchieved(3)).toBeCloseTo(0.75, 10);
    expect(medianCiAchieved(5)).toBeCloseTo(0.9375, 10);
    expect(medianCiAchieved(6)).toBe(0.95);
    expect(computeDescriptive([1, 2, 3]).ciMedianAchieved).toBeCloseTo(0.75, 10);
    // 页面必须按实际覆盖率标注
    useData.getState().importMatrix('小样本.csv', ['x'], [[1], [2], [3]]);
    useApp.setState({ page: 'summary', activeVar: 'x' });
    const { container } = render(createElement(Summary, { T }));
    const text = container.textContent ?? '';
    expect(text, 'n=3 仍无条件标 95%').not.toContain('中位数 95% CI');
    expect(text).toMatch(/中位数 CI（实际 75/);
  });

  it('P3-03 回归线裁剪到绘图区(陡斜率不得越出底边)', () => {
    const markup = renderToStaticMarkup(createElement(ScatterPlot, {
      T, xs: [0, 1, 2], ys: [0, 0, 100], slope: 50, intercept: -16.67, h: 260,
    } as never));
    const lines = [...markup.matchAll(/<line[^>]*y1="([-\d.]+)"[^>]*y2="([-\d.]+)"/g)]
      .map((m) => [Number(m[1]), Number(m[2])]).flat();
    expect(lines.length).toBeGreaterThan(0);
    // 绘图区底边 = H − m.b = 260 − 46 = 214;越过它就压进 X 轴文字区(蜂群 P3-03 实测越 25px)
    const PLOT_BOTTOM = 260 - 46;
    const PLOT_TOP = 26;
    for (const y of lines) {
      expect(y, `回归线越出绘图区下边界:y=${y} > ${PLOT_BOTTOM}`).toBeLessThanOrEqual(PLOT_BOTTOM + 1);
      expect(y, `回归线越出绘图区上边界:y=${y}`).toBeGreaterThanOrEqual(PLOT_TOP - 1);
    }
    expect(markup).not.toMatch(/="[^"]*NaN/);
  });

  it('P3-05 分析记录 ID 唯一(碰撞会一次删多条)', () => {
    useData.getState().importMatrix('研究.csv', ['x'], [[1], [2], [3]]);
    useApp.setState({ page: 'summary', activeVar: 'x' });
    useAnalyses.setState({ saved: [] }); // 与前面用例隔离
    // 强制制造碰撞条件:冻结时间戳 + 固定随机数 + 屏蔽 randomUUID,
    // 旧实现(毫秒戳 + 4 位 base36 随机)在此下必然产出重复 ID
    const realNow = Date.now;
    const realRandom = Math.random;
    const realUuid = globalThis.crypto?.randomUUID;
    try {
      Date.now = () => 1_700_000_000_000;
      Math.random = () => 0.123456789;
      if (globalThis.crypto) {
        Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
      }
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const saved = useAnalyses.getState().saveCurrent();
        if (saved) ids.add(saved.id);
      }
      expect(ids.size, `ID 碰撞:${useAnalyses.getState().saved.length} 条记录只有 ${ids.size} 个不同 ID`)
        .toBe(useAnalyses.getState().saved.length);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      if (globalThis.crypto && realUuid) {
        Object.defineProperty(globalThis.crypto, 'randomUUID', { value: realUuid, configurable: true });
      }
    }
  });
});

// ──────────────── 蜂群 P2 剩余项守护 ────────────────
describe('蜂群 P2 剩余项守护', () => {
  it('P2-02 撤销栈有字节预算(20 层整表快照不得占数百 MB)', () => {
    // 20 万×10 的合法工作表连续编辑,实测旧实现仅快照就占 ~647 MiB
    // 每层快照 ≈ 4 万×10×8B = 3.2MB;20 层 = 64MB > 48MB 预算 → 必须被裁
    const rows = Array.from({ length: 40_000 }, (_, i) => Array.from({ length: 10 }, (_, j) => i + j));
    useData.getState().importMatrix('大表.csv', Array.from({ length: 10 }, (_, j) => `c${j}`), rows);
    for (let i = 0; i < 20; i++) useData.getState().updateCell(0, 0, i + 1);
    const stack = useData.getState().undoStack;
    expect(stack.length).toBeLessThanOrEqual(20);
    expect(stack.length, '字节预算未生效:20 层全留下了').toBeLessThan(20);
    const bytes = stack.reduce(
      (sum, snap) => sum + snap.rows.reduce((n, r) => n + r.length, 0) * 8, 0,
    );
    expect(bytes, `撤销栈占用 ${(bytes / 1048576).toFixed(0)} MB`).toBeLessThanOrEqual(48 * 1024 * 1024);
    // 撤销仍可用
    const before = useData.getState().model.subs[0].vals[0];
    useData.getState().undoEdit();
    expect(useData.getState().model.subs[0].vals[0]).not.toBe(before);
  });

  it('P2-03 备用 Windows 工作流不得注入签名私钥', () => {
    const wf = readFileSync('.github/workflows/build-windows.yml', 'utf8');
    expect(wf, '任意分支可触发的工作流仍在注入签名私钥').not.toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(wf).toContain('不签名');
    // 正式发版路径仍须签名
    const rel = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(rel).toContain('TAURI_SIGNING_PRIVATE_KEY');
  });

  it('P2-04 XLSX 在解压前按 ZIP 中央目录预检规模', async () => {
    // 构造一个中央目录声明「解压后 1GB」的最小 zip 尾部
    const buildFakeZip = (uncompressed: number, compressed: number) => {
      const local = new Uint8Array(31 + compressed);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(8, 8, true);
      lv.setUint32(18, compressed, true);
      lv.setUint32(22, uncompressed, true);
      lv.setUint16(26, 1, true);
      local[30] = 0x61;
      const cd = new Uint8Array(47);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(10, 8, true);
      cv.setUint32(20, compressed, true);
      cv.setUint32(24, uncompressed, true);
      cv.setUint16(28, 1, true);
      cv.setUint32(42, 0, true);          // 本地文件头偏移
      cd[46] = 0x61;
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, 1, true);           // 本磁盘条目数
      ev.setUint16(10, 1, true);          // 条目数
      ev.setUint32(12, cd.byteLength, true);
      ev.setUint32(16, local.byteLength, true); // 中央目录偏移
      const out = new Uint8Array(local.length + cd.length + eocd.length);
      out.set(local, 0);
      out.set(cd, local.length);
      out.set(eocd, local.length + cd.length);
      return out;
    };
    // 单条目解压后 1GB → 超 64MB 上限
    expect(() => assertXlsxArchiveBudget(buildFakeZip(1024 * 1024 * 1024, 1024))).toThrow(/解压后|压缩比/);
    // 压缩比 100000:1 → 超 400:1 上限
    expect(() => assertXlsxArchiveBudget(buildFakeZip(10 * 1024 * 1024, 100))).toThrow(/压缩比|解压后/);
    // 正常比例放行
    expect(() => assertXlsxArchiveBudget(buildFakeZip(50_000, 10_000))).not.toThrow();
    // **调用点**也要守住:xlsxBytesToCsv 必须在解压前就调用它
    const bomb = await xlsxBytesToCsv(buildFakeZip(1024 * 1024 * 1024, 1024));
    expect('error' in bomb, 'xlsxBytesToCsv 未在解压前预检').toBe(true);
    if ('error' in bomb) expect(bomb.error).toMatch(/解压后|压缩比|条目/);
  });

  it('P3-02 不得声明未实现键盘模型的复合控件角色', () => {
    for (const f of ['src/ui/shell/MenuBar.tsx', 'src/ui/shell/Toolbar.tsx']) {
      const src = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
      expect(src, `${f} 仍声明 menu/listbox 复合角色但未实现其键盘模型`)
        .not.toMatch(/role="(menu|menuitem|listbox|option)"/);
      expect(src).not.toContain('aria-haspopup="menu"');
      expect(src).not.toContain('aria-haspopup="listbox"');
    }
    // disclosure 语义仍在
    expect(readFileSync('src/ui/shell/MenuBar.tsx', 'utf8')).toContain('aria-expanded');
  });

  it('P2-08 Web 端根节点不再固定 minWidth,桌面壳保留', () => {
    // 剥注释后再判(注释里提到 minWidth:1180 是在解释这条修复)
    const app = readFileSync('src/App.tsx', 'utf8').replace(/\/\/[^\n]*/g, '');
    expect(app, '根节点仍内联固定 minWidth:1180').not.toMatch(/minWidth:\s*1180/);
    expect(app).toContain('app-root');
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toContain('html.is-desktop .app-root');
    expect(css).toMatch(/@media \(max-width: 1179px\)/);
    expect(readFileSync('src/main.tsx', 'utf8')).toContain('is-desktop');
  });
});
