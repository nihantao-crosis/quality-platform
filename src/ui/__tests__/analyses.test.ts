/**
 * 分析记录对象化 — 保存 / 摘要 / 回看(切数据集+还原参数) / 删除 / 持久化。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';

beforeEach(() => {
  localStorage.clear();
  useAnalyses.setState({ saved: [] });
  useData.getState().resetDemo();
  useApp.setState({ page: 'dashboard', spcType: 'xbar-r', lsl: 24.9, usl: 25.1, tgt: 25.0, lslOn: true, uslOn: true });
});

describe('保存分析', () => {
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

  it('过程能力页保存:Cpk 指标与能力判定', () => {
    useApp.setState({ page: 'capability' });
    const a = useAnalyses.getState().saveCurrent()!;
    expect(a.title).toBe('过程能力分析');
    expect(a.metric).toMatch(/^Cpk /);
    expect(['能力充足', '能力临界', '能力不足']).toContain(a.status);
  });

  it('持久化到 localStorage', () => {
    useApp.setState({ page: 'aql' });
    useAnalyses.getState().saveCurrent();
    const raw = JSON.parse(localStorage.getItem('qp-analyses-v1')!);
    expect(raw.length).toBe(1);
    expect(raw[0].snapshot.aqlLot).toBeDefined();
  });
});

describe('回看分析', () => {
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

  it('删除记录', () => {
    useApp.setState({ page: 'doe' });
    const a = useAnalyses.getState().saveCurrent()!;
    expect(useAnalyses.getState().saved.length).toBe(1);
    useAnalyses.getState().remove(a.id);
    expect(useAnalyses.getState().saved.length).toBe(0);
    expect(JSON.parse(localStorage.getItem('qp-analyses-v1')!).length).toBe(0);
  });
});
