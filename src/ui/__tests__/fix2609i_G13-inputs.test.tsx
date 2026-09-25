/**
 * 2026-09 全面审查第 4 批 G13-inputs(2b+1d 复审收口):手工数值输入。
 * (1) GAP-8-4-final:iOS/iPadOS 的 inputMode="decimal" 键盘没有负号(且小数键随地区可能是「,」),
 *     工作表单元格编辑与 DOE 一般全因子水平值在 iOS 上改用全键盘(inputMode=text),其它平台保留 decimal;
 *     逗号类拒绝原因附 iOS 地区小数键说明。
 * (2) 2b1d-holistic:查找/替换、随机数据 μ/σ/k/n、P 图默认 n、单样本 t 的 μ₀ 此前仍是 type=number 且
 *     `if (parsed.ok) set(...)` 静默忽略非法输入(随机数据 μ 填「12.5mm」按旧值 25 生成并提示「已生成」)。
 *     现统一 type=text + 严格解析,显示原因,非法时禁用提交;用原始串「1,000」「12.5mm」走真实提交路径。
 * 全部调用真实生产函数 / 真实组件 / 真实 store。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isIosTouchDevice, numericInputMode, parseStrictNumber } from '../../core/numberInput';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import App from '../../App';
import { Worksheet } from '../pages/Worksheet';
import { Anova } from '../pages/SimplePages';
import { Modals } from '../shell/Modals';
import { chartTokens } from '../tokens';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0';

/** 把 jsdom 的 navigator 伪装成指定平台(真实组件读取的是全局 navigator)。 */
function emulateNavigator(userAgent: string, maxTouchPoints: number) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, get: () => maxTouchPoints });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ modal: null, openMenu: null, toast: null, t1ColName: null, t1Mu0: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window.navigator as unknown as Record<string, unknown>).maxTouchPoints;
});

