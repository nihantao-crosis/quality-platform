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
  /** 'change':每次合法输入即时生效(实时重算);'blur':失焦/回车才生效。 */
  commitOn?: 'change' | 'blur';
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
  value, onCommit, label, commitOn = 'change', allowEmpty = false, integer, validate,
  disabled, placeholder, title, className, style, messageWidth = 260,
}: StrictNumberInputProps) {
  const [draft, setDraft] = useState<{ text: string; base: number | null } | null>(null);
  const active = draft != null && Object.is(draft.base, value) ? draft : null;
  const text = active ? active.text : shownValue(value);
  const check = active ? checkStrictNumber(active.text, { integer, validate }) : null;
  const emptyAccepted = check != null && !check.ok && check.empty && allowEmpty;
  const problem = check && !check.ok && !emptyAccepted
    ? `${label}${check.empty ? '未填写' : `无效：${check.reason}`}；${value == null ? '当前未生效' : `仍按上一次有效值 ${shownValue(value)}`}`
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
        onChange={(e) => {
          const next = e.target.value;
          if (commitOn === 'change') {
            const committed = commitText(next);
            // 生效后以新值为基准保留原串(继续编辑不跳字);store 规范化成别的值时草稿自动作废
            setDraft({ text: next, base: committed === undefined ? value : committed });
          } else {
            setDraft({ text: next, base: value });
          }
        }}
        onBlur={() => {
          if (!active) return;
          if (commitOn === 'blur') {
            const committed = commitText(active.text);
            if (committed !== undefined) setDraft(null);
            return;
          }
          // 合法(或允许的空)在失焦时回到规范显示;非法保留原串与原因
          if (check?.ok || emptyAccepted) setDraft(null);
        }}
        onKeyDown={(e) => { if (commitOn === 'blur' && e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
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
