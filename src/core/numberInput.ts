/**
 * 手工数值输入的严格解析（2026-09 全面审查 GAP-8-4/8-5/8-6 同族整改）。
 *
 * 此前各页面散落着 `parseFloat(text)`：它遇到第一个非法字符就截断并返回前缀，
 * 「1,000」→1、「12.5mm」→12.5、「0x10」→0 都是合法有限数，下游任何
 * `Number.isFinite` 守卫都拦不住，数值被静默换成另一个数。本模块给出唯一口径：
 *
 * - 全角数字 / 全角小数点 / 全角加号 / 各类减号（全角 －、U+2212 −、小号 ﹣）先归一化为半角；
 * - 首尾空白（含全角空格、NBSP）忽略；数字中间的空白一律拒绝（「1 000」不猜）；
 * - 千分位逗号只在**无歧义**时接受：必须严格三位一组，且要么有两组以上（1,234,567），
 *   要么后面跟小数点（1,000.5）——此时逗号不可能是小数点。单组「1,000」既可能是
 *   一千，也可能是欧式小数 1.000，拒绝并提示去掉逗号；绝不静默截断成 1；
 * - 其余形态（单位、百分号、十六进制、多余字符、超出双精度范围）全部拒绝，并返回可直接
 *   显示给用户的中文原因。
 */

const STRICT_NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const NUMBER_PREFIX_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;
/** 严格三位分组：1,234 / 12,345,678 / 1,234.5 */
const GROUPED_RE = /^([+-]?)(\d{1,3}(?:,\d{3})+)(\.\d*)?$/;

/**
 * iPhone/iPad 在欧洲等地区设置下，数字小数键显示为「,」。本应用在 iOS 上已改用全键盘
 * （见 {@link numericInputMode}），123 页有「.」与「-」；逗号类拒绝原因附带这句说明，
 * 让从其它 App 习惯「,」小数的用户知道怎么改。
 */
const IOS_DECIMAL_COMMA_HINT = '（iPhone/iPad 的小数键随地区设置可能显示为「,」，请在键盘 123 页输入「.」）';

export type StrictNumberResult =
  | { ok: true; value: number; /** 接受了千分位等需要告知用户的写法时给出说明 */ note?: string }
  | { ok: false; empty: boolean; reason: string };

/** 全角/异体字符归一化为半角；不改变其它字符（用于解析与错误提示）。 */
export function normalizeNumberText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) out += String.fromCharCode(code - 0xff10 + 48); // ０-９
    else if (ch === '．') out += '.';
    else if (ch === '＋') out += '+';
    else if (ch === '－' || ch === '−' || ch === '﹣') out += '-';
    else if (ch === '，') out += ',';
    else if (ch === 'Ｅ') out += 'E';
    else if (ch === 'ｅ') out += 'e';
    else out += ch;
  }
  return out.trim();
}

function display(text: string): string {
  const compact = text.trim();
  return compact.length > 24 ? `${compact.slice(0, 23)}…` : compact;
}

/**
 * 严格解析一个手工输入的数值。空串返回 `{ ok:false, empty:true }`，
 * 调用方可自行决定「空=未填写」还是报错。
 */
