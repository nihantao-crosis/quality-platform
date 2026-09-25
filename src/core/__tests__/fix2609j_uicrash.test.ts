/**
 * fix2609j G18-uicrash(核心/平台层):
 * - CORE-07:recommendGageRoles 的 O(类别列数²×行数) 交叉平衡打分——三角色均已手选时 effectiveGageSelection
 *   仍无条件全量打分(结果随即被丢弃);同一 (model,textCols) 在 MSA 页/壳层/prepareGageStudy 间重复打分。
 * - PLATFORM-06:sanitizeFileName 在完整原串上跑 /[. ]+$/(二次方回溯)后才截断。
 * - PLATFORM-18:sanitizeFileName 按 UTF-16 码元截到 80 位,可能留下孤立代理项(Tauri IPC serde_json 拒收)。
 * 全部调用真实生产函数。
 */
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  computeVarModel, effectiveGageSelection, prepareGageStudy, recommendGageRoles, updateVarModelCell,
} from '..';
import { __gageRecommendationComputeCountForTests, type GageTextColumn } from '../gageData';
import { sanitizeFileName } from '../../platform/reportLabels';

/** MES 多工位计数宽表:列名不含关键词,全部小整数(每列都会进入部件×操作员两两配对)。 */
function wideSmallIntTable(rows: number, cols: number) {
  const colNames = Array.from({ length: cols }, (_, c) => `工位${c + 1}`);
  const data: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) row.push(((r * (c + 3)) >> (c % 5)) % (2 + (c % 6)));
    data.push(row);
  }
  return computeVarModel('MES宽表', colNames, data);
}

