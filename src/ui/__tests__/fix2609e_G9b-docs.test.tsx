/**
 * 2026-09 全面审查第 2b 批 · G9b-docs:第 2 批复审(CORE-01 口径变更)的文档与回看提示收口。
 *
 * 复审场景 1(README/帮助):CORE-01 把堆叠子组改为「ID 值一变即开新子组」,是有意的统计口径变更,
 * 但 v1.43.0 发布说明仍写「本批未改任何统计口径」,数据导入与帮助中心也没说明长表的新语义——
 * 工厂拿 v1.42 的旧报告比对会得到无解释的差异。
 * 复审场景 2(写读对称):分析记录列表显示保存时冻结的 metric/status,回看却按新口径重算;
 * v1.42 保存的「每天子组号从 1 重新编号」长表记录,列表写「过程受控」,点开后变成失控,且没有任何提示。
 * 这里用真实生产路径复现:先按 v1.42 的合并口径(4 个子组 × 10)得出当时会冻结的摘要,
 * 再把它套到同一份长表的快照上,回看后必须弹出一次说明保存时的值、现在的值和原因。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useAnalyses, type SavedAnalysis } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { DEFAULT_RULE_K } from '../../core';
import { HelpModal } from '../shell/HelpModal';

const readme = readFileSync('README.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

function releaseSection(): string {
  const heading = readme.split('\n').find((line) => line.startsWith('## ') && line.includes(`v${pkg.version}`) && line.includes('发布说明'));
  expect(heading, `README 缺少 v${pkg.version} 发布说明`).toBeDefined();
  const start = readme.indexOf(heading!);
  const next = readme.indexOf('\n## ', start + heading!.length);
  return readme.slice(start, next < 0 ? undefined : next);
}

function sectionOf(title: string): string {
  const start = readme.indexOf(`\n## ${title}`);
  expect(start, `README 缺少「${title}」一节`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf('\n## ', start + 4);
  return readme.slice(start, next < 0 ? undefined : next);
}

describe('README / 帮助中心:CORE-01 统计口径变更如实交代', () => {
  it('v1.43.0 发布说明单列「统计口径变更(CORE-01)」,写明数据形态、受影响结果、旧记录处理和迁移建议', () => {
    const section = releaseSection();
    // 修复前:整改要点末尾写「本批未改任何统计口径」,与 CORE-01 直接矛盾
    expect(section).not.toMatch(/本批未改任何统计口径/);
    const heading = section.split('\n').find((line) => line.startsWith('### ') && line.includes('统计口径变更') && line.includes('CORE-01'));
    expect(heading, '缺少「统计口径变更(CORE-01)」小节').toBeDefined();
    const start = section.indexOf(heading!);
    const next = section.indexOf('\n### ', start + heading!.length);
    const core01 = section.slice(start, next < 0 ? undefined : next);
    // 适用的数据形态
    expect(core01).toContain('值一变即开新子组');
    expect(core01).toMatch(/从 1 重新编号/);
    expect(core01).toMatch(/操作员|班次/);
    // 哪些结果会变
    for (const term of ['k', 'n', 'R̄', '控制限', '判异', '组内 σ', 'Cp', 'Cpk', 'PPM', 'I-MR']) expect(core01).toContain(term);
    // 旧报告与旧记录
    expect(core01).toContain('按新口径重算');
    expect(core01).toContain('保存时');
    expect(core01).toMatch(/docx|Word/);
    // 迁移建议
    expect(core01).toMatch(/按(采集)?时间排序|先排序/);
    expect(core01).toContain('日期-子组');
  });

  it('发布说明补齐本批其他用户可见规则(数值输入、CSV 引号、/xl/、Gage 组合上限、列虚拟化、IME、错误卡片)', () => {
    const section = releaseSection();
    expect(section).toContain('全角');
    expect(section).toContain('千分位');
    expect(section).toMatch(/十六进制/);
    expect(section).toMatch(/字段起始/);
    expect(section).toContain('/xl/');
    expect(section).toMatch(/10[,，]?000/);
    expect(section).toMatch(/40 列/);
    expect(section).toContain('120px');
    expect(section).toMatch(/组字|IME/);
    expect(section).toContain('应用界面渲染出错');
    expect(section).toContain('对话框渲染出错');
  });

  it('「数据导入」一节说明「测量值+子组 ID」长表的相邻分组语义', () => {
    const intro = sectionOf('数据导入');
    expect(intro).toContain('相邻');
    expect(intro).toMatch(/不相邻.*(不同子组|不会合并)/);
    expect(intro).toContain('Minitab');
  });

  it('帮助中心「数据操作」说明长表子组 ID 的相邻分组语义(渲染真实 HelpModal)', () => {
    render(<HelpModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '数据操作' }));
    const text = document.body.textContent ?? '';
    expect(text).toContain('相邻同值为一组');
    expect(text).toMatch(/不相邻.*不同子组/);
  });
});

/** 两天数据:每天子组号 1..4,每组 5 个测量,第二天整体 +3(CORE-01 发现记录场景 A)。 */
function twoDay() {
  const base = [
    [10.1, 10.3, 9.9, 10.2, 10.0],
    [10.2, 10.0, 10.1, 9.9, 10.3],
    [9.8, 10.1, 10.2, 10.0, 10.1],
    [10.0, 10.2, 9.9, 10.1, 10.2],
  ];
  const long: number[][] = [];
  const merged: number[][] = base.map(() => []);
  for (const shift of [0, 3]) {
    base.forEach((values, index) => values.forEach((value) => {
      const v = Number((value + shift).toFixed(2));
      long.push([index + 1, v]);
      merged[index].push(v);
    }));
  }
  return { long, merged };
}

