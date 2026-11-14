/**
 * fix2609n · G24b-ui(第 7 批对抗复审收口·界面)。全部走真实组件 / 真实 store / 真实严格解析。
 * B1   AQL 批量 N 改用 StrictNumberInput:逐键「12,000」「250件」「3,5」途经的合法前缀不留在 store、
 *      不进责任账本;失焦/卸载/重挂载后框内是编辑前的值;合法整串仍实时生效。
 * B3a  能力规格限回退时一并恢复 1000σ 强警告确认(captureRevert 快照 lsl/tgt/usl + 确认)。
 * B3b  回退前核对 store 实时值仍是本会话最后一次提交的值;外部写入已落地(组件尚未重渲染)时放弃回退。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshSwitchStatus, isAqlBatchRecord } from '../../core';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { Aql } from '../pages/Aql';
import { Capability } from '../pages/Capability';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    modal: null, openMenu: null, toast: null, page: 'aql', aqlLedgerFault: null,
    aqlLot: 1000, aqlLevel: 'II', aqlAQL: 1.0, aqlRegime: 'percent', aqlSwitch: freshSwitchStatus(),
  });
});
afterEach(() => cleanup());

/** 逐键输入(每键一次 change),返回每键之后的 store 取值轨迹。 */
function typeKeys<V>(el: HTMLInputElement, text: string, read: () => V): V[] {
  const trail: V[] = [];
  let acc = '';
  for (const ch of text) {
    acc += ch;
    fireEvent.change(el, { target: { value: acc } });
    trail.push(read());
  }
  return trail;
}

describe('B1 AQL 批量 N:逐键合法前缀不留在 store / 责任账本', () => {
  for (const raw of ['12,000', '250件', '3,5']) {
    it(`逐键「${raw}」+ 失焦 + 卸载/重挂载:aqlLot 仍是编辑前的 1000,框内无前缀`, () => {
      const r = render(<Aql T={T} />);
      const box = screen.getByLabelText('批量 N') as HTMLInputElement;
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '' } });
      typeKeys(box, raw, () => useApp.getState().aqlLot);
      expect(useApp.getState().aqlLot).toBe(1000);
      fireEvent.blur(box);
      // 非法终串保留原串并就地告警(沿用既有口径「当前仍使用 …」)
      expect(box.value).toBe(raw);
      const alert = screen.getAllByRole('alert').map((a) => a.textContent ?? '').find((t) => t.includes('批量 N'));
      expect(alert).toBeDefined();
      expect(alert).toContain('当前仍使用 1,000');
      expect(alert).toContain('未修改');
      r.unmount();
      expect(useApp.getState().aqlLot).toBe(1000);
      render(<Aql T={T} />);
      expect((screen.getByLabelText('批量 N') as HTMLInputElement).value).toBe('1000');
    });
  }

  it('逐键「250件」后直接登记本批:责任账本记录的批量是编辑前的 1000,不是前缀 250', () => {
    render(<Aql T={T} />);
    const box = screen.getByLabelText('批量 N') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    typeKeys(box, '250件', () => useApp.getState().aqlLot);
    fireEvent.blur(box);
    fireEvent.change(screen.getByLabelText('批次号'), { target: { value: 'LOT-1' } });
    fireEvent.change(screen.getByLabelText('检验人'), { target: { value: '张检' } });
    fireEvent.click(screen.getByRole('button', { name: '记录本批并执行转移判定' }));
    const batches = useApp.getState().aqlSwitch.records.filter(isAqlBatchRecord);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ batchId: 'LOT-1', lot: 1000 });
  });

  it('合法整串实时生效,失焦/卸载后保留;空串不生效', () => {
    const r = render(<Aql T={T} />);
    const box = screen.getByLabelText('批量 N') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    expect(useApp.getState().aqlLot).toBe(1000);
    const trail = typeKeys(box, '2500', () => useApp.getState().aqlLot);
    // 「2」本身是合法整串(≥2),实时生效;终串 2500
    expect(trail).toEqual([2, 25, 250, 2500]);
    fireEvent.blur(box);
    expect(screen.queryAllByRole('alert').some((a) => (a.textContent ?? '').includes('批量 N'))).toBe(false);
    r.unmount();
    expect(useApp.getState().aqlLot).toBe(2500);
    render(<Aql T={T} />);
    expect((screen.getByLabelText('批量 N') as HTMLInputElement).value).toBe('2500');
  });
});

