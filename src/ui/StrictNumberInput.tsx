/**
 * 与 store 绑定的手工数值参数框(fix2609l G22a,GAP-8-4 同族收口)。
 *
 * 此前 MSA 过程公差、能力分析规格限/子组大小、SPC 判异 K 值仍是浏览器数字框(type=number):
 * Chromium 下「12.5mm」被过滤成空串或截断,受控 number 框清空时回弹旧值,子组大小「3.6」被
 * Math.round 静默改成 4,K 值越界被 normalizeRuleK 静默回落标准值——用户看不到任何原因。
 * 这里统一:type=text + numericInputMode(iOS 用全键盘)+ parseStrictNumber/parseStrictInteger
 * 严格解析原始串;非法时保留原串、标红并就地显示中文原因;commitOn='change' 下终串非法回退到编辑前的值
 * (fix2609m C1,见下),'blur' 下 store 本就未动,两者都如实告知「未修改」。
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
 *
 * fix2609n G24b B3(第 7 批复审 P3):回退前先经 readValue 读 store 实时值,核对它仍是本会话最后一次提交的值;
 * 不相等(外部写入已落地、本组件尚未重渲染)就放弃回退并结束会话,不用会话起点的旧快照覆盖别处的写入。
 * 注意:外部写入「恰好等于」已提交前缀的值时仍无法区分(需要 store 侧修订号),回退照常发生。
 * 调用方快照不止一个字段时(如能力规格限连同 1000σ 强警告确认)用 captureRevert 一并恢复。
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
  /**
   * 读 store 实时值(不经 React 渲染)。commitOn='change' 回退前据此核对 store 仍是本会话最后一次提交的值,
   * 不是则放弃回退、结束会话(fix2609n G24b B3)。缺省按最近一次渲染的 value 核对。
   */
  readValue?: () => number | null;
  /** 自定义非法/未填写时的就地说明(沿用各入口既有提示口径);current=当前生效值。缺省为统一口径。 */
  formatProblem?: (problem: { reason: string; empty: boolean; current: number | null }) => string;
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

/** commitOn='change' 的编辑会话:origin/revert=会话开始时的 store 值与回退函数;dirty=本会话是否已把某个
 * 合法串写进 store(串变非法时据此回退);committed=本会话最后一次写入 store 的值(回退前核对用)。 */
interface Session {
  origin: number | null;
  revert: () => void;
  dirty: boolean;
  committed: number | null;
}

/** 编辑草稿:text=框内原串;base=草稿对应的 store 值(不一致即作废);session=进行中的编辑会话
 * (null=无会话:'blur' 模式,或会话因外部写入被放弃,下一键重新开始)。 */
interface Draft {
  text: string;
  base: number | null;
  session: Session | null;
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
  value, onCommit, label, commitOn = 'change', captureRevert, readValue, formatProblem, allowEmpty = false, integer, validate,
  disabled, placeholder, title, className, style, messageWidth = 260,
}: StrictNumberInputProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = draft != null && Object.is(draft.base, value) ? draft : null;
  const text = active ? active.text : shownValue(value);
  const check = active ? checkStrictNumber(active.text, { integer, validate }) : null;
  const emptyAccepted = check != null && !check.ok && check.empty && allowEmpty;
  // commitOn='change' 下串非法时 store 已回退到编辑前的值;'blur' 下 store 本就未动——两者都是「未修改」
  const problem = check && !check.ok && !emptyAccepted
    ? formatProblem
      ? formatProblem({ reason: check.reason, empty: check.empty, current: value })
      : `${label}${check.empty ? '未填写' : `无效：${check.reason}`}；未修改，${value == null ? '当前未生效' : `仍按编辑前的值 ${shownValue(value)}`}`
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
      setDraft({ text: next, base: value, session: null });
      return;
    }
    // 新会话:记下编辑开始时的 store 快照(草稿因外部改值作废或会话被放弃后重新开始,也以当时的真实值为准)
    const session: Session = active?.session ?? {
      origin: value,
      revert: captureRevert ? captureRevert() : () => onCommit(value),
      dirty: false,
      committed: value,
    };
    const committed = commitText(next);
    if (committed !== undefined) {
      // 生效后以新值为基准保留原串(继续编辑不跳字);store 规范化成别的值时草稿自动作废
      setDraft({ text: next, base: committed, session: { ...session, dirty: true, committed } });
      return;
    }
    if (!session.dirty) {
      setDraft({ text: next, base: value, session });
      return;
    }
    // 当前串非法且本会话写入过前缀:回退到编辑前的值,不让前缀留在 store 里。
    // 回退前核对 store 实时值仍是本会话最后一次提交的值——外部写入已落地时放弃回退、结束会话。
    const live = readValue ? readValue() : value;
    if (!Object.is(live, session.committed)) {
      setDraft({ text: next, base: live, session: null });
      return;
    }
    session.revert();
    setDraft({ text: next, base: session.origin, session: { ...session, dirty: false, committed: session.origin } });
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
        // 调用方的 style 用 border 简写;出错时同样覆盖简写而不是追加 borderColor 长写,否则恢复合法后 React 删掉长写会
        // 连带清掉简写里的颜色,边框回落为 currentColor(fix2609n G24e,第 8 批复审 P3)。
        style={{ ...style, ...(problem ? { border: `1px solid ${INVALID_BORDER}` } : {}) }}
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
