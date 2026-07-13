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

  it('.qproj 白名单含 qp-pareto-v1 且往返恢复', () => {
    expect(PROJECT_KEYS).toContain('qp-pareto-v1');
    useData.getState().importPareto('x', [{ name: 'a', count: 5 }]);
    const json = buildProjectJson('t');
    localStorage.clear();
    expect(applyProjectJson(json)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-pareto-v1')!).name).toBe('x');
  });
});
