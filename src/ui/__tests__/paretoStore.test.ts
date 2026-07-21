/**
 * 帕累托数据通道:store 持久化、分析摘要真实指标、.qproj 键。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';
import { PROJECT_KEYS, buildProjectJson, applyProjectJson } from '../../platform/project';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
});

describe('paretoModel', () => {
  it('importPareto 写入 state 与 localStorage', () => {
    useData.getState().importPareto('六月缺陷', [{ name: '划伤', count: 32 }, { name: '毛刺', count: 21 }]);
    expect(useData.getState().paretoModel?.name).toBe('六月缺陷');
    expect(JSON.parse(localStorage.getItem('qp-pareto-v1')!).rows).toHaveLength(2);
  });

  it('resetDemo 清空帕累托数据', () => {
    useData.getState().importPareto('x', [{ name: 'a', count: 1 }]);
    useData.getState().resetDemo();
    expect(useData.getState().paretoModel).toBeNull();
    expect(localStorage.getItem('qp-pareto-v1')).toBeNull();
  });

  it('保存到项目:柏拉图摘要按真实数据计算(不再写死 Top2=68%)', () => {
    useData.getState().importPareto('六月缺陷', [
      { name: '划伤', count: 60 }, { name: '毛刺', count: 30 }, { name: '缺料', count: 10 },
    ]);
    useApp.setState({ page: 'pareto', paretoView: 'pareto' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.metric).toBe('Top2 = 90%');
    expect(saved?.title).toContain('六月缺陷');
  });

  it('保存 A、导入 B 后回看 A：恢复当时数据并按720迁移为显示全部类别', () => {
    useData.getState().importPareto('帕累托A', [{ name: '划伤', count: 30 }, { name: '毛刺', count: 10 }]);
    useApp.setState({ page: 'pareto', paretoView: 'pareto', paretoMergeOther: true, paretoThreshold: 0.9 });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.datasetName).toBe('帕累托A');

    useData.getState().importPareto('帕累托B', [{ name: '缺料', count: 99 }]);
    useApp.setState({ paretoMergeOther: false, paretoThreshold: 0.8 });
    useAnalyses.getState().restore(saved.id);

    expect(useData.getState().paretoModel).toEqual({
      name: '帕累托A', rows: [{ name: '划伤', count: 30 }, { name: '毛刺', count: 10 }],
    });
    expect(useApp.getState().paretoMergeOther).toBe(false);
    expect(useApp.getState().paretoThreshold).toBe(0.9);
    expect('paretoData' in useApp.getState()).toBe(false);
  });

  it('保存内置示例后可回看示例，不会落到空态或误用当前数据', () => {
    useApp.setState({ page: 'pareto', paretoView: 'pareto', paretoShowDemo: true });
    const saved = useAnalyses.getState().saveCurrent()!;
    expect(saved.title).toContain('内置示例');
    expect(saved.datasetName).toBe('内置示例');

    useData.getState().importPareto('当前B', [{ name: 'B类', count: 99 }]);
    useAnalyses.getState().restore(saved.id);
    expect(useData.getState().paretoModel).toBeNull();
    expect(useApp.getState().paretoShowDemo).toBe(true);
  });

  it('旧版缺数据的帕累托记录拒绝伪回看，明确提示且保留当前工作', () => {
    useData.getState().importPareto('当前B', [{ name: 'B类', count: 99 }]);
    useAnalyses.setState({
      saved: [{
        id: 'legacy-pareto', kind: 'pareto', title: '旧帕累托A', datasetName: '旧A',
        metric: 'Top2 = 80%', status: '已分析', statusColor: '#000', statusBg: '#fff', createdAt: 1,
        snapshot: { paretoView: 'pareto' },
      }],
    });
    useAnalyses.getState().restore('legacy-pareto');
    expect(useData.getState().paretoModel?.name).toBe('当前B');
    expect(useApp.getState().paretoShowDemo).toBe(false);
    expect(useApp.getState().toast).toContain('无法重建原图');
  });

  it('.qproj 白名单含 qp-pareto-v1 且往返恢复', () => {
    expect(PROJECT_KEYS).toContain('qp-pareto-v1');
    useData.getState().importPareto('x', [{ name: 'a', count: 5 }]);
    const json = buildProjectJson('t');
    localStorage.clear();
    expect(applyProjectJson(json)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-pareto-v1')!).name).toBe('x');
  });
});
