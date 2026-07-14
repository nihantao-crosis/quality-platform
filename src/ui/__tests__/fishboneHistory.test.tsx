/** 已挂载鱼骨页从侧栏恢复历史时必须同步重载画面。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { saveFishboneState, type FishboneData } from '../../store/fishboneStore';
import { Pareto } from '../pages/SimplePages';
import { chartTokens } from '../tokens';

const fishbone = (problem: string): FishboneData => ({
  problem,
  categories: [
    { name: '人', causes: [`${problem}-人`] }, { name: '机', causes: [] }, { name: '料', causes: [] },
    { name: '法', causes: [] }, { name: '环', causes: [] }, { name: '测', causes: [] },
  ],
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({ page: 'pareto', paretoView: 'fishbone', fishboneRevision: 0 });
});

describe('鱼骨图历史同页恢复', () => {
  it('已挂载当前鱼骨时恢复另一条历史，DOM 与导出存储同步切到历史内容', () => {
    saveFishboneState(fishbone('历史问题'), false);
    const saved = useAnalyses.getState().saveCurrent()!;
    saveFishboneState(fishbone('当前问题'), false);

    const view = render(createElement(Pareto, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('当前问题');
    expect(view.container.textContent).not.toContain('历史问题');

    act(() => useAnalyses.getState().restore(saved.id));
    expect(view.container.textContent).toContain('历史问题');
    expect(view.container.textContent).not.toContain('当前问题');
  });
});