const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('CORE-07 recommendGageRoles 按需+记忆化', () => {
  it('三角色均已手选:effectiveGageSelection 不再打分(2000×60 宽表修复前 ~0.5s,结果被整份丢弃)', () => {
    const M = wideSmallIntTable(2000, 60);
    const stored = { value: '工位1', part: '工位2', operator: '工位3' };
    const before = __gageRecommendationComputeCountForTests();
    const t0 = performance.now();
    const selection = effectiveGageSelection(M, [], stored);
    const elapsed = performance.now() - t0;
    expect(selection).toEqual({ valueColumn: '工位1', partColumn: '工位2', operatorColumn: '工位3' });
    expect(__gageRecommendationComputeCountForTests() - before).toBe(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('同一 (model,textCols) 只打分一次:推荐结果按引用记忆,MSA 页/effectiveGageSelection/prepareGageStudy 共享', () => {
    const M = wideSmallIntTable(1500, 30);
    const textCols: GageTextColumn[] = []; // store 中的 textCols 引用稳定,与此同构
    const before = __gageRecommendationComputeCountForTests();
    const a = recommendGageRoles(M, textCols);
    const t0 = performance.now();
    const b = recommendGageRoles(M, textCols);
    const second = performance.now() - t0;
    expect(b).toBe(a); // 修复前每次返回新对象(且重新全量打分)
    expect(second).toBeLessThan(5);
    effectiveGageSelection(M, textCols, { value: null, part: null, operator: null });
    prepareGageStudy(M, textCols, { valueColumn: null, partColumn: null, operatorColumn: null });
    expect(__gageRecommendationComputeCountForTests() - before).toBe(1);
  });

  it('记忆不陈旧:单元格编辑产生新模型、文本列换引用都会重新打分,推荐随数据变化', () => {
    // 列名不含关键词:X 为含小数的连续测量,P/O 为 3×2 交叉、每胞 2 次
    const rows: number[][] = [];
    for (let p = 0; p < 3; p++) for (let o = 0; o < 2; o++) for (let t = 0; t < 2; t++) rows.push([p + 1, o + 1, 10 + p * 0.1 + t * 0.013 + o * 0.007]);
    const M = computeVarModel('Gage', ['P', 'O', 'X'], rows);
    const noText: GageTextColumn[] = [];
    const before = __gageRecommendationComputeCountForTests();
    const rec1 = recommendGageRoles(M, noText);
    expect(rec1.value).toBe('X');
    // 把 X 改成少量重复的小整数 → 呈类别/ID 形态,不再自动当测量(新模型引用 → 必须重算)
    let M2 = M;
    for (let r = 0; r < M.k; r++) M2 = updateVarModelCell(M2, r, 2, r % 3);
    const rec2 = recommendGageRoles(M2, noText);
    expect(rec2).not.toBe(rec1);
    expect(rec2.value).toBeNull();
    // 旧模型仍命中旧结果(不同模型各自记忆,互不串扰)
    expect(recommendGageRoles(M, noText)).toBe(rec1);
    // 文本列换引用(即使内容相同)也重算——不按内容猜等价,杜绝陈旧推荐
    const text1 = [{ name: '班组', values: M.subs.map((_, i) => (i % 2 ? '甲' : '乙')) }];
    const r3 = recommendGageRoles(M, text1);
    const r4 = recommendGageRoles(M, text1.map((c) => ({ ...c, values: [...c.values] })));
    expect(r4).not.toBe(r3);
    expect(r4).toEqual(r3);
    // M、M2、text1、text1 副本 = 4 次实际打分;重复查询不计
    expect(__gageRecommendationComputeCountForTests() - before).toBe(4);
  });
});

describe('PLATFORM-06 sanitizeFileName 线性时间(ReDoS)', () => {
  it('100 万个空格/点 + 普通字符结尾:<50ms(修复前 8 万字符即 ~2.5s,二次方增长)', () => {
    for (const evil of [' '.repeat(1_000_000) + 'x', '.'.repeat(1_000_000) + '项目', '. '.repeat(500_000) + 'z']) {
      const t0 = performance.now();
      const out = sanitizeFileName(evil);
      const elapsed = performance.now() - t0;
      expect(elapsed, `输入形状 ${JSON.stringify(evil.slice(0, 4))}… 耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(50);
      expect(out.length).toBeLessThanOrEqual(80);
      expect(out).not.toMatch(/[. ]$/);
      expect(out).toBeTruthy();
    }
  });

  it('截断后不得再以点/空格结尾(修复前先清洗后截断,截断点落在空格串里会留下尾随空格)', () => {
    const out = sanitizeFileName('质检' + ' '.repeat(100) + '结尾');
    expect(out).toBe('质检');
    expect(sanitizeFileName('名字' + '.'.repeat(90) + 'x')).toBe('名字');
  });

  it('既有口径不变:非法字符/控制字符/保留名/尾随点空格/空串兜底', () => {
    expect(sanitizeFileName('正常名')).toBe('正常名');
    expect(sanitizeFileName('a/b:c*d')).toBe('a_b_c_d');
    expect(sanitizeFileName('a\u0000b\u001fc')).toBe('a_b_c');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('名字. ')).toBe('名字');
    expect(sanitizeFileName('///')).toBe('___');
    expect(sanitizeFileName('. . ')).toBe('未命名');
    expect(sanitizeFileName('长'.repeat(500))).toBe('长'.repeat(80));
    // 保留名加前缀后超长:仍 ≤80 码元且不以点/空格结尾
    const reserved = sanitizeFileName('CON.' + 'a'.repeat(75) + ' b');
    expect(reserved.startsWith('_CON.')).toBe(true);
    expect(reserved.length).toBeLessThanOrEqual(80);
    expect(reserved).not.toMatch(/[. ]$/);
  });
});

describe('PLATFORM-18 sanitizeFileName 不切断代理对', () => {
  it('emoji 高代理落在第 80 码元:修复前留下孤立 0xD83D,修复后整字舍去且结果 well-formed', () => {
    const out = sanitizeFileName('质检项目'.repeat(19) + '批次说😀明');
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe('质检项目'.repeat(19) + '批次说');
    expect(out.length).toBe(79);
    // IPC 往返:JSON 中不得出现孤立代理转义
    expect(JSON.stringify({ defaultPath: `${out}_2026-09-26.qproj` })).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it('CJK 扩展 B 生僻字「𠮷」跨界同理;边界内的代理对完整保留', () => {
    expect(sanitizeFileName('A'.repeat(79) + '𠮷' + 'B')).toBe('A'.repeat(79));
    expect(sanitizeFileName('A'.repeat(78) + '𠮷' + 'B')).toBe('A'.repeat(78) + '𠮷');
    // 扫描全部对齐位置:任何前缀长度都不产生孤立代理,且 UTF-16 长度 ≤80(字节预算不放宽)
    for (let prefix = 0; prefix <= 84; prefix++) {
      const out = sanitizeFileName('x'.repeat(prefix) + '😀'.repeat(3) + 'tail');
      expect(isWellFormed(out), `prefix=${prefix}`).toBe(true);
      expect(out.length).toBeLessThanOrEqual(80);
    }
    // 全 emoji:40 个完整代理对
    expect(sanitizeFileName('😀'.repeat(100))).toBe('😀'.repeat(40));
  });

  it('原串自带孤立代理项(畸形文件名)也被替换,不进 IPC', () => {
    const out = sanitizeFileName(`报表\uD83D名\uDE00称`);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe('报表_名_称');
  });
});