export function parseStrictNumber(text: string): StrictNumberResult {
  const raw = String(text ?? '');
  const s = normalizeNumberText(raw);
  if (s === '') return { ok: false, empty: true, reason: '未填写数值' };
  const shown = display(raw);
  if (STRICT_NUMBER_RE.test(s)) {
    const value = Number(s);
    if (!Number.isFinite(value)) return { ok: false, empty: false, reason: `「${shown}」超出可表示的数值范围` };
    return { ok: true, value };
  }
  const grouped = GROUPED_RE.exec(s);
  if (grouped) {
    const groups = grouped[2].split(',').length - 1;
    const hasDecimal = grouped[3] !== undefined;
    if (groups >= 2 || hasDecimal) {
      const value = Number(`${grouped[1]}${grouped[2].replace(/,/g, '')}${grouped[3] ?? ''}`);
      if (Number.isFinite(value)) return { ok: true, value, note: `「${shown}」已按千分位读作 ${value}` };
    }
    return {
      ok: false, empty: false,
      reason: `「${shown}」含逗号，无法确定是千分位还是小数点；请去掉逗号后输入（如 ${grouped[1]}${grouped[2].replace(/,/g, '')}）${IOS_DECIMAL_COMMA_HINT}`,
    };
  }
  if (s.includes(',')) {
    return { ok: false, empty: false, reason: `「${shown}」含逗号；小数请用「.」，千分位请去掉逗号${IOS_DECIMAL_COMMA_HINT}` };
  }
  if (/\s/.test(s)) {
    return { ok: false, empty: false, reason: `「${shown}」数字中间含空格；请只输入一个数值` };
  }
  if (/^[+-]?0[xX]/.test(s)) {
    return { ok: false, empty: false, reason: `「${shown}」是十六进制写法，不接受；请输入十进制数值` };
  }
  const prefix = NUMBER_PREFIX_RE.exec(s);
  if (prefix && prefix[0].length > 0) {
    const rest = s.slice(prefix[0].length);
    return { ok: false, empty: false, reason: `「${shown}」含单位或多余字符「${display(rest)}」；请只输入数字` };
  }
  return { ok: false, empty: false, reason: `「${shown}」不是有效数值` };
}

/** 严格解析整数；可选闭区间范围。小数、千分位以外的任何多余字符都拒绝。 */
export function parseStrictInteger(
  text: string,
  range: { min?: number; max?: number } = {},
): StrictNumberResult {
  const parsed = parseStrictNumber(text);
  if (!parsed.ok) return parsed;
  const shown = display(String(text ?? ''));
  if (!Number.isSafeInteger(parsed.value)) {
    return { ok: false, empty: false, reason: `「${shown}」不是整数` };
  }
  if ((range.min !== undefined && parsed.value < range.min) || (range.max !== undefined && parsed.value > range.max)) {
    const lo = range.min !== undefined ? range.min.toLocaleString() : '';
    const hi = range.max !== undefined ? range.max.toLocaleString() : '';
    return { ok: false, empty: false, reason: `「${shown}」超出允许范围 ${lo}–${hi}` };
  }
  return parsed;
}

/** 平台判定所需的最小 navigator 形状；测试里可直接传对象覆盖 iOS / 非 iOS 两种平台。 */
export interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
}

function currentNavigator(): NavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator;
}

/**
 * 是否 iOS / iPadOS 触屏设备（Safari、PWA、内嵌 WebView）。iPadOS 13+ 默认「桌面版网站」，
 * UA 报 Macintosh，只能靠 maxTouchPoints>0 与真 Mac 区分。
 */
export function isIosTouchDevice(nav: NavigatorLike | undefined = currentNavigator()): boolean {
  if (!nav) return false;
  const touchPoints = typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
  return touchPoints > 0 && /iPad|iPhone|Macintosh/.test(nav.userAgent ?? '');
}

/**
 * 可带负号 / 小数的手工数值输入框应使用的 inputMode（输入框本身一律 type="text"，由
 * {@link parseStrictNumber} 严格解析原始串）。
 *
 * iOS/iPadOS 的 `decimal` 软键盘只有数字和小数点，**没有负号**，且小数键随地区设置可能是「,」，
 * 负偏差、编码水平 -1 等无法用软键盘录入；因此 iOS 上改用 `text`（全键盘，123 页有「-」「.」）。
 * 其它平台（Android Gboard 的 decimal 键盘带「-」、桌面端无软键盘）保留 `decimal`。
 */
export function numericInputMode(nav: NavigatorLike | undefined = currentNavigator()): 'decimal' | 'text' {
  return isIosTouchDevice(nav) ? 'text' : 'decimal';
}
