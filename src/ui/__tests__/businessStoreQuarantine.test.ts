/** 鱼骨图与分析历史损坏时也必须保留原始文本，不能回落后静默覆盖。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('业务 store 损坏隔离', () => {
  it('损坏偏好回落默认值但原文进入隔离区，后续设置不会销毁证据', async () => {
    const corrupt = '{"state":{"chartStyle":"未写完"';
    localStorage.setItem('qp-prefs-v1', corrupt);
    const { useApp } = await import('../../store/appStore');

    expect(useApp.getState().chartStyle).toBe('经典');
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-prefs-v1'].raw).toBe(corrupt);
    useApp.getState().setProjectName('恢复后的项目');
    expect(JSON.parse(localStorage.getItem('qp-prefs-v1')!).state.projectName).toBe('恢复后的项目');
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-prefs-v1'].raw).toBe(corrupt);
  });

  it('损坏鱼骨回落演示但原文进入隔离区，后续保存不会销毁证据', async () => {
    const corrupt = JSON.stringify({ data: { problem: '缺分类', categories: [] }, isDemo: false });
    localStorage.setItem('qp-fishbone-v1', corrupt);
    const { loadFishboneState, saveFishboneState } = await import('../../store/fishboneStore');

    expect(loadFishboneState().isDemo).toBe(true);
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-fishbone-v1'].raw).toBe(corrupt);
    saveFishboneState({
      problem: '新问题',
      categories: ['人', '机', '料', '法', '环', '测'].map((name) => ({ name, causes: [] })),
    });
    expect(JSON.parse(localStorage.getItem('qp-fishbone-v1')!).data.problem).toBe('新问题');
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-fishbone-v1'].raw).toBe(corrupt);
  });

  it('损坏分析历史回落空列表但原文进入隔离区，随后保存空列表仍保留证据', async () => {
    const corrupt = JSON.stringify([{ id: 'broken' }]);
    localStorage.setItem('qp-analyses-v1', corrupt);
    const { useAnalyses } = await import('../../store/analyses');

    expect(useAnalyses.getState().saved).toEqual([]);
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-analyses-v1'].raw).toBe(corrupt);
    useAnalyses.getState().remove('不存在');
    expect(localStorage.getItem('qp-analyses-v1')).toBe('[]');
    expect(JSON.parse(localStorage.getItem('qp-quarantine-v1')!)['qp-analyses-v1'].raw).toBe(corrupt);
  });
});
