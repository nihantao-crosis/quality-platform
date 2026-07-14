/** AQL 页真实批判定、追溯与转移交互。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../../App';
import { freshSwitchStatus } from '../../core/aqlSwitch';
import { useApp } from '../../store/appStore';
import { useAnalyses } from '../../store/analyses';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'aql', modal: null, openMenu: null,
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0,
    aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: freshSwitchStatus(),
  });
});

function recordBatch(batchId: string, nonconforming: number, fillInspector = false) {
  fireEvent.change(screen.getByLabelText('批次号'), { target: { value: batchId } });
  if (fillInspector) fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检-001' } });
  fireEvent.change(screen.getByLabelText('实际不合格品数'), { target: { value: String(nonconforming) } });
  fireEvent.click(screen.getByRole('button', { name: '记录本批并执行转移判定' }));
}

describe('AQL 批次工作流', () => {
  it('AQL 保存入口与历史行明确是摘要，不承诺回滚连续检验流', () => {
    render(<App />);
    const save = screen.getByText('保存当前摘要');
    expect(save.getAttribute('title')).toContain('不会回滚活跃状态');
    fireEvent.click(save);
    fireEvent.click(screen.getByText('质量总览'));
    expect(screen.getAllByTitle(/历史摘要：点击返回当前 AQL/)).toHaveLength(2);
  });

  it('连续批的批量变化不清零检验状态/转移得分，更换 AQL 才重建序列', () => {
    useApp.setState({
      aqlSwitch: {
        ...freshSwitchStatus(),
        state: 'tightened',
        history: ['R', 'A', 'R'],
        switchingScore: 7,
      },
    });
    useApp.getState().setAql({ aqlLot: 1800 });
    expect(useApp.getState().aqlSwitch).toMatchObject({
      state: 'tightened',
      history: ['R', 'A', 'R'],
      switchingScore: 7,
    });

    useApp.getState().setAql({ aqlAQL: 1.5 });
    expect(useApp.getState().aqlSwitch).toMatchObject({ state: 'normal', history: [], switchingScore: 0 });
  });

  it('从实际不合格数自动判定，留存责任字段，并在 2/5 后自动转加严', () => {
    render(<App />);
    expect(screen.getByText('自动判定：接收（d=0 ≤ Ac=3）')).toBeTruthy();

    recordBatch('LOT-001', 4, true); // 表 2-A K/125/Ac3/Re4：不接收
    recordBatch('LOT-002', 0);
    recordBatch('LOT-003', 4); // 3 批中第 2 批不接收，转加严

    const status = useApp.getState().aqlSwitch;
    expect(status.state).toBe('tightened');
    expect(status.history).toEqual(['R', 'A', 'R']);
    expect(status.records).toHaveLength(3);
    expect(status.records[0]).toMatchObject({
      batchId: 'LOT-001', inspector: '张检-001', nonconforming: 4,
      sourceTable: '2-A', sampleSize: 125, acceptanceNumber: 3, rejectionNumber: 4,
      decision: 'rejected', originalInspection: true,
    });
    expect(status.records[2].stateAfter).toBe('tightened');
    expect(screen.getAllByText(/GB\/T 2828\.1-2012 · 表 1 \+ 2-B/).length).toBeGreaterThan(0);
  });

  it('全检批仍可记录实际结果，但不展示抽样风险指标', () => {
    useApp.setState({ aqlLot: 8, aqlLevel: 'II', aqlAQL: 0.65, aqlSwitch: freshSwitchStatus() });
    render(<App />);
    expect(screen.getAllByText(/100% 全检/).length).toBeGreaterThan(0);
    expect(screen.queryByText('风险指标')).toBeNull();

    recordBatch('FULL-001', 1, true);
    const record = useApp.getState().aqlSwitch.records[0];
    expect(record).toMatchObject({
      batchId: 'FULL-001', sampleSize: 8, fullInspection: true,
      acceptanceNumber: 0, rejectionNumber: 1, nonconforming: 1, decision: 'rejected',
    });
  });
});