describe('(1) iOS 软键盘:判定函数可注入,两种平台都覆盖', () => {
  it('iPhone、iPadOS 桌面版 UA(Macintosh+触屏)判为 iOS;真 Mac、Android、Windows 不是', () => {
    expect(isIosTouchDevice({ userAgent: IPHONE_UA, maxTouchPoints: 5 })).toBe(true);
    expect(isIosTouchDevice({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })).toBe(true);
    expect(isIosTouchDevice({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 })).toBe(false); // 真 Mac
    expect(isIosTouchDevice({ userAgent: ANDROID_UA, maxTouchPoints: 5 })).toBe(false);
    expect(isIosTouchDevice({ userAgent: WINDOWS_UA, maxTouchPoints: 10 })).toBe(false); // 触屏 Windows
    expect(isIosTouchDevice(undefined)).toBe(false);
    expect(numericInputMode({ userAgent: IPHONE_UA, maxTouchPoints: 5 })).toBe('text');
    expect(numericInputMode({ userAgent: ANDROID_UA, maxTouchPoints: 5 })).toBe('decimal');
  });

  it('逗号类拒绝原因说明 iOS 地区小数键会显示为「,」', () => {
    const decimalComma = parseStrictNumber('3,5');
    const ambiguous = parseStrictNumber('1,000');
    expect(decimalComma.ok).toBe(false);
    expect(ambiguous.ok).toBe(false);
    if (!decimalComma.ok) expect(decimalComma.reason).toMatch(/iPhone\/iPad 的小数键随地区设置可能显示为「,」/);
    if (!ambiguous.ok) expect(ambiguous.reason).toMatch(/iPhone\/iPad/);
  });

  it('iPhone 上工作表单元格编辑器不是 decimal 键盘(修复前恒为 inputMode="decimal",无负号键),负值可录入', () => {
    emulateNavigator(IPHONE_UA, 5);
    useData.getState().importMatrix('iOS 编辑', ['偏差'], [[0.01], [0.02], [0.03]]);
    render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    fireEvent.doubleClick(within(grid).getByRole('gridcell', { name: /^偏差，第 1 行，当前值/ }));
    const input = screen.getByLabelText('编辑偏差，第 1 行') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('text');
    fireEvent.change(input, { target: { value: '-0.012' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useData.getState().model.subs[0].vals[0]).toBe(-0.012);
  });

  it('桌面 / Android 平台工作表编辑器保留 decimal', () => {
    emulateNavigator(ANDROID_UA, 5);
    useData.getState().importMatrix('安卓编辑', ['偏差'], [[0.01], [0.02], [0.03]]);
    render(<Worksheet />);
    const grid = screen.getByRole('grid', { name: '数据工作表' });
    fireEvent.doubleClick(within(grid).getByRole('gridcell', { name: /^偏差，第 1 行，当前值/ }));
    expect(screen.getByLabelText('编辑偏差，第 1 行').getAttribute('inputmode')).toBe('decimal');
  });

  it('iPad(桌面版 UA)上 DOE 一般全因子水平值不是 decimal 键盘,编码水平 -1 可生成', () => {
    emulateNavigator(IPAD_DESKTOP_UA, 5);
    useApp.setState({ page: 'doe', doeTab: 'create' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '一般全因子' }));
    const first = screen.getByLabelText('一般全因子因子 1 水平 1 数值');
    expect(first.getAttribute('type')).toBe('text');
    expect(first.getAttribute('inputmode')).toBe('text');
    ['-1', '0', '1'].forEach((value, index) =>
      fireEvent.change(screen.getByLabelText(`一般全因子因子 1 水平 ${index + 1} 数值`), { target: { value } }));
    fireEvent.click(screen.getByRole('button', { name: '生成设计表 → 工作表' }));
    expect(useApp.getState().page).toBe('worksheet');
    const { model } = useData.getState();
    const factorIndex = model.colNames.findIndex((name) => !['标准序', '运行序', '区组'].includes(name));
    expect([...new Set(model.subs.map((s) => s.vals[factorIndex]))].sort((a, b) => a - b)).toEqual([-1, 0, 1]);
  });
});

describe('(2) 其余数值入口:type=text + 严格解析 + 可见原因 + 非法禁用提交', () => {
  it('随机数据 μ=「12.5mm」:显示原因、禁用「生成」,不再按旧值 25 生成并提示「已生成」', () => {
    useApp.setState({ modal: 'random' });
    render(<Modals />);
    const before = useData.getState().model.name;
    const mu = screen.getByLabelText('均值 μ') as HTMLInputElement;
    expect(mu.getAttribute('type')).toBe('text');
    fireEvent.change(mu, { target: { value: '12.5mm' } });
    expect(mu.value).toBe('12.5mm');
    expect(mu.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/均值 μ：「12\.5mm」含单位或多余字符「mm」/);
    const button = screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(useData.getState().model.name).toBe(before);
    expect(useApp.getState().modal).toBe('random');
    expect(useApp.getState().toast ?? '').not.toMatch(/已生成/);
  });

  it('随机数据 σ=「1,000」、k=「1,000」拒绝;σ≤0、n 超范围拒绝;改为合法原始串后按真实值生成', () => {
    useApp.setState({ modal: 'random' });
    render(<Modals />);
    const button = () => screen.getByRole('button', { name: '生成' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('标准差 σ'), { target: { value: '1,000' } });
    fireEvent.change(screen.getByLabelText('子组数 k'), { target: { value: '1,000' } });
    expect(screen.getByRole('alert').textContent).toMatch(/标准差 σ：「1,000」含逗号/);
    expect(screen.getByRole('alert').textContent).toMatch(/子组数 k：「1,000」含逗号/);
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('标准差 σ'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('子组数 k'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('子组大小 n'), { target: { value: '11' } });
    expect(screen.getByRole('alert').textContent).toMatch(/标准差 σ：.*须大于 0/);
    expect(screen.getByRole('alert').textContent).toMatch(/子组大小 n：「11」超出允许范围/);
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('均值 μ'), { target: { value: '－0.5' } });
    fireEvent.change(screen.getByLabelText('标准差 σ'), { target: { value: '0.02' } });
    fireEvent.change(screen.getByLabelText('子组大小 n'), { target: { value: '4' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(button());
    const { model } = useData.getState();
    expect(model.name).toBe('随机数据 N(-0.5,0.02)');
    expect(model.k).toBe(30);
    expect(model.subs[0].vals).toHaveLength(4);
    expect(useApp.getState().toast).toMatch(/已生成 .* 30 子组 × 4/);
  });

  it('查找/替换:输入框为 type=text,「12.5mm」「1,000」原样到达解析层并禁用「全部替换」', () => {
    useData.getState().importMatrix('替换测试', ['直径'], [[12.5], [1000], [3]]);
    useApp.setState({ modal: 'findreplace' });
    render(<Modals />);
    const find = screen.getByLabelText('查找数值') as HTMLInputElement;
    const repl = screen.getByLabelText('替换为') as HTMLInputElement;
    expect(find.getAttribute('type')).toBe('text');
    expect(repl.getAttribute('type')).toBe('text');
    const button = () => screen.getByRole('button', { name: '全部替换' }) as HTMLButtonElement;
    fireEvent.change(find, { target: { value: '12.5mm' } });
    expect(find.value).toBe('12.5mm');
    expect(screen.getByRole('alert').textContent).toMatch(/单位或多余字符「mm」/);
    fireEvent.change(repl, { target: { value: '7' } });
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(useData.getState().model.subs[0].vals[0]).toBe(12.5);

    fireEvent.change(find, { target: { value: '1,000' } });
    expect(screen.getByRole('alert').textContent).toMatch(/「1,000」含逗号/);
    expect(button().disabled).toBe(true);

    fireEvent.change(find, { target: { value: '12.5' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(button());
    expect(useData.getState().model.subs[0].vals[0]).toBe(7);
  });

  it('P 图默认 n:「1,000」「12.5mm」显示原因并禁用「导入」;改为合法值后按真实 n 导入', async () => {
    useApp.setState({ modal: 'import', importTab: 'clip', importKind: 'p' });
    render(<Modals />);
    const n = screen.getByDisplayValue('50') as HTMLInputElement;
    expect(n.getAttribute('type')).toBe('text');
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '不良数\n3\n5\n2\n4\n6' } });
    const importButton = () => screen.getByRole('button', { name: '导入' }) as HTMLButtonElement;
    const beforeP = useData.getState().pModel;

    fireEvent.change(n, { target: { value: '1,000' } });
    expect(n.value).toBe('1,000');
    expect(screen.getByRole('alert').textContent).toMatch(/单列默认样本量 n 无效：「1,000」含逗号/);
    expect(importButton().disabled).toBe(true);
    fireEvent.click(importButton());

    fireEvent.change(n, { target: { value: '12.5mm' } });
    expect(screen.getByRole('alert').textContent).toMatch(/「12\.5mm」含单位或多余字符「mm」/);
    expect(importButton().disabled).toBe(true);
    fireEvent.click(importButton());
    expect(useData.getState().pModel).toBe(beforeP);
    expect(useApp.getState().modal).toBe('import');

    fireEvent.change(n, { target: { value: '40' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importButton().disabled).toBe(false);
    await act(async () => { fireEvent.click(importButton()); });
    await waitFor(() => expect(useApp.getState().modal).toBeNull());
    const pModel = useData.getState().pModel;
    expect(pModel.pdef).toEqual([3, 5, 2, 4, 6]);
    expect(pModel.pN).toBe(40);
  });

  it('单样本 t 的 μ₀:「12.5mm」「1,000」显示原因并明示结果仍按上一次有效值;合法值写入', () => {
    useData.getState().importMatrix('t 检验', ['A'], [[10.1], [10.3], [9.9], [10.2], [10.0]]);
    useApp.setState({ page: 'anova', hypoTab: 't1', t1ColName: 'A', t1Mu0: 10 });
    render(<Anova T={chartTokens('经典', true)} />);
    const mu0 = screen.getByLabelText('单样本 t 目标 μ₀') as HTMLInputElement;
    expect(mu0.getAttribute('type')).toBe('text');

    fireEvent.change(mu0, { target: { value: '12.5mm' } });
    expect(mu0.value).toBe('12.5mm');
    expect(mu0.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/μ₀无效：「12\.5mm」含单位或多余字符「mm」；请只输入数字；未修改，仍按编辑前的值 10$/); // fix2609m G23c C1:改用共享严格数值框
    expect(useApp.getState().t1Mu0).toBe(10);

    fireEvent.change(mu0, { target: { value: '1,000' } });
    expect(screen.getByRole('alert').textContent).toMatch(/「1,000」含逗号/);
    expect(useApp.getState().t1Mu0).toBe(10);

    fireEvent.change(mu0, { target: { value: '-10.2' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useApp.getState().t1Mu0).toBe(-10.2);
    fireEvent.blur(mu0);
    expect(mu0.value).toBe('-10.2');
  });
});