const ALL_RULES = { r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false };

beforeEach(() => {
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    page: 'dashboard', spcType: 'xbar-r', spcRules: { ...ALL_RULES }, spcRuleK: { ...DEFAULT_RULE_K },
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    spcSigmaMethod: 'classic', spcShowZones: true,
    lsl: 5, usl: 18, tgt: 11.5, lslOn: true, uslOn: true,
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null, toast: null,
  });
});

/**
 * v1.42 形态的记录:快照是长表(子组号每天从 1 重新编号),列表摘要是 v1.42 按「同值合并」
 * 冻结的值。合并口径等价于把同号子组拼成 4 行 × 10 列的行式矩阵,用真实 saveCurrent 得出摘要。
 */
function legacyRecord(kind: 'spc' | 'capability', setupPage: () => void): { legacy: SavedAnalysis; fresh: SavedAnalysis } {
  const { long, merged } = twoDay();
  useData.getState().importMatrix('两天长表', ['子组', '测量值'], long);
  setupPage();
  const fresh = useAnalyses.getState().saveCurrent()!;
  expect(fresh).not.toBeNull();
  // 旧口径摘要:同一份数据按 v1.42 的合并方式(k=4、n=10)
  useData.getState().importMatrix('v1.42合并口径', Array.from({ length: 10 }, (_, j) => `测量${j + 1}`), merged);
  useApp.setState({ spcDataLayout: 'rows', spcValueCol: null, spcSubgroupCol: null, capSubgroupMode: 'spc' });
  useApp.setState({ page: kind });
  const old = useAnalyses.getState().saveCurrent()!;
  expect(old).not.toBeNull();
  const legacy: SavedAnalysis = {
    ...fresh,
    id: `v142-${kind}`,
    metric: old.metric, status: old.status, statusColor: old.statusColor, statusBg: old.statusBg,
  };
  return { legacy, fresh };
}

