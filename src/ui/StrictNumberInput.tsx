/**
 * 与 store 绑定的手工数值参数框(fix2609l G22a,GAP-8-4 同族收口)。
 *
 * 此前 MSA 过程公差、能力分析规格限/子组大小、SPC 判异 K 值仍是浏览器数字框(type=number):
 * Chromium 下「12.5mm」被过滤成空串或截断,受控 number 框清空时回弹旧值,子组大小「3.6」被
 * Math.round 静默改成 4,K 值越界被 normalizeRuleK 静默回落标准值——用户看不到任何原因。
 * 这里统一:type=text + numericInputMode(iOS 用全键盘)+ parseStrictNumber/parseStrictInteger
 * 严格解析原始串;非法时保留原串、标红并就地显示中文原因,store 仍按上一次有效值,并如实告知。
 *
 * 草稿以「编辑时的 store 值」为基准:store 值被其它入口改变(复位、换列、回看)时草稿自动作废,
 * 输入框回到 store 的真实值,不会出现框内旧草稿与实际生效值不一致。
 *
 * fix2609m G23c C1(G13 复审 P2):commitOn='change' 时逐键输入会经过一串合法前缀——打「1,000」先经过
 * 「1」、打「12.5mm」先经过「12.5」。此前每个合法前缀即时写入 store 并持久化,串变非法后 store 停在前缀上,
 * 失焦/切页后草稿丢失,框内显示前缀且无任何告警。现在一次编辑会话(草稿生效期间)开始时记下 store 快照;
 * 合法整串仍实时生效,当前串一旦非法(且不是 allowEmpty 的空),立即把 store 回退到快照,告警写明
 * 「未修改,仍按编辑前的值」。store 因此任何时刻都只会是「编辑前的值」或「框内完整合法串的值」,
 * 失焦、回车、切页签/卸载都不会残留前缀,卸载时无需再补写 store(也就不会误伤卸载期间别处写入的新值)。
 */
import { useState, type CSSProperties } from 'react';
import { numericInputMode, parseStrictInteger, parseStrictNumber, type StrictNumberResult } from '../core/numberInput';

export interface StrictNumberInputProps {
  /** store 中当前生效的值;null=未设置(空框)。 */
  value: number | null;
  /** 合法输入写入 store。allowEmpty 时清空写入 null。 */
  onCommit: (value: number | null) => void;
  /** 无障碍名称,同时作为原因提示的主语。 */
  label: string;
  /** 'change':每次合法输入即时生效(实时重算),串变非法时回退到编辑前的值;'blur':失焦/回车才生效。 */
  commitOn?: 'change' | 'blur';
  /**
   * commitOn='change' 的编辑会话快照:会话开始时调用,返回的函数用于把 store 回退到会话开始时的状态。
   * 默认快照 = 当时的 value、回退 = onCommit(快照)。value 由派生值给出(如 μ₀ = t1Mu0 ?? 目标值)时,
   * 调用方应快照原始字段,避免回退把「跟随」语义(null)钉成固定数。
   */
  captureRevert?: () => () => void;
  /** 允许清空(写入 null)。 */
  allowEmpty?: boolean;
  /** 整数参数:按 parseStrictInteger 解析并校验闭区间;inputMode 用数字键盘。 */
  integer?: { min?: number; max?: number };
  /** 业务域校验(如宽度 > 0、K 值范围);返回中文原因即拒绝。 */
  validate?: (value: number) => string | null;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** 原因/说明文字的最大宽度(窄参数框旁避免撑破布局)。 */
  messageWidth?: number;
}

const INVALID_BORDER = '#c22f2f';

/** 编辑草稿:text=框内原串;base=草稿对应的 store 值(不一致即作废);origin/revert=本次编辑会话开始时的
 * store 值与回退函数;dirty=本会话是否已把某个合法串写进 store(串变非法时据此回退)。 */
interface Draft {
  text: string;
  base: number | null;
  origin: number | null;
  revert: (() => void) | null;
  dirty: boolean;
}

