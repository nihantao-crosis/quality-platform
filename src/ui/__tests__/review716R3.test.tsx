/** @vitest-environment jsdom */
/** 批次716-R3(我方主线部分):P 图双侧截断真 σ 直传 + X̄-R 合并双面板。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { evalLimitedRules, DEFAULT_RULE_K } from '../../core';
import { Spc } from '../pages/Spc';
import { chartTokens } from '../tokens';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ spcType: 'xbar-r', spcRuleK: { ...DEFAULT_RULE_K }, spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null });
});

describe('P2-1 根治:P 图双侧同时截断时用真 σ 判异(Codex v1.37 探针)', () => {
  const rules = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
  it('p̄=0.5,n=2:限值钳到 [0,1],传真 σ 后 p=1(1.414σ)不再被 K1=2 误报', () => {
    const pbar = 0.5;
    const sigma = Math.sqrt(pbar * (1 - pbar) / 2); // 0.353553
    const ucl = Math.min(1, pbar + 3 * sigma); // 1(截断)
    const lcl = Math.max(0, pbar - 3 * sigma); // 0(截断)
    const withSigma = evalLimitedRules([1, 0, 0.5], pbar, ucl, lcl, rules, { ...DEFAULT_RULE_K, k1: 2 }, sigma);
    expect(withSigma.viol.size).toBe(0);
    // 不传 σ 的回退路径在双侧截断下确会低估(文档化调用方必须传 σ 的原因)
    const fallback = evalLimitedRules([1], pbar, ucl, lcl, rules, { ...DEFAULT_RULE_K, k1: 2 });
    expect(fallback.viol.size).toBe(1);
  });
  it('逐点 σ 数组(变动 nᵢ):各点按各自 σᵢ 判', () => {
    const pbar = 0.9;
    const ns = [10, 200];
    const sigmas = ns.map((n) => Math.sqrt(pbar * (1 - pbar) / n)); // 0.0949 / 0.0212
    const ucls = ns.map((n) => Math.min(1, pbar + 3 * Math.sqrt(pbar * (1 - pbar) / n)));
    const lcls = ns.map((n) => Math.max(0, pbar - 3 * Math.sqrt(pbar * (1 - pbar) / n)));
    // p=1:对 n=10 是 1.05σ(不报);对 n=200 是 4.7σ(K1=2 应报)
    const r = evalLimitedRules([1, 1], pbar, ucls, lcls, rules, { ...DEFAULT_RULE_K, k1: 2 }, sigmas);
    expect([...r.viol]).toEqual([1]);
  });
});

describe('X̄-R 合并双面板(人工反馈716 PPT 第4页)', () => {
  it('演示集 Xbar-R:单卡标题「直径 的 Xbar-R 控制图」,含上下两块画布,不再有独立均值/极差卡标题', () => {
    const html = render(createElement(Spc, { T: chartTokens('经典', true) })).container.innerHTML;
    expect(html).toContain('直径 的 Xbar-R 控制图');
    expect(html).toContain('上:均值 X̄ / 下:极差 R');
    expect(html).not.toContain('的均值控制图 (X̄)</div>');
    expect(html).not.toContain('的极差控制图 (R)</div>');
    // 两块 SVG 都在同一卡内:子组均值与子组极差的 y 轴题都出现
    expect(html).toContain('直径 · 子组均值');
    expect(html).toContain('直径 · 子组极差');
  });
  it('X̄-S 同样合并;I-MR 保持独立卡(MR 少一点,横轴无法逐点对齐)', () => {
    useApp.setState({ spcType: 'xbar-s' });
    const s = render(createElement(Spc, { T: chartTokens('经典', true) })).container.innerHTML;
    expect(s).toContain('直径 的 Xbar-S 控制图');
    cleanup();
    useApp.setState({ spcType: 'i-mr' });
    const imr = render(createElement(Spc, { T: chartTokens('经典', true) })).container.innerHTML;
    expect(imr).toContain('的单值控制图 (I)');
    expect(imr).toContain('的移动极差图 (MR)');
  });
});

// ================= 对抗自查(wf_c53beb1d)确认缺陷的防回归 =================
import { useAnalyses } from '../../store/analyses';
import { generateFractionalFactorialDesign, DEFAULT_RULES, parseMatrix } from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';

describe('自查:分数因子(5–7 因子)保存卡与专项报告与分析页同源', () => {
  function importFractional51() {
    const gen = generateFractionalFactorialDesign(
      [
        { name: 'A', low: -1, high: 1 }, { name: 'B', low: -1, high: 1 }, { name: 'C', low: -1, high: 1 },
        { name: 'D', low: -1, high: 1 }, { name: 'E', low: -1, high: 1 },
      ], 1, { randomize: false },
    );
    // 用生成的 16 行 2^(5-1)(E=ABCD)构造工作表:响应只由 E 驱动
    const eIdx = gen.colNames.indexOf('E');
    const rows = gen.rows.map((row, i) => [...row.slice(0, gen.colNames.length), 10 + 6 * row[eIdx] + i * 0.001]);
    useData.getState().importMatrix('分数因子样例', [...gen.colNames, '响应'], rows, gen.textCols ?? []);
    useApp.setState({
      page: 'doe', doeFactorCols: ['A', 'B', 'C', 'D', 'E'], doeRespCol: '响应',
      doeModelTerms: null, doeIncludeCurvature: true,
    });
  }

  it('保存卡:标题 5 因子,显著项含 E,不再出现 A×B×C×D 冒名', () => {
    importFractional51();
    useAnalyses.getState().saveCurrent();
    const saved = useAnalyses.getState().saved[0];
    expect(saved.title).toContain('5 因子');
    expect(saved.metric).toContain('E');
    expect(saved.metric).not.toContain('A×B×C×D');
    expect(saved.status).toBe('已分析');
  });

  it('专项报告:副标题 5 因子,显著项表含 E', () => {
    importFractional51();
    const report = buildActiveAnalysisReport();
    expect(report?.kind).toBe('doe');
    const text = JSON.stringify(report);
    expect(text).toContain('5 因子');
    expect(text).toContain('"E"');
    expect(text).not.toContain('A×B×C×D*');
  });
});

describe('自查:P 图保存摘要与页面/报告判异同口径(真 σ)', () => {
  it('p̄=0.5、nᵢ=4 双侧钳位 + K1=2:保存摘要不再误报', () => {
    // 6 批,每批 4 件:三批 2/4、两批 1/4、一批 4/4(p=1 距中心恰 2σ,不应按 K1=2 判超)
    useData.getState().importCounts('p', 'K1钳位样例', [2, 2, 2, 1, 1, 4], 4);
    useApp.setState({
      page: 'spc', spcType: 'p',
      spcRules: { ...DEFAULT_RULES, r1: true, r2: false, r3: false, r5: false },
      spcRuleK: { ...DEFAULT_RULE_K, k1: 2 },
    });
    useAnalyses.getState().saveCurrent();
    const saved = useAnalyses.getState().saved[0];
    // 页面/报告口径:p=1 偏差 0.5 = 2σ 不严格越界 → 0 失控;保存卡必须一致
    expect(saved.metric).not.toContain('失控');
  });
});

describe('自查:R3 前旧 gage 快照(角色 null)回放固化基线位置默认', () => {
  it('回放后角色为位置默认(cats[0]/cats[1]),不落入推荐路径', () => {
    const parsed = parseMatrix('螺钉高度\t操作员\t部件\n10.1\t甲\t1\n10.2\t甲\t1\n10.0\t乙\t2\n10.3\t乙\t2');
    if ('error' in parsed) throw new Error(parsed.error);
    useData.getState().importMatrix('旧Gage', parsed.colNames, parsed.rows, parsed.textCols);
    useApp.setState({ page: 'gagerr', gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null });
    useAnalyses.getState().saveCurrent();
    const saved = useAnalyses.getState().saved[0];
    // 模拟 R3 前旧快照:三角色为 null(新快照已固化生效名,这里手动退化)
    const legacy = { ...saved, snapshot: { ...saved.snapshot, gageValueName: null, gagePartName: null, gageOperatorName: null } };
    useAnalyses.setState({ saved: [legacy] });
    useApp.setState({ gageValueName: null, gagePartName: null, gageOperatorName: null });
    return useAnalyses.getState().restore(legacy.id).then(() => {
      const app = useApp.getState();
      // 基线位置默认:part=类别列0(操作员),operator=类别列1(部件)——即便推荐会反过来
      expect(app.gageValueName).toBe('螺钉高度');
      expect(app.gagePartName).toBe('操作员');
      expect(app.gageOperatorName).toBe('部件');
    });
  });
});
