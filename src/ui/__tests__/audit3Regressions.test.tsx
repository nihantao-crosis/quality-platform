/* eslint-disable no-control-regex -- 断言正是「产物不含控制字符」,正则必须含控制字符 */
/** 第三轮审计整改回归(v1.43.0):P1×3、P2 批与「零覆盖修复」全部补守护。
 * @vitest-environment jsdom */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import {
  parseMatrix, parseCategoryCounts, MAX_IMPORT_DATA_ROWS, probPlotPoints, ewmaSeries, invNorm,
  calcKey, CALC_INIT, computeVarModel, assessSpcCharts, DEFAULT_RULE_K,
} from '../../core';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { decodeTextFileBytes } from '../../platform/adapter';
import { xlsxBytesToCsv } from '../../platform/xlsxImport';
import { mesStart, mesStop } from '../../platform/mes';
import { chartTokens } from '../../ui/tokens';
import { ControlChart } from '../../ui/charts/ControlChart';

beforeEach(() => {
  localStorage.clear();
  mesStop();
  useData.getState().resetDemo();
  useApp.setState({ spcRules: DEFAULT_SPC_RULES, spcRuleK: DEFAULT_RULE_K, page: 'spc' });
});

// ---------- P1:findReplace 不得清除占位标记 ----------
describe('findReplace × 待录入占位(第三轮 P1:半边修收口)', () => {
  it('find=0 替换时占位格既不参与也不失去「待录入」标记', () => {
    useData.getState().importMatrix('占位.csv', ['x', 'y'], [[0, 1], [2, 0]], [], [{ row: 0, col: 0 }]);
    const hits = useData.getState().findReplace(0, 9, -1);
    // 只有 (1,1) 的真实 0 被替换;(0,0) 是占位
    expect(hits).toBe(1);
    expect(useData.getState().model.subs[1].vals[1]).toBe(9);
    expect(useData.getState().model.subs[0].vals[0]).toBe(0);
    expect(useData.getState().pendingCells).toContainEqual({ row: 0, col: 0 });
  });
});

// ---------- P1:CSV 行数上限 ----------
describe('CSV 行数上限(第三轮 P1:260 万行 OOM 包线)', () => {
  it('超过 MAX_IMPORT_DATA_ROWS 拒绝并给出可执行指引', () => {
    const lines = ['x', ...Array.from({ length: MAX_IMPORT_DATA_ROWS + 1 }, (_, i) => String(i))];
    const r = parseMatrix(lines.join('\n'));
    expect('error' in r && r.error).toContain('行上限');
  });
});

// ---------- P1:Word 大表截断 ----------
describe('Word 专项大表(第三轮 P1:detailTable 行上限)', () => {
  it('2500 行表格 → 只渲染 2000 行并明示截断', async () => {
    const analysis = {
      kind: 'spc', title: '大表', subtitle: 's', generatedAt: '2026-07-26',
      summary: ['ok'], warnings: [],
      tables: [{ title: '观测', headers: ['a'], rows: Array.from({ length: 2500 }, (_, i) => [i]) }],
      charts: [],
    } as never;
    const M = computeVarModel('w.csv', ['x'], [[1], [2], [3]]);
    const bytes = await buildDocx(M, { lsl: 0, tgt: 1, usl: 2 }, {}, null, analysis);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('仅列前 2000 行');
    expect(xml).toContain('完整明细请导出 Excel');
  });
});

// ---------- P2:cleanXml 全字段注入矩阵 ----------
describe('OOXML 控制字符全字段注入(第三轮:结构性守护)', () => {
  const dirty = (t: string) => `${t}`;
  const payload = {
    kind: 'spc', title: dirty('标题'), subtitle: dirty('副题'), generatedAt: dirty('2026-07-26'),
    summary: [dirty('结论一')], warnings: [dirty('注意')],
    tables: [{ title: dirty('表'), headers: [dirty('列')], rows: [[dirty('值')]], note: dirty('注') }],
    charts: [],
  } as never;
  const M = computeVarModel(dirty('脏表.csv'), ['x'], [[1], [2], [3]]);

  it('Word:全部字段注入后 XML 良构且不含控制字符', async () => {
    const bytes = await buildDocx(M, { lsl: 0, tgt: 1, usl: 2 }, {}, null, payload);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).not.toMatch(/[]/);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
  });

  it('PPT:全部字段注入后每页 XML 良构且不含控制字符', async () => {
    const bytes = await buildPptx(M, { lsl: 0, tgt: 1, usl: 2 }, {}, null, payload);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const xml = await zip.file(n)!.async('string');
      expect(xml).not.toMatch(/[]/);
      expect(new DOMParser().parseFromString(xml, 'text/xml').querySelector('parsererror')).toBeNull();
    }
  });
});