function shownValue(value: number | null): string {
  return value == null ? '' : String(value);
}

/** 严格解析 + 业务校验;供组件与调用方(如生成前的最终核对)共用同一口径。 */
export function checkStrictNumber(
  text: string,
  options: Pick<StrictNumberInputProps, 'integer' | 'validate'> = {},
): StrictNumberResult {
  const parsed = options.integer ? parseStrictInteger(text, options.integer) : parseStrictNumber(text);
  if (!parsed.ok) return parsed;
  const domain = options.validate?.(parsed.value) ?? null;
  return domain ? { ok: false, empty: false, reason: domain } : parsed;
}

export function StrictNumberInput({
  value, onCommit, label, commitOn = 'change', captureRevert, allowEmpty = false, integer, validate,
  disabled, placeholder, title, className, style, messageWidth = 260,
}: StrictNumberInputProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = draft != null && Object.is(draft.base, value) ? draft : null;
  const text = active ? active.text : shownValue(value);
  const check = active ? checkStrictNumber(active.text, { integer, validate }) : null;
  const emptyAccepted = check != null && !check.ok && check.empty && allowEmpty;
  // commitOn='change' 下串非法时 store 已回退到编辑前的值;'blur' 下 store 本就未动——两者都是「未修改」
  const problem = check && !check.ok && !emptyAccepted
    ? `${label}${check.empty ? '未填写' : `无效：${check.reason}`}；未修改，${value == null ? '当前未生效' : `仍按编辑前的值 ${shownValue(value)}`}`
    : null;
  const note = check?.ok ? check.note ?? null : null;

  const commitText = (next: string) => {
    const result = checkStrictNumber(next, { integer, validate });
    if (result.ok) {
      onCommit(result.value);
      return result.value;
    }
    if (result.empty && allowEmpty) {
      onCommit(null);
      return null;
    }
    return undefined;
  };

  const handleChange = (next: string) => {
    if (commitOn === 'blur') {
      setDraft({ text: next, base: value, origin: value, revert: null, dirty: false });
      return;
    }
    // 新会话:记下编辑开始时的 store 快照(草稿因外部改值作废后重新开始,也以当时的真实值为准)
    const session = active ?? {
      origin: value,
      revert: captureRevert ? captureRevert() : () => onCommit(value),
      dirty: false,
    };
    const committed = commitText(next);
    if (committed !== undefined) {
      // 生效后以新值为基准保留原串(继续编辑不跳字);store 规范化成别的值时草稿自动作废
      setDraft({ text: next, base: committed, origin: session.origin, revert: session.revert, dirty: true });
      return;
    }
    // 当前串非法:本会话写入过前缀就回退到编辑前的值,不让前缀留在 store 里
    if (session.dirty) session.revert?.();
    setDraft({ text: next, base: session.dirty ? session.origin : value, origin: session.origin, revert: session.revert, dirty: false });
  };

  const finish = () => {
    if (!active) return;
    if (commitOn === 'blur') {
      const committed = commitText(active.text);
      if (committed !== undefined) setDraft(null);
      return;
    }
    // 合法(或允许的空)在失焦时回到规范显示;非法保留原串与原因(store 已是编辑前的值)
    if (check?.ok || emptyAccepted) setDraft(null);
  };

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <input
        type="text"
        inputMode={integer ? 'numeric' : numericInputMode()}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        title={problem ?? title}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        value={text}
        style={{ ...style, ...(problem ? { borderColor: INVALID_BORDER } : {}) }}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {problem && (
        <span role="alert" style={{ color: INVALID_BORDER, fontSize: 11, lineHeight: 1.45, maxWidth: messageWidth, whiteSpace: 'normal' }}>{problem}</span>
      )}
      {note && (
        <span role="status" style={{ color: '#8a929d', fontSize: 11, lineHeight: 1.45, maxWidth: messageWidth, whiteSpace: 'normal' }}>{note}</span>
      )}
    </span>
  );
}
