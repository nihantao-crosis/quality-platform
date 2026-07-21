/** @vitest-environment jsdom */
/** 批次716-R3:能力口径全局统一 —— 能力页副标题/状态栏 Cpk/首页 Cpk 卡与能力页
 * 全部消费 resolveCapabilityMeasurementData,同一分析不再出现「页面有 Cpk、壳层说未运行」的四处矛盾。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import App from '../../App';
import { Dashboard } from '../pages/Dashboard';
import { useApp } from '../../store/appStore';
import { useData, resolveCapabilityMeasurementData } from '../../store/dataStore';
import { capabilityInputError, computeCapability, nf, DEFAULT_RULE_K } from '../../core';
import { chartTokens } from '../tokens';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'dashboard', modal: null, openMenu: null, toast: null, selSub: null,
    capSubgroupMode: 'spc', capSubgroupSize: 5, capValueCol: null, capSubgroupIdCol: null,
    spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null,
    spcRuleK: { ...DEFAULT_RULE_K },
    lslOn: true, uslOn: true,
  });
});

/** 量纲悬殊双列(与批次716-R2 同一夹具):auto 布局下 SPC 口径必然歧义,
 * 但能力口径可用「单列 + 子组大小」明确落在过盈量上。 */
function importDisparate() {
  useData.getState().importMatrix('压装工序', ['压入力', '过盈量'],
    [[812, 0.055], [905, 0.061], [1010, 0.076], [860, 0.058], [950, 0.068], [880, 0.062]], []);
}

/** 能力页同源口径:resolver → 输入闸门 → computeCapability,与页面/保存记录一致。 */
function capFromResolver() {
  const d = useData.getState();
  const prepared = resolveCapabilityMeasurementData(d.model, d.textCols);
  if (!prepared.model || prepared.error) return null;
  const app = useApp.getState();
  const spec = { lsl: app.lslOn ? app.lsl : null, tgt: app.tgt, usl: app.uslOn ? app.usl : null };
  if (capabilityInputError(prepared.model.all, prepared.model.sigmaWithin, spec) != null) return null;
  return computeCapability(prepared.model.all, prepared.model.sigmaWithin, spec);
}

describe('批次716-R3:首页 Cpk 卡消费能力口径', () => {
  it('const 模式选「过盈量」后,Dashboard Cpk 数值与能力页同源计算一致,不显示未运行', () => {
    importDisparate();
    useApp.setState({
      capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量',
      lsl: 0.04, tgt: 0.065, usl: 0.1, lslOn: true, uslOn: true,
    });
    const expected = capFromResolver();
    expect(expected).not.toBeNull();
    const view = render(createElement(Dashboard, { T: chartTokens('经典', true) }));
    const card = view.getByText('过程能力 Cpk').parentElement;
    expect(card?.textContent).toContain(nf(expected!.cpk, 2));
    expect(card?.textContent).not.toContain('未运行');
    // 能力口径与 SPC 口径不同时,卡片小字注明当前口径,说明该 Cpk 属于哪份数据
    expect(card?.textContent).toContain('能力口径:单列「过盈量」×子组2');
  });
});

describe('批次716-R3:SPC 口径歧义但能力口径有效时,壳层不再报未运行/待配置', () => {
  it('状态栏 Cpk 显示数值、能力页副标题为「正态能力」而非「能力数据角色待配置」', () => {
    importDisparate();
    useApp.setState({
      capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量',
      lsl: 0.04, tgt: 0.065, usl: 0.1, lslOn: true, uslOn: true,
    });
    const expected = capFromResolver();
    expect(expected).not.toBeNull();
    const expectedText = nf(expected!.cpk, 2);

    const app = render(createElement(App));
    // 首页 Cpk 卡:数值来自能力口径,不再因 SPC 歧义显示「未运行」
    const card = app.getByText('过程能力 Cpk').parentElement;
    expect(card?.textContent).toContain(expectedText);
    expect(card?.textContent).not.toContain('未运行');
    // 状态栏:同一 Cpk
    const statusBar = app.getByText('工作表: 压装工序', { exact: true }).parentElement;
    expect(statusBar?.textContent).toContain(`Cpk ${expectedText}`);

    // 能力页副标题:跟随能力口径,不再写「能力数据角色待配置」
    act(() => useApp.setState({ page: 'capability' }));
    expect(app.container.textContent).not.toContain('能力数据角色待配置');
    expect(app.container.textContent).toContain('正态能力 · 过盈量');
    expect(app.container.textContent).toContain('当前生效:测量列「过盈量」 · 按行序每 2 个观测为一个子组');
    // 能力页本体同样在运行(四处同源)
    expect(app.container.textContent).not.toContain('过程能力分析未运行');
  });
});

describe('批次716-R3:量纲哨兵触发时四处一致显示未运行', () => {
  it('过盈量数据配压入力量纲规格 → 首页卡/状态栏/副标题/能力页全部未运行,原因一致', () => {
    importDisparate();
    useApp.setState({
      capSubgroupMode: 'const', capSubgroupSize: 2, capValueCol: '过盈量',
      lsl: 500, tgt: 900, usl: 1400, lslOn: true, uslOn: true,
    });
    expect(capFromResolver()).toBeNull();

    const app = render(createElement(App));
    // 首页 Cpk 卡:未运行 + 哨兵原因(与能力页同一 capabilityInputError 文案)
    const card = app.getByText('过程能力 Cpk').parentElement;
    expect(card?.textContent).toContain('未运行');
    expect(card?.textContent).toContain('1000 倍标准差');
    // 状态栏:Cpk —
    const statusBar = app.getByText('工作表: 压装工序', { exact: true }).parentElement;
    expect(statusBar?.textContent).toContain('Cpk —');

    // 能力页:副标题与页面主体一致显示未运行
    act(() => useApp.setState({ page: 'capability' }));
    expect(app.container.textContent).toContain('未运行(输入校验未通过)');
    expect(app.container.textContent).toContain('过程能力分析未运行');
    expect(app.container.textContent).toContain('1000 倍标准差');
  });
});