// ---------- P2:帕累托空类别全路径 ----------
describe('帕累托空类别拒绝(第三轮:守卫覆盖全部解析路径)', () => {
  it('默认两列粘贴路径', () => {
    const r = parseCategoryCounts('划伤,5\n,3\n毛刺,2');
    expect('error' in r && r.error).toContain('空类别名');
  });
  it('横排转置路径(类别在首行、频数在次行)', () => {
    // 复审 P3:旧夹具与上一条逐字相同,根本没走转置分支
    const r = parseCategoryCounts('划伤,,毛刺\n5,3,2');
    expect('error' in r && r.error).toContain('空类别名');
    const ok = parseCategoryCounts('划伤,凹陷,毛刺\n5,3,2');
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) expect(ok.rows.map((x) => x.name)).toEqual(['划伤', '凹陷', '毛刺']);
  });
  it('显式选列路径(自带逐行校验,文案不同但同样拒绝)', () => {
    const r = parseCategoryCounts('划伤,5\n  ,3', { categoryColumn: 0, countColumn: 1 });
    expect('error' in r && /空类别名|类别列为空/.test(r.error)).toBe(true);
  });
  it('合法数据不受影响', () => {
    const r = parseCategoryCounts('划伤,5\n毛刺,3');
    expect('error' in r).toBe(false);
  });
});

// ---------- 写入口守卫矩阵 ----------
describe('数值/日期写入口守卫(第三轮:守护补齐)', () => {
  it('setSpec 拒 Infinity;setGageOptions 拒 Infinity 公差与非法日历日期;t1Mu0 拒 Infinity', () => {
    const { setSpec, setGageOptions, setHypothesisOptions } = useApp.getState();
    const lsl0 = useApp.getState().lsl;
    setSpec({ lsl: Infinity });
    expect(useApp.getState().lsl).toBe(lsl0);
    setGageOptions({ gageTolValue: Infinity });
    expect(useApp.getState().gageTolValue).not.toBe(Infinity);
    setGageOptions({ gageStudyDate: '2026-02-30' });
    expect(useApp.getState().gageStudyDate).not.toBe('2026-02-30');
    setGageOptions({ gageStudyDate: '2026-02-28' });
    expect(useApp.getState().gageStudyDate).toBe('2026-02-28');
    setHypothesisOptions({ t1Mu0: Infinity });
    expect(useApp.getState().t1Mu0).not.toBe(Infinity);
  });
});

// ---------- 编码回退 ----------
describe('文本解码(第三轮:GBK/BOM 两端口径)', () => {
  it('GBK 字节按 GB18030 解出中文', async () => {
    // 「中文」的 GBK 编码:D6 D0 CE C4
    const blob = new Blob([new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4, 0x2C, 0x31])]);
    expect(await decodeTextFileBytes(blob)).toBe('中文,1');
  });
  it('UTF-8 BOM 权威:与 Rust 同一 EF BB BF FF 0A 31 0A 32 反例严格拒绝，不落 GB18030 回退', async () => {
    // BOM + 0xFF + "\\n1\\n2"；0xFF 在 UTF-8 中永远非法，Rust read_text_file 也须拒绝。
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF, 0xFF, 0x0A, 0x31, 0x0A, 0x32])]);
    await expect(decodeTextFileBytes(blob)).rejects.toThrow('非法 UTF-8');
  });
  it('UTF-8/GB18030 都非法时拒绝，不生成替换字符', async () => {
    // GB18030 双字节序列的首字节不能单独结束文件。
    const blob = new Blob([new Uint8Array([0x81])]);
    await expect(decodeTextFileBytes(blob)).rejects.toThrow('既不是有效 UTF-8');
  });
  it('纯 UTF-8 原样', async () => {
    const blob = new Blob([new TextEncoder().encode('直径,25.1')]);
    expect(await decodeTextFileBytes(blob)).toBe('直径,25.1');
  });
});