describe('回看:v1.42 记录的冻结摘要与新口径重算结果分裂时提示一次', () => {
  it('SPC:列表写「过程受控」,回看按新口径失控 → 提示保存时的值、现在的值与原因;列表摘要保持不变', async () => {
    const { legacy, fresh } = legacyRecord('spc', () => useApp.setState({ page: 'spc', spcDataLayout: 'auto' }));
    // 前提:两种口径确实给出不同摘要(否则本用例不成立)
    expect(legacy.metric).toBe('过程受控');
    expect(fresh.metric).toMatch(/失控点/);
    useAnalyses.setState({ saved: [legacy], lastError: null });
    useApp.setState({ toast: null, spcDataLayout: 'rows' });

    await expect(useAnalyses.getState().restore(legacy.id)).resolves.toBe(true);
    const toast = useApp.getState().toast ?? '';
    // 修复前:没有任何提示(toast 为 null),列表与回看结论无声分裂
    expect(toast).toContain('保存时');
    expect(toast).toContain('过程受控');
    expect(toast).toContain(fresh.metric);
    expect(toast).toContain('值一变即开新子组');
    expect(toast).toContain('「子组」');
    expect(useData.getState().model.name).toBe('两天长表');
    // 列表摘要是保存时的值,不被回看改写
    expect(useAnalyses.getState().saved[0]).toMatchObject({ metric: '过程受控', status: legacy.status });
  });

  it('能力:「单列+子组 ID」旧记录 Cpk 冻结值与重算值不同 → 同样提示', async () => {
    const { legacy, fresh } = legacyRecord('capability', () => useApp.setState({
      page: 'capability', capSubgroupMode: 'stacked', capValueCol: '测量值', capSubgroupIdCol: 'numeric:子组',
    }));
    expect(legacy.metric).toMatch(/^Cpk /);
    expect(legacy.metric).not.toBe(fresh.metric);
    useAnalyses.setState({ saved: [legacy], lastError: null });
    useApp.setState({ toast: null, capSubgroupMode: 'spc' });

    await expect(useAnalyses.getState().restore(legacy.id)).resolves.toBe(true);
    const toast = useApp.getState().toast ?? '';
    expect(toast).toContain(`保存时「${legacy.metric}`);
    expect(toast).toContain(fresh.metric);
    expect(toast).toContain('值一变即开新子组');
    expect(useApp.getState().page).toBe('capability');
  });

  it('摘要与重算一致(新版保存的记录)时不打扰', async () => {
    const { fresh } = legacyRecord('spc', () => useApp.setState({ page: 'spc', spcDataLayout: 'auto' }));
    useAnalyses.setState({ saved: [fresh], lastError: null });
    useApp.setState({ toast: null });
    await expect(useAnalyses.getState().restore(fresh.id)).resolves.toBe(true);
    expect(useApp.getState().toast ?? '').not.toContain('值一变即开新子组');
  });

  it('摘要不同但数据不受 CORE-01 影响(相邻块状 ID)时,不把差异误归因于口径变更', async () => {
    const rows = [[1, 10], [1, 11], [1, 10.5], [2, 20], [2, 21], [2, 20.5], [3, 10], [3, 11], [3, 10.4]];
    useData.getState().importMatrix('相邻块', ['批次', '直径'], rows);
    useApp.setState({ page: 'spc', spcDataLayout: 'auto' });
    const saved = useAnalyses.getState().saveCurrent()!;
    const tampered: SavedAnalysis = { ...saved, id: 'tampered', metric: saved.metric === '过程受控' ? '9 个失控点' : '过程受控' };
    useAnalyses.setState({ saved: [tampered], lastError: null });
    useApp.setState({ toast: null });
    await expect(useAnalyses.getState().restore(tampered.id)).resolves.toBe(true);
    expect(useApp.getState().toast ?? '').not.toContain('值一变即开新子组');
  });

  it('v1.29 形态(snapshotVersion<6)的长表记录:常数迁移提示与口径提示合并显示,互不覆盖', async () => {
    const { legacy } = legacyRecord('spc', () => useApp.setState({ page: 'spc', spcDataLayout: 'auto' }));
    const older: SavedAnalysis = { ...legacy, id: 'v5-long', snapshot: { ...legacy.snapshot, snapshotVersion: 5 } };
    useAnalyses.setState({ saved: [older], lastError: null });
    useApp.setState({ toast: null });
    await expect(useAnalyses.getState().restore(older.id)).resolves.toBe(true);
    const toast = useApp.getState().toast ?? '';
    expect(toast).toContain('d₂/d₃/c₄');
    expect(toast).toContain('值一变即开新子组');
  });
});