function setupCapability(scale: number) {
  const rows = Array.from({ length: 25 }, (_, i) => Array.from({ length: 5 }, (_, j) => 25 + scale * (((i * 7 + j * 3) % 11) - 5)));
  useData.getState().importMatrix('能力.csv', ['C1', 'C2', 'C3', 'C4', 'C5'], rows);
  useApp.setState({
    page: 'capability', lsl: 20, tgt: 25, usl: 30, lslOn: true, uslOn: true, spcDataLayout: 'rows',
    capabilityWarningAcknowledgement: null,
  });
}

describe('B3a 能力规格限回退一并恢复 1000σ 强警告确认', () => {
  it('确认超 1000σ 警示后,LSL 打「2」再打「2m」:规格回到 20,确认仍在,页面不再要求重新确认', () => {
    setupCapability(0.0001);
    render(<Capability T={T} />);
    fireEvent.click(screen.getByRole('button', { name: '我已核对测量角色与规格，继续计算' }));
    const ack = useApp.getState().capabilityWarningAcknowledgement;
    expect(ack).not.toBeNull();
    expect(screen.queryByRole('button', { name: '我已核对测量角色与规格，继续计算' })).toBeNull();

    const box = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '2' } });
    expect(useApp.getState().lsl).toBe(2);
    fireEvent.change(box, { target: { value: '2m' } });
    expect(useApp.getState().lsl).toBe(20);
    expect(useApp.getState().capabilityWarningAcknowledgement).toBe(ack);
    expect(screen.queryByRole('button', { name: '我已核对测量角色与规格，继续计算' })).toBeNull();
    // 回退后的规格同步记忆到当前数据集(重启/切换数据集后恢复的是编辑前的 20,不是前缀 2)
    expect(useApp.getState().lsl).toBe(20);
  });

  it('直接合法修改后确认照常失效(确认绑定规格,不因本修复被保留)', () => {
    setupCapability(0.0001);
    render(<Capability T={T} />);
    fireEvent.click(screen.getByRole('button', { name: '我已核对测量角色与规格，继续计算' }));
    const box = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '19' } });
    fireEvent.blur(box);
    expect(useApp.getState().lsl).toBe(19);
    expect(useApp.getState().capabilityWarningAcknowledgement).toBeNull();
  });
});

describe('B3b 回退前核对 store 实时值', () => {
  it('会话已写入前缀「2」后,外部写入 lsl=7 与下一键「2m」在同一批次落地:放弃回退,保留外部写入', () => {
    setupCapability(1);
    render(<Capability T={T} />);
    const box = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '2' } });
    expect(useApp.getState().lsl).toBe(2);
    // act 内 React 暂不重渲染:事件处理器看到的仍是旧 value(2),但 store 已是外部写入的 7
    act(() => {
      useApp.getState().setSpec({ lsl: 7 });
      fireEvent.change(box, { target: { value: '2m' } });
    });
    expect(useApp.getState().lsl).toBe(7);
    // 会话结束:框内保留原串并如实说明当前生效值
    expect(box.value).toBe('2m');
    expect(screen.getByRole('alert').textContent).toContain('7');
  });

  it('同一会话内无外部写入时照常回退(基线)', () => {
    setupCapability(1);
    render(<Capability T={T} />);
    const box = screen.getByRole('textbox', { name: 'LSL 下限' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '2' } });
    fireEvent.change(box, { target: { value: '2m' } });
    expect(useApp.getState().lsl).toBe(20);
  });
});