// ---------- xlsx 原始数值 ----------
describe('xlsx 数字单元格按原始值导入(第三轮 P3)', () => {
  it('千分位显示格式不再把数值降成格式文本', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([[ '量测' ], [12345.678901234], [23456.789012345]]);
    sheet['A2'].z = '#,##0';
    sheet['A3'].z = '#,##0';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'S1');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const out = await xlsxBytesToCsv(bytes);
    expect('csv' in out).toBe(true);
    if (!('csv' in out)) return;
    expect(out.csv).toContain('12345.678901234');
    expect(out.csv).not.toContain('12,346');
  });
});

// ---------- MES / 回看 / 副本 ----------
describe('数据安全三连守护(第三轮:回看另存/MES 自停/副本唯一化)', () => {
  it('MES 采集中切换数据集 → 下一 tick 自停,不追加', () => {
    vi.useFakeTimers();
    try {
      useData.getState().importMatrix('真实.csv', ['a'], [[1], [2]]);
      mesStart();
      vi.advanceTimersByTime(1700); // 两个 tick,采集正常增长
      const mesK = useData.getState().model.k;
      expect(mesK).toBeGreaterThan(2);
      useData.getState().importMatrix('真实2.csv', ['a'], [[1], [2]]);
      vi.advanceTimersByTime(3000);
      expect(useData.getState().model.name).toBe('真实2.csv');
      expect(useData.getState().model.k).toBe(2);
      expect(useData.getState().mesRunning).toBe(false);
    } finally {
      mesStop();
      vi.useRealTimers();
    }
  });

  it('快照回看遇同名后续编辑 → 先另存副本再回放,编辑不丢失', async () => {
    useData.getState().importMatrix('压力.csv', ['x'], [[10], [11], [12]]);
    useApp.setState({ page: 'spc' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).not.toBeNull();
    useData.getState().updateCell(0, 0, 999);
    expect(useData.getState().model.subs[0].vals[0]).toBe(999);
    const ok = await useAnalyses.getState().restore(saved!.id);
    expect(ok).toBe(true);
    // 活动集回到快照内容
    expect(useData.getState().model.subs[0].vals[0]).toBe(10);
    // 编辑值在自动另存的副本里幸存
    const stash = useData.getState().recents.find((r) => r.name.includes('副本'));
    expect(stash).toBeDefined();
    expect(stash!.data?.rows[0][0]).toBe(999);
  });

  it('恢复演示后编辑的副本名唯一化,不覆盖旧副本', () => {
    useData.getState().updateCell(0, 0, 111);
    const first = useData.getState().model.name;
    expect(first).toContain('副本');
    useData.getState().resetDemo();
    useData.getState().updateCell(0, 0, 222);
    const second = useData.getState().model.name;
    expect(second).not.toBe(first);
    const firstEntry = useData.getState().recents.find((r) => r.name === first);
    expect(firstEntry?.data?.rows[0][0]).toBe(111);
  });
});

// ---------- ControlChart 判异约定 ----------
describe('「判异集显式传 ControlChart」约定守护', () => {
  it('violations=空集时不回退自算:超限点不标红', () => {
    const T = chartTokens('经典', true);
    const { container } = render(createElement(ControlChart, {
      T, data: [1, 1, 50, 1], cl: 1, ucl: 2, lcl: 0, clLabel: 'X̄', h: 200,
      violations: new Set<number>(),
    }));
    expect(container.querySelectorAll('circle[fill="#d21f26"]')).toHaveLength(0);
  });

  it('源码扫描:pages/platform 下每个 <ControlChart 用法都显式传 violations', () => {
    const roots = ['src/ui/pages', 'src/platform'];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of readdirSync(root)) {
        if (!/\.tsx?$/.test(f)) continue;
        const text = readFileSync(join(root, f), 'utf8');
        let idx = 0;
        while ((idx = text.indexOf('<ControlChart', idx)) >= 0) {
          const after = text[idx + '<ControlChart'.length];
          if (after !== undefined && /[A-Za-z]/.test(after)) { idx += 13; continue; } // 跳过类型名 ControlChartProps 等
          const end = text.indexOf('/>', idx);
          const usage = text.slice(idx, end < 0 ? idx + 400 : end);
          if (!usage.includes('violations=')) offenders.push(`${f}:${text.slice(0, idx).split('\n').length}`);
          idx += 13;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------- 统计锚点补齐 ----------
describe('外部锚点补齐(第三轮:概率图/EWMA/计算器)', () => {
  it('概率图打点 = Benard 中位秩 (i−0.3)/(n+0.4),n=5 与手册值逐位', () => {
    const pts = probPlotPoints([5, 1, 3, 2, 4]);
    expect(pts.map((p) => p.x)).toEqual([1, 2, 3, 4, 5]);
    // 真锚点(对抗审查:此前断言 Blom 也能通过——空洞):z₁ = Φ⁻¹(0.7/5.4) = −1.1263…,
    // Blom 首点 Φ⁻¹(0.625/5.25)=Φ⁻¹(0.11905)=−1.1797,3 位小数即可区分两公式
    expect(pts[0].z).toBeCloseTo(invNorm(0.7 / 5.4), 6);
    expect(pts[0].z).toBeCloseTo(-1.128, 2); // Blom 首点为 −1.180,2 位小数即可区分
    expect(pts[1].z).toBeCloseTo(invNorm(1.7 / 5.4), 6);
    expect(pts[2].z).toBeCloseTo(0, 10);
    expect(pts[0].z).toBeCloseTo(-pts[4].z, 10);
  });

  it('EWMA 默认参数渐近限 = μ ± 0.9σ(λ=0.2, L=2.7 → L·√(λ/(2−λ)) = 0.9)', () => {
    const r = ewmaSeries(Array.from({ length: 60 }, () => 0), 0, 1);
    expect(r.ucl[r.ucl.length - 1]).toBeCloseTo(0.9, 6);
    expect(r.lcl[r.lcl.length - 1]).toBeCloseTo(-0.9, 6);
  });

  it('计算器大数不再被尾零剪裁成错值:9999999×9999999 精确显示', () => {
    let c = CALC_INIT;
    for (const k of ['9', '9', '9', '9', '9', '9', '9', '×', '9', '9', '9', '9', '9', '9', '9', '=']) c = calcKey(c, k);
    // 旧实现(裸剪尾零)给 '99999980000001' → '9999998'; 我的 1e12 指数阈值又给 '9.999998e+13'
    expect(c.disp).toBe('99999980000001');
  });

  it('计算器整数尾零不被剪:1e20 与 1e12 都保留完整位数', () => {
    const run = (keys: string[]) => keys.reduce((c, k) => calcKey(c, k), CALC_INIT);
    expect(run(['1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '×', '1', '0', '=']).disp).toBe('10000000000000');
    expect(run(['0', '.', '1', '+', '0', '.', '2', '=']).disp).toBe('0.3');
  });
});

// ---------- 单值观测 SPC 快速回归(防止本批重构破坏既有口径) ----------
describe('回归哨兵:I-MR 判异口径未被本批触碰', () => {
  it('尖峰夹具计数不变', () => {
    const values: number[][] = [[10], [30], [10]];
    for (let k = 0; k < 17; k++) values.push([k % 2 === 0 ? 10.05 : 10]);
    const M = computeVarModel('哨兵.csv', ['x'], values);
    const a = assessSpcCharts(M, { ...DEFAULT_SPC_RULES, r2: false, r3: false, r5: false }, DEFAULT_RULE_K, 'i-mr');
    expect(a.chartPointCount).toBe(3);
    expect(a.uniqueAnalysisUnitCount).toBe(2);
  });
});

describe('帕累托解析边界(spread 栈溢出与类别数上限)', () => {
  it('超过 20 万条原始记录时在构造 cells 前拒绝，不再等待合并后类别数', () => {
    const text = Array.from({ length: 200001 }, (_, i) => `类${i},1`).join('\n');
    const r = parseCategoryCounts(text);
    expect('error' in r && r.error).toContain('原始记录数超过');
  });

  it('闭环审核:上限按合并后类别数,不误伤「单列 20 万条标签自动计数」(仅 3 类)', () => {
    const labels = ['划伤', '毛刺', '变形'];
    const text = Array.from({ length: 200000 }, (_, i) => labels[i % 3]).join('\n');
    const r = parseCategoryCounts(text);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rows).toHaveLength(3);
    expect(r.rows.reduce((sum, row) => sum + row.count, 0)).toBe(200000);
  });

  it('闭环审核:横排两行自动转置路径同样受上限约束(此前整条绕过)', () => {
    const names = Array.from({ length: 60001 }, (_, i) => `类${i}`).join(',');
    const counts = Array.from({ length: 60001 }, () => '1').join(',');
    const r = parseCategoryCounts(`${names}\n${counts}`);
    expect('error' in r && r.error).toContain('类别数超过');
  });
});
