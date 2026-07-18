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
    aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent',
    aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: freshSwitchStatus(),
  });
});

function recordBatch(batchId: string, nonconforming: number, fillInspector = false) {
  fireEvent.change(screen.getByLabelText('批次号'), { target: { value: batchId } });
  if (fillInspector) fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检-001' } });
  fireEvent.change(screen.getByLabelText('实际不合格品数'), { target: { value: String(nonconforming) } });
  const disposition = screen.queryByLabelText('不合格品处置');
  if (disposition) fireEvent.change(disposition, { target: { value: 'pending' } });
  fireEvent.click(screen.getByRole('button', { name: '记录本批并执行转移判定' }));
}

describe('AQL 批次工作流', () => {
  it('AQL 保存入口与历史行明确是摘要，不承诺回滚连续检验流', () => {
    render(<App />);
    const save = screen.getByText('保存当前摘要');
    expect(save.getAttribute('title')).toContain('不会回滚活跃状态');
    fireEvent.click(save);
    fireEvent.click(screen.getByText('质量总览'));
    expect(screen.getAllByTitle(/历史摘要：点击返回当前 AQL/)).toHaveLength(1);
    expect(screen.getAllByTitle(/保存于 .*点击返回当前 AQL/)).toHaveLength(1);
  });

  it('连续批的批量变化不清零状态，非正常检验期间不能换 AQL 绕过转移规则', () => {
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

    expect(() => useApp.getState().setAql({ aqlAQL: 1.5 })).toThrow(/恢复正常检验/);
    expect(useApp.getState()).toMatchObject({ aqlAQL: 1.0 });
    expect(useApp.getState().aqlSwitch).toMatchObject({ state: 'tightened', history: ['R', 'A', 'R'] });

    render(<App />);
    expect(screen.getByRole('button', { name: 'AQL 1.5' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/质量表示、检验水平与 AQL 已锁定/)).toBeTruthy();
  });

  it('正常检验换参数建立新序列，责任账本保留但转移得分重新起算', () => {
    render(<App />);
    recordBatch('SEQ-OLD', 0, true);
    const before = useApp.getState().aqlSwitch;
    expect(before.switchingScore).toBe(3);

    useApp.getState().setAql({ aqlAQL: 1.5 });
    const after = useApp.getState().aqlSwitch;
    expect(after).toMatchObject({ state: 'normal', history: [], switchingScore: 0 });
    expect(after.records.map((record) => record.batchId)).toEqual(['SEQ-OLD']);
    expect(after.sequenceId).not.toBe(before.sequenceId);
  });

  it('§9.4 暂停不能通过切走再切回 AQL 清除', () => {
    const suspended = {
      ...freshSwitchStatus(), state: 'tightened' as const, suspended: true,
      tightenedRejections: 5, history: ['R'] as const satisfies readonly ['R'],
      note: '加严累计 5 批不接收，暂停',
    };
    useApp.setState({ aqlSwitch: { ...suspended, history: [...suspended.history] } });
    const before = useApp.getState().aqlSwitch;
    expect(() => useApp.getState().setAql({ aqlAQL: 1.5 })).toThrow(/已暂停/);
    expect(() => useApp.getState().setAql({ aqlLevel: 'III' })).toThrow(/已暂停/);
    expect(useApp.getState()).toMatchObject({ aqlAQL: 1.0, aqlLevel: 'II' });
    expect(useApp.getState().aqlSwitch).toEqual(before);
  });

  it('同版本 v3 localStorage 水合也会校验，不接纳非法放宽或空记录', async () => {
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: {
        aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0,
        aqlMethod: 'shift', aqlAcMethod: 'binom',
        aqlSwitch: {
          ...freshSwitchStatus(), state: 'reduced', switchingScore: 30,
          productionSteady: false, reducedApproved: false, records: [{}],
        },
      },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({ aqlMethod: 'gb', aqlAcMethod: 'gb' });
    expect(useApp.getState().aqlSwitch).toMatchObject({ state: 'normal', switchingScore: 0, records: [] });
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
    expect(screen.getByText(/批接收不等于放行不合格品/)).toBeTruthy();
    expect(screen.queryByText('风险指标')).toBeNull();

    fireEvent.change(screen.getByLabelText('批次号'), { target: { value: 'FULL-001' } });
    fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检-001' } });
    fireEvent.change(screen.getByLabelText('实际不合格品数'), { target: { value: '1' } });
    const submit = screen.getByRole('button', { name: '记录本批并执行转移判定' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('不合格品处置'), { target: { value: 'pending' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    const record = useApp.getState().aqlSwitch.records[0];
    expect(record).toMatchObject({
      batchId: 'FULL-001', sampleSize: 8, fullInspection: true,
      acceptanceNumber: 0, rejectionNumber: 1, nonconforming: 1,
      nonconformingDisposition: 'pending', decision: 'rejected',
    });
  });

  it('空白不合格品数保持无效，不能再被 Number(空串) 当成 0 提交', () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('批次号'), { target: { value: 'EMPTY-D' } });
    fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检-001' } });
    fireEvent.change(screen.getByLabelText('实际不合格品数'), { target: { value: '' } });

    expect(screen.getByText('自动判定：请输入有效整数')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '记录本批并执行转移判定' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(useApp.getState().aqlSwitch.records).toHaveLength(0);
  });
});
