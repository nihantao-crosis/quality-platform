/**
 * 分析记录对象化 — 保存 / 摘要 / 回看(切数据集+还原参数) / 删除 / 持久化。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  expandSpcRuleItems, normalizeSavedAnalysesForStorage, reloadAnalyses, uniqueSpcPointCount, useAnalyses,
} from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { loadFishboneState, saveFishboneState, type FishboneData } from '../../store/fishboneStore';
import { freshSwitchStatus, recordInspection, type SwitchStatus } from '../../core/aqlSwitch';
import { platform } from '../../platform/adapter';

const R1_ONLY = { r1: true, r2: false, r3: false, r4: false, r5: false, r6: false, r7: false, r8: false };
const aqlStatus = (patch: Partial<SwitchStatus> = {}): SwitchStatus => ({ ...freshSwitchStatus(), ...patch });

beforeEach(() => {
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useData.getState().resetDemo();
  useData.setState({ recents: [] });
  useApp.setState({
    page: 'dashboard', spcType: 'xbar-r', spcRules: { ...R1_ONLY },
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    lsl: 24.9, usl: 25.1, tgt: 25.0, lslOn: true, uslOn: true,
    capabilityBins: 13, gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
    aqlLot: 120, aqlLevel: 'II', aqlAQL: 1.0, aqlMethod: 'gb', aqlAcMethod: 'gb',
    aqlSwitch: aqlStatus({ note: '初始为正常检验' }),
    doeTab: 'analyze', doeFactorCols: null, doeRespCol: null, doeModelTerms: null, doeIncludeCurvature: true,
    hypoTab: 'anova', anovaMode: 'stacked', anovaRespName: null, anovaFactorName: null, anovaShowDemo: false,
    t1ColName: null, t1Mu0: null, t2ColAName: null, t2ColBName: null, regXName: null, regYName: null,
    paretoView: 'pareto', paretoShowDemo: false, paretoMergeOther: false, paretoThreshold: 0.95,
  });
});

describe('保存分析', () => {
  it('DOE 创建页保存为“设计中”，不会固化旧分析结论', () => {
    useData.getState().importMatrix('DOE配置', ['A', 'B', 'Y'], [[-1, -1, 10], [1, -1, 20], [-1, 1, 12], [1, 1, 22]]);
    useApp.setState({ page: 'doe', doeTab: 'create', doeFactorCols: ['A', 'B'], doeRespCol: 'Y' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toMatchObject({ title: '实验设计 · 创建配置', metric: '尚未运行分析', status: '设计中' });
    expect(saved?.snapshot.doeTab).toBe('create');
  });

  it('鱼骨默认内容保存为演示；用户鱼骨绑定问题名并快照演示标记', () => {
    useApp.setState({ page: 'pareto', paretoView: 'fishbone' });
    const demo = useAnalyses.getState().saveCurrent();
    expect(demo).toMatchObject({ status: '演示', datasetName: '鱼骨图 · 尺寸超差' });
    expect(demo?.snapshot.fishboneIsDemo).toBe(true);

    const custom: FishboneData = {
      problem: '压装开裂',
      categories: [
        { name: '人', causes: ['培训'] }, { name: '机', causes: ['压力'] }, { name: '料', causes: ['硬度'] },
        { name: '法', causes: ['速度'] }, { name: '环', causes: [] }, { name: '测', causes: ['校准'] },
      ],
    };
    saveFishboneState(custom, false);
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toMatchObject({ status: '已分析', metric: '5 条潜在原因', datasetName: '鱼骨图 · 压装开裂' });
    expect(saved?.snapshot).toMatchObject({ fishboneData: custom, fishboneIsDemo: false });
  });

  it('非分析页返回 null,不产生记录', () => {
    useApp.setState({ page: 'worksheet' });
    expect(useAnalyses.getState().saveCurrent()).toBeNull();
    expect(useAnalyses.getState().saved.length).toBe(0);
  });

  it('SPC 页保存:标题/指标/失控状态,绑定数据集', () => {
    useApp.setState({ page: 'spc', spcType: 'xbar-r' });
    const a = useAnalyses.getState().saveCurrent();
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('spc');
    expect(a!.title).toBe('X̄-R 控制图');
    expect(a!.datasetName).toBe('质检数据.mtw');
    // 演示数据 X̄ 图有失控点 → 需关注
    expect(a!.metric).toMatch(/失控点|受控/);
    expect(useAnalyses.getState().saved.length).toBe(1);
  });

  it('普通 X̄-R 仅 R 图失控时，摘要仍报 1 个失控点', () => {
    const rows = Array.from({ length: 24 }, () => [9, 11]);
    rows.push([0, 20]); // 均值仍为 10，仅极差超限
    useData.getState().importMatrix('R-only.csv', ['x1', 'x2'], rows);
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcRules: { ...R1_ONLY }, spcStageCol: null });
    const a = useAnalyses.getState().saveCurrent()!;
    expect(a.metric).toBe('1 个失控点');
    expect(a.status).toBe('需关注');
  });

  it('同一子组在 X̄ 与 R 图同时失控，摘要按实际点去重', () => {
    const rows = Array.from({ length: 25 }, () => [9, 11]);
    rows.push([20, 40]); // 同一子组的均值和极差均超限
    useData.getState().importMatrix('XR-same-point.csv', ['x1', 'x2'], rows);
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcRules: { ...R1_ONLY }, spcStageCol: null });
    const a = useAnalyses.getState().saveCurrent()!;
    expect(a.metric).toBe('1 个失控点');
  });

  it('分阶段摘要使用与页面相同的段内控制限，并快照阶段列/准则', () => {
    const rows = [
      [9.9, 10.1], [10.0, 10.2], [9.8, 10.0], [10.1, 10.1],
      [19.9, 20.1], [20.0, 20.2], [19.8, 20.0], [20.1, 20.1],
    ];
    const labels = ['改进前', '改进前', '改进前', '改进前', '改进后', '改进后', '改进后', '改进后'];
    useData.getState().importMatrix('分阶段.csv', ['x1', 'x2'], rows, [{ name: '阶段', values: labels }]);
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcRules: { ...R1_ONLY }, spcStageCol: null });
    const global = useAnalyses.getState().saveCurrent()!;
    expect(global.metric).toMatch(/失控点/); // 整体限值会把前后均值跳变视为失控

    useApp.setState({ spcStageCol: '阶段' });
    const staged = useAnalyses.getState().saveCurrent()!;
    expect(staged.title).toBe('X̄-R 控制图 · 分阶段');
    expect(staged.metric).toBe('2 阶段 · 过程受控');
    expect(staged.snapshot.spcStageCol).toBe('阶段');
    expect(staged.snapshot.spcRules).toEqual(R1_ONLY);

    useApp.setState({ spcStageCol: null, spcRules: { ...R1_ONLY, r2: true } });
    useAnalyses.getState().restore(staged.id);
    expect(useApp.getState().spcStageCol).toBe('阶段');
    expect(useApp.getState().spcRules).toEqual(R1_ONLY);
  });

  it('非法单点阶段保存为未分析，不回退全局控制限伪报受控', () => {
    useData.getState().importMatrix(
      '非法阶段.csv', ['x1', 'x2'], [[10, 11], [10, 11], [100, 101], [10, 11], [10, 11]],
      [{ name: '阶段', values: ['基线', '基线', '异常点', '改善后', '改善后'] }],
    );
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcDataLayout: 'rows', spcStageCol: '阶段' });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved).toMatchObject({ title: 'X̄-R 控制图 · 分阶段未运行', status: '未分析' });
    expect(saved.metric).toContain('只有 1 个点');
  });

  it('人工反馈行式数据保存时记录正确角色：数值子组列不计入 n', () => {
    useData.getState().importMatrix('黄广洋样例.csv', ['子组', '直径1', '直径2', '直径3', '直径4', '直径5'], [
      [1, 4.5, 10.1, 13.5, 11.0, 11.1],
      [2, 8.1, 10.7, 5.8, 3.1, 8.7],
      [3, 11.1, 4.7, 11.6, 3.8, 10.4],
    ]);
    useApp.setState({ page: 'spc', spcType: 'xbar-r', spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.status).not.toBe('未分析');
    expect(saved.snapshot.spcDataLayout).toBe('auto');
    expect(saved.snapshot.spcResolvedLayout).toContain('行式子组');
    expect(saved.snapshot.spcResolvedVariableName).toBe('直径');
    expect(saved.snapshot.spcResolvedRoleNote).toContain('3 个子组 × 5 次组内测量');
    expect(saved.snapshot.spcResolvedRoleNote).toContain('未参与测量计算');
  });

  it('保存并回看显式堆叠角色，不继承当前页面的其他列选择', () => {
    useData.getState().importMatrix('堆叠.csv', ['子组', '直径', '温度'], [
      [1, 10, 20], [1, 11, 21], [2, 12, 22], [2, 13, 23],
    ]);
    useApp.setState({
      page: 'spc', spcType: 'xbar-r', spcDataLayout: 'stacked',
      spcValueCol: '直径', spcSubgroupCol: 'numeric:子组',
    });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.snapshot.spcValueCol).toBe('直径');
    expect(saved.snapshot.spcSubgroupCol).toBe('numeric:子组');
    expect(saved.snapshot.spcResolvedRoleNote).toContain('2 个子组 × 2 次测量');

    useApp.setState({ spcDataLayout: 'individuals', spcValueCol: '温度', spcSubgroupCol: null });
    useAnalyses.getState().restore(saved.id);
    expect(useApp.getState().spcDataLayout).toBe('stacked');
    expect(useApp.getState().spcValueCol).toBe('直径');
    expect(useApp.getState().spcSubgroupCol).toBe('numeric:子组');
  });

  it('窗口型准则列表展开为图上实际标红点', () => {
    const viol = new Set(Array.from({ length: 9 }, (_, i) => i));
    const items = expandSpcRuleItems(viol, [{ i: 8, rule: 2, desc: '连续 9 点同侧' }], 'X̄');
    expect(items.map((item) => item.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(uniqueSpcPointCount(items)).toBe(9);
  });

  it('回看旧版 SPC 记录不继承当前规则或分阶段列', () => {
    useAnalyses.setState({
      saved: [{
        id: 'legacy-spc', kind: 'spc', title: '旧 SPC', datasetName: '质检数据.mtw',
        metric: '过程受控', status: '受控', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { spcType: 'xbar-r' },
      }],
    });
    useApp.setState({
      spcStageCol: '当前阶段',
      spcDataLayout: 'stacked', spcValueCol: '当前值', spcSubgroupCol: 'text:当前组',
      spcRules: { r1: false, r2: false, r3: false, r4: true, r5: false, r6: true, r7: true, r8: true },
    });
    useAnalyses.getState().restore('legacy-spc');
    expect(useApp.getState().spcStageCol).toBeNull();
    expect(useApp.getState().spcDataLayout).toBe('auto');
    expect(useApp.getState().spcValueCol).toBeNull();
    expect(useApp.getState().spcSubgroupCol).toBeNull();
    expect(useApp.getState().spcRules).toEqual({
      r1: true, r2: true, r3: true, r4: false, r5: true, r6: false, r7: false, r8: false,
    });
  });

  it('过程能力页保存:Cpk 指标与能力判定(P0-4:演示集有失控点,不得给绿色「能力充足」)', () => {
    useApp.setState({ page: 'capability' });
    const a = useAnalyses.getState().saveCurrent()!;
    expect(a.title).toBe('过程能力分析');
    expect(a.metric).toMatch(/^Cpk /);
    // 演示数据集控制图有已知失控点(子组16–18、22),保存记录必须与能力页同口径。
    expect(a.status).toContain('过程不稳定');
    expect(a.statusColor).not.toBe('#2c8a45'); // 不得绿色
  });

  it('持久化到 localStorage', () => {
    useApp.setState({ page: 'aql' });
    useAnalyses.getState().saveCurrent();
    const raw = JSON.parse(localStorage.getItem('qp-analyses-v1')!);
    expect(raw.length).toBe(1);
    expect(raw[0].snapshot.aqlLot).toBeDefined();
  });

  it('同一变量数据仅保存一份去重载荷，删除最后一条引用后清理', () => {
    useData.getState().importMatrix('去重.csv', ['x1', 'x2'], [[1, 2], [3, 4]]);
    useApp.setState({ page: 'spc', spcType: 'xbar-r' });
    const first = useAnalyses.getState().saveCurrent()!;
    const second = useAnalyses.getState().saveCurrent()!;

    expect(first.snapshot.sourceData).toBeUndefined();
    expect(first.snapshot.sourceDataKey).toBeTruthy();
    expect(second.snapshot.sourceDataKey).toBe(first.snapshot.sourceDataKey);
    expect(Object.keys(JSON.parse(localStorage.getItem('qp-analysis-data-v1')!))).toHaveLength(1);

    useAnalyses.getState().remove(first.id);
    expect(Object.keys(JSON.parse(localStorage.getItem('qp-analysis-data-v1')!))).toHaveLength(1);
    useAnalyses.getState().remove(second.id);
    expect(localStorage.getItem('qp-analysis-data-v1')).toBeNull();
  });

  it('分析索引写入失败时不谎报保存成功，并清理孤儿数据载荷', () => {
    useData.getState().importMatrix('超限.csv', ['x'], [[1], [2], [3]]);
    useApp.setState({ page: 'capability' });
    const originalSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'qp-analyses-v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    });

    try {
      expect(useAnalyses.getState().saveCurrent()).toBeNull();
      expect(useAnalyses.getState().saved).toHaveLength(0);
      expect(useAnalyses.getState().lastError).toContain('分析未保存');
      expect(localStorage.getItem('qp-analysis-data-v1')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('AQL 只保存当时摘要而不复制责任账本，回看不改写当前活跃检验流', () => {
    useApp.setState({
      page: 'aql', aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0,
      aqlSwitch: aqlStatus({
        state: 'tightened', history: ['R', 'A', 'R'], sinceSwitch: [],
        note: '连续 5 批中 2 批拒收 → 转加严检验',
      }),
    });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.title).toContain('加严');
    expect(saved.metric).toBe('保存时 n=125 Ac=2 Re=3');
    expect(saved.snapshot.aqlSwitch).toBeUndefined();

    const active = aqlStatus({ note: '当前活跃检验流' });
    useApp.setState({ aqlSwitch: active });
    useAnalyses.getState().restore(saved.id);
    expect(useApp.getState().aqlSwitch).toEqual(active);
  });

  it('升级时清理旧 AQL 摘要中从未被消费的重复责任账本', () => {
    useApp.setState({ page: 'aql' });
    const saved = useAnalyses.getState().saveCurrent()!;
    const legacy = {
      ...saved,
      snapshot: { ...saved.snapshot, aqlSwitch: aqlStatus({ history: ['A'], records: [] }) },
    };
    const normalized = normalizeSavedAnalysesForStorage([legacy]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].snapshot.aqlSwitch).toBeUndefined();
    expect(normalized[0]).toMatchObject({ id: saved.id, title: saved.title, metric: saved.metric });
  });

  it('旧 AQL 摘要清理写回失败时，仍加载已读取并规范化的历史', () => {
    useApp.setState({ page: 'aql' });
    const saved = useAnalyses.getState().saveCurrent()!;
    const legacy = {
      ...saved,
      snapshot: { ...saved.snapshot, aqlSwitch: aqlStatus({ history: ['A'], records: [] }) },
    };
    localStorage.setItem('qp-analyses-v1', JSON.stringify([legacy]));
    useAnalyses.setState({ saved: [], lastError: null });

    const originalSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'qp-analyses-v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    });
    try {
      reloadAnalyses();
      expect(useAnalyses.getState().saved).toHaveLength(1);
      expect(useAnalyses.getState().saved[0]).toMatchObject({ id: saved.id, title: saved.title });
      expect(useAnalyses.getState().saved[0].snapshot.aqlSwitch).toBeUndefined();
      expect(JSON.parse(localStorage.getItem('qp-analyses-v1')!)[0].snapshot.aqlSwitch).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('AQL B1 保存后新增 B2，回看 B1 保持完整当前状态并让 B3 连续判定', () => {
    const first = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 0,
      batchId: 'B1', inspector: '张检', inspectedAt: '2026-07-14T08:00:00.000Z',
    });
    useApp.setState({ page: 'aql', aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0, aqlSwitch: first });
    const saved = useAnalyses.getState().saveCurrent()!;

    const withLaterRecord = recordInspection(first, {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 4,
      batchId: 'B2', inspector: '李检', inspectedAt: '2026-07-14T09:00:00.000Z',
    });
    useApp.setState({ aqlSwitch: withLaterRecord });
    useAnalyses.getState().restore(saved.id);

    const restored = useApp.getState().aqlSwitch;
    expect(restored).toEqual(withLaterRecord);

    const b3Input = {
      lot: 2000, level: 'II' as const, aql: 1.0, nonconforming: 4,
      batchId: 'B3', inspector: '王检', inspectedAt: '2026-07-14T10:00:00.000Z',
    };
    const afterB3 = recordInspection(restored, b3Input);
    const expected = recordInspection(withLaterRecord, b3Input);
    expect(afterB3).toEqual(expected);
    expect(afterB3.records.map((record) => record.batchId)).toEqual(['B1', 'B2', 'B3']);
    expect(afterB3.state).toBe('tightened');
  });

  it('AQL 回看不切换当前工作表，因为抽样方案不依赖连续数据集', () => {
    useData.getState().importMatrix('保存时工作表.csv', ['x'], [[1], [2], [3]]);
    useApp.setState({ page: 'aql' });
    const saved = useAnalyses.getState().saveCurrent()!;
    useData.getState().importMatrix('当前工作表.csv', ['y'], [[10], [20], [30]]);

    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe('当前工作表.csv');
    expect(useApp.getState().page).toBe('aql');
  });

  it('AQL 历史参数与当前检验流不同，回看也不把历史方案写回活跃配置', () => {
    const first = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 0,
      batchId: '旧方案-B1', inspector: '张检', inspectedAt: '2026-07-14T08:00:00.000Z',
    });
    useApp.setState({ page: 'aql', aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0, aqlSwitch: first });
    const saved = useAnalyses.getState().saveCurrent()!;

    useApp.getState().setAql({ aqlLot: 500, aqlLevel: 'I', aqlAQL: 0.65 });
    const currentBeforeRecord = useApp.getState().aqlSwitch;
    const currentSwitch = recordInspection(currentBeforeRecord, {
      lot: 500, level: 'I', aql: 0.65, nonconforming: 0,
      batchId: '当前方案-B2', inspector: '李检', inspectedAt: '2026-07-14T09:00:00.000Z',
    });
    useApp.setState({ aqlSwitch: currentSwitch });

    useAnalyses.getState().restore(saved.id);
    expect(useApp.getState()).toMatchObject({ aqlLot: 500, aqlLevel: 'I', aqlAQL: 0.65 });
    expect(useApp.getState().aqlSwitch).toEqual(currentSwitch);
  });

  it('AQL 正常态参数变化建立新序列并保留责任追溯，全检摘要明确是保存时状态', () => {
    const tracked = recordInspection(freshSwitchStatus(), {
      lot: 2000, level: 'II', aql: 1.0, nonconforming: 0,
      batchId: 'TRACE-001', inspector: '张检', inspectedAt: '2026-07-14T08:00:00.000Z',
    });
    useApp.setState({
      page: 'aql', aqlLot: 2000,
      aqlSwitch: tracked,
    });
    useApp.getState().setAql({ aqlLot: 8, aqlAQL: 0.65 });
    expect(useApp.getState().aqlSwitch.state).toBe('normal');
    expect(useApp.getState().aqlSwitch.history).toEqual([]);
    expect(useApp.getState().aqlSwitch.records).toHaveLength(1);
    expect(useApp.getState().aqlSwitch.records[0].batchId).toBe('TRACE-001');
    expect(useApp.getState().aqlSwitch.records[0].sequenceId).not.toBe(useApp.getState().aqlSwitch.sequenceId);

    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.title).toBe('AQL 历史摘要 · 100% 全检');
    expect(saved.metric).toBe('保存时 N=8 Ac=0 Re=1');
    expect(saved.status).toBe('保存时：全检');
    expect(saved.snapshot.aqlSwitch).toBeUndefined();
  });

  it('回看旧版无转移快照的 AQL 记录也不改写当前活跃检验流', () => {
    useAnalyses.setState({
      saved: [{
        id: 'legacy-aql', kind: 'aql', title: '旧 AQL', datasetName: '质检数据.mtw',
        metric: 'n=13 Ac=0', status: '正常', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { aqlLot: 120, aqlLevel: 'II', aqlAQL: 1.0, aqlMethod: 'gb', aqlAcMethod: 'gb' },
      }],
    });
    useApp.setState({ aqlSwitch: aqlStatus({ state: 'reduced', history: ['A'], sinceSwitch: ['A'], note: '放宽' }) });
    const active = useApp.getState().aqlSwitch;
    useAnalyses.getState().restore('legacy-aql');
    expect(useApp.getState().aqlSwitch).toEqual(active);
  });
});

describe('回看分析', () => {
  it('鱼骨历史恢复问题、6M 原因与演示标记，不改写无关帕累托数据', () => {
    const original: FishboneData = {
      problem: '历史问题',
      categories: [
        { name: '人', causes: ['A'] }, { name: '机', causes: ['B'] }, { name: '料', causes: [] },
        { name: '法', causes: [] }, { name: '环', causes: [] }, { name: '测', causes: [] },
      ],
    };
    useData.getState().importPareto('当前帕累托', [{ name: '缺陷', count: 3 }]);
    saveFishboneState(original, false);
    useApp.setState({ page: 'pareto', paretoView: 'fishbone' });
    const saved = useAnalyses.getState().saveCurrent()!;

    const later: FishboneData = { ...original, problem: '后来问题' };
    saveFishboneState(later, false);
    useAnalyses.getState().restore(saved.id);
    expect(loadFishboneState()).toEqual({ data: original, isDemo: false });
    expect(useData.getState().paretoModel?.name).toBe('当前帕累托');
    expect(useApp.getState()).toMatchObject({ page: 'pareto', paretoView: 'fishbone' });
  });

  it('旧鱼骨快照缺少问题/原因时明确阻断，不把当前鱼骨冒充历史', () => {
    const current: FishboneData = {
      problem: '当前问题',
      categories: Array.from({ length: 6 }, (_, index) => ({ name: `M${index + 1}`, causes: [`原因${index + 1}`] })),
    };
    saveFishboneState(current, false);
    useAnalyses.setState({
      saved: [{
        id: 'legacy-fishbone', kind: 'pareto', title: '旧鱼骨', datasetName: '旧问题',
        metric: '6M 分析', status: '已分析', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { snapshotVersion: 5, paretoView: 'fishbone' },
      }],
      lastError: null,
    });
    useApp.setState({ page: 'dashboard', toast: null });
    useAnalyses.getState().restore('legacy-fishbone');
    expect(loadFishboneState()).toEqual({ data: current, isDemo: false });
    expect(useApp.getState().page).toBe('dashboard');
    expect(useApp.getState().toast).toContain('旧版鱼骨图记录未保存');
  });

  it('假设检验列/目标与 DOE 子页都随分析快照精确恢复', () => {
    useData.getState().importMatrix('检验快照', ['A', 'B', 'C'], [[1, 2, 3], [2, 4, 6], [3, 6, 9]]);
    useApp.setState({
      page: 'anova', hypoTab: 'reg', t1ColName: 'B', t1Mu0: 2.5,
      t2ColAName: 'C', t2ColBName: 'A', regXName: 'A', regYName: 'C',
    });
    const saved = useAnalyses.getState().saveCurrent()!;
    useApp.setState({ hypoTab: 'anova', t1ColName: null, t1Mu0: null, t2ColAName: null, t2ColBName: null, regXName: null, regYName: null });
    useAnalyses.getState().restore(saved.id);
    expect(useApp.getState()).toMatchObject({
      page: 'anova', hypoTab: 'reg', t1ColName: 'B', t1Mu0: 2.5,
      t2ColAName: 'C', t2ColBName: 'A', regXName: 'A', regYName: 'C',
    });
  });

  it('还原页面 + 参数 + 切回数据集', () => {
    // 在数据集 A 上保存一个能力分析(单侧规格)
    useData.getState().importMatrix('批次A.csv', ['x'], [[1], [2], [3], [4]]);
    useApp.setState({ page: 'capability', lslOn: false, uslOn: true, usl: 5 });
    const a = useAnalyses.getState().saveCurrent()!;
    // 切到别的数据集 + 改参数 + 换页
    useData.getState().resetDemo();
    useApp.setState({ page: 'spc', lslOn: true, uslOn: true });
    // 回看
    useAnalyses.getState().restore(a.id);
    expect(useApp.getState().page).toBe('capability');
    expect(useApp.getState().lslOn).toBe(false);
    expect(useApp.getState().usl).toBe(5);
    expect(useData.getState().model.name).toBe('批次A.csv'); // 切回原数据集
  });

  it('变量分析回看使用保存时的完整快照，不受当前数据或最近列表上限影响', () => {
    useData.getState().importMatrix(
      '原始批次A.csv',
      ['子组', '直径1', '直径2'],
      [[1, 10.1, 10.2], [2, 10.3, 10.4]],
      [{ name: '阶段', values: ['改善前', '改善后'] }],
      [{ row: 1, col: 2 }],
    );
    useApp.setState({ page: 'spc', spcType: 'xbar-r' });
    const saved = useAnalyses.getState().saveCurrent()!;

    for (let i = 0; i < 7; i++) {
      useData.getState().importMatrix(`后来批次${i}.csv`, ['y'], [[100 + i], [200 + i]]);
    }
    expect(useData.getState().recents.some((recent) => recent.name === '原始批次A.csv')).toBe(false);

    useAnalyses.getState().restore(saved.id);
    const restored = useData.getState();
    expect(restored.model.name).toBe('原始批次A.csv');
    expect(restored.model.colNames).toEqual(['子组', '直径1', '直径2']);
    expect(restored.model.subs.map((subgroup) => subgroup.vals)).toEqual([
      [1, 10.1, 10.2], [2, 10.3, 10.4],
    ]);
    expect(restored.textCols).toEqual([{ name: '阶段', values: ['改善前', '改善后'] }]);
    expect(restored.pendingCells).toEqual([{ row: 1, col: 2 }]);
  });

  it('P/C 控制图分别恢复保存时的计数与样本量', () => {
    useData.getState().importCounts('p', 'P-原始.csv', [1, 4, 2, 5], 80);
    useApp.setState({ page: 'spc', spcType: 'p' });
    const pSaved = useAnalyses.getState().saveCurrent()!;
    useData.getState().importCounts('p', 'P-后来.csv', [9, 9, 9], 20);
    useAnalyses.getState().restore(pSaved.id);
    expect(useData.getState().pModel.name).toBe('P-原始.csv');
    expect(useData.getState().pModel.pdef).toEqual([1, 4, 2, 5]);
    expect(useData.getState().pModel.pN).toBe(80);

    useData.getState().importCounts('c', 'C-原始.csv', [2, 0, 3, 1]);
    useApp.setState({ page: 'spc', spcType: 'c' });
    const cSaved = useAnalyses.getState().saveCurrent()!;
    useData.getState().importCounts('c', 'C-后来.csv', [8, 8, 8]);
    useAnalyses.getState().restore(cSaved.id);
    expect(useData.getState().cModel.name).toBe('C-原始.csv');
    expect(useData.getState().cModel.cdata).toEqual([2, 0, 3, 1]);
  });

  it('P 图分析快照保存并恢复每批样本量，旧固定 n 快照仍兼容', () => {
    useData.getState().importCounts('p', 'P-变样本量.csv', [1, 4, 2, 5], [40, 80, 50, 100]);
    useApp.setState({ page: 'spc', spcType: 'p' });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.snapshot.pChartData).toMatchObject({
      sampleSize: 40,
      sampleSizes: [40, 80, 50, 100],
    });

    useData.getState().importCounts('p', 'P-后来.csv', [0, 0, 0], 10);
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().pModel.pNs).toEqual([40, 80, 50, 100]);
    expect(useData.getState().pModel.pVariableN).toBe(true);

    // 模拟 v5 及更早只保存 sampleSize 的记录。
    const legacy = {
      ...saved,
      id: 'legacy-p-fixed-n',
      snapshot: {
        ...saved.snapshot,
        pChartData: { name: 'P-旧快照.csv', counts: [1, 2, 3], sampleSize: 30 },
      },
    };
    useAnalyses.setState((state) => ({ saved: [legacy, ...state.saved] }));
    useAnalyses.getState().restore(legacy.id);
    expect(useData.getState().pModel.pNs).toEqual([30, 30, 30]);
    expect(useData.getState().pModel.pVariableN).toBe(false);
  });

  it('ANOVA 超出最近 5 份数据后仍按保存时工作表精确恢复', () => {
    const rows = [[1, 10], [1, 11], [2, 20], [2, 21]];
    useData.getState().importMatrix('ANOVA-A.csv', ['因子', '响应'], rows);
    useApp.setState({
      page: 'anova', hypoTab: 'anova', anovaMode: 'numfactor',
      anovaRespName: '响应', anovaFactorName: '因子',
    });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.snapshot.snapshotVersion).toBe(5);
    expect(saved.snapshot.sourceDataKey).toBeTruthy();

    for (let i = 0; i < 7; i++) {
      useData.getState().importMatrix(`ANOVA-后来${i}.csv`, ['x'], [[i], [i + 1]]);
    }
    expect(useData.getState().recents.some((recent) => recent.name === 'ANOVA-A.csv')).toBe(false);
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe('ANOVA-A.csv');
    expect(useData.getState().model.colNames).toEqual(['因子', '响应']);
    expect(useData.getState().model.subs.map((subgroup) => subgroup.vals)).toEqual(rows);
    expect(useApp.getState()).toMatchObject({
      page: 'anova', anovaMode: 'numfactor', anovaRespName: '响应', anovaFactorName: '因子',
    });
  });

  it('DOE 超出最近 5 份数据后恢复原设计、响应与待录入元数据', () => {
    const rows = [
      [-1, -1, 10], [1, -1, 30], [-1, 1, 12], [1, 1, 33],
      [-1, -1, 11], [1, -1, 29], [-1, 1, 13], [1, 1, 31],
    ];
    useData.getState().importMatrix('DOE-A.csv', ['因子A', '因子B', '响应'], rows, [], [{ row: 7, col: 2 }]);
    useApp.setState({ page: 'doe', doeFactorCols: ['因子A', '因子B'], doeRespCol: '响应' });
    const saved = useAnalyses.getState().saveCurrent()!;

    for (let i = 0; i < 7; i++) {
      useData.getState().importMatrix(`DOE-后来${i}.csv`, ['x'], [[i], [i + 1]]);
    }
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe('DOE-A.csv');
    expect(useData.getState().model.subs.map((subgroup) => subgroup.vals)).toEqual(rows);
    expect(useData.getState().pendingCells).toEqual([{ row: 7, col: 2 }]);
    expect(useApp.getState()).toMatchObject({
      page: 'doe', doeFactorCols: ['因子A', '因子B'], doeRespCol: '响应',
    });
  });

  it('摘要历史保留演示标记与专用 I-MR 序列', () => {
    const original = useData.getState().model;
    const originalIndiv = [...original.indiv];
    expect(original.isDemo).toBe(true);
    useApp.setState({ page: 'summary' });
    const saved = useAnalyses.getState().saveCurrent()!;

    useData.getState().importMatrix('普通数据.csv', ['x'], [[1], [2], [3]]);
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().model.name).toBe(original.name);
    expect(useData.getState().model.isDemo).toBe(true);
    expect(useData.getState().model.indiv).toEqual(originalIndiv);
    const persisted = JSON.parse(localStorage.getItem('qp-dataset-v1')!);
    expect(persisted.isDemo).toBe(true);
    expect(persisted.indivSeries).toEqual(originalIndiv);

    useData.getState().importMatrix('再次切换.csv', ['x'], [[4], [5], [6]]);
    useData.getState().loadRecent(original.name);
    expect(useData.getState().model.isDemo).toBe(true);
    expect(useData.getState().model.indiv).toEqual(originalIndiv);
  });

  it('描述性统计所选列仍有待录入格时拒绝保存，不把内部 0 占位固化为统计结论', () => {
    useData.getState().importMatrix(
      '待录入摘要.csv', ['完整列', '待录入列'], [[1, 10], [2, 0], [3, 30]], [], [{ row: 1, col: 1 }],
    );
    useApp.setState({ page: 'summary', activeVar: '待录入列' });
    const before = useAnalyses.getState().saved.length;

    expect(useAnalyses.getState().saveCurrent()).toBeNull();
    expect(useAnalyses.getState().saved).toHaveLength(before);
    expect(useAnalyses.getState().lastError).toContain('仍有 1 个待录入单元格');
    expect(useAnalyses.getState().lastError).toContain('分析未保存');

    useApp.setState({ activeVar: '完整列' });
    expect(useAnalyses.getState().saveCurrent()).toMatchObject({
      title: '描述性统计 · 完整列', metric: 'x̄ 2.000 · s 1.000',
    });
  });

  it('真实工作表只有一个数值列时拒绝保存双样本 t，不混入演示组', () => {
    useData.getState().importMatrix('单列实测.csv', ['强度'], [[10], [11], [12], [13]]);
    useApp.setState({ page: 'anova', hypoTab: 't2', t2ColAName: '强度', t2ColBName: null });
    const before = useAnalyses.getState().saved.length;

    expect(useAnalyses.getState().saveCurrent()).toBeNull();
    expect(useAnalyses.getState().saved).toHaveLength(before);
    expect(useAnalyses.getState().lastError).toContain('需要两个不同的数值列');
    expect(useAnalyses.getState().lastError).toContain('分析未保存');
  });

  it('旧版 ANOVA/DOE/摘要缺少数据快照时明确阻断，不套用当前工作表', () => {
    for (const kind of ['anova', 'doe', 'summary'] as const) {
      useAnalyses.setState({
        saved: [{
          id: `legacy-${kind}`, kind, title: `旧 ${kind}`, datasetName: '旧数据.csv',
          metric: '已分析', status: '已分析', statusColor: '#000', statusBg: '#fff', createdAt: 1,
          snapshot: {},
        }],
        lastError: null,
      });
      useApp.setState({ page: 'dashboard', toast: null });
      const currentName = useData.getState().model.name;
      useAnalyses.getState().restore(`legacy-${kind}`);
      expect(useData.getState().model.name).toBe(currentName);
      expect(useApp.getState().page).toBe('dashboard');
      expect(useApp.getState().toast).toContain('数据快照缺失');
    }
  });

  it('旧版变量分析找不到原数据时阻止回看，不把当前数据冒充历史数据', () => {
    useAnalyses.setState({
      saved: [{
        id: 'legacy-missing', kind: 'capability', title: '旧能力分析', datasetName: '已删除批次.csv',
        metric: 'Cpk 1.20', status: '能力临界', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { lsl: 1, usl: 3, lslOn: true, uslOn: true },
      }],
      lastError: null,
    });
    const currentName = useData.getState().model.name;
    useAnalyses.getState().restore('legacy-missing');
    expect(useData.getState().model.name).toBe(currentName);
    expect(useApp.getState().page).toBe('dashboard');
    expect(useApp.getState().toast).toContain('对应数据集已不可用');
  });

  it('旧版轻量最近项异步读取失败时不回放参数、不跳页', async () => {
    useData.getState().importMatrix('当前批次.csv', ['x'], [[1], [2], [3]]);
    useData.setState({ recents: [{ name: '旧批次.csv', savedAt: '2026-07-01T00:00:00Z' }] });
    useAnalyses.setState({
      saved: [{
        id: 'legacy-light-failed', kind: 'capability', title: '旧能力分析', datasetName: '旧批次.csv',
        metric: 'Cpk 1.20', status: '能力临界', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { lsl: 99, usl: 101, lslOn: true, uslOn: true },
      }],
      lastError: null,
    });
    useApp.setState({ page: 'dashboard', lsl: 0, usl: 10, toast: null });
    const previousDb = platform.datasetDb;
    platform.datasetDb = {
      put: async () => {}, get: async () => null, list: async () => [], remove: async () => false,
      stats: async () => ({ count: 0, total_bytes: 0, path: ':memory:' }),
    };
    try {
      expect(await useAnalyses.getState().restore('legacy-light-failed')).toBe(false);
    } finally {
      platform.datasetDb = previousDb;
    }

    expect(useData.getState().model.name).toBe('当前批次.csv');
    expect(useApp.getState()).toMatchObject({ page: 'dashboard', lsl: 0, usl: 10 });
    expect(useApp.getState().toast).toContain('读取失败');
  });

  it('删除记录', () => {
    useApp.setState({ page: 'doe' });
    const a = useAnalyses.getState().saveCurrent()!;
    expect(useAnalyses.getState().saved.length).toBe(1);
    useAnalyses.getState().remove(a.id);
    expect(useAnalyses.getState().saved.length).toBe(0);
    expect(JSON.parse(localStorage.getItem('qp-analyses-v1')!).length).toBe(0);
  });
});
