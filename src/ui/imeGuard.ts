import type React from 'react';

/**
 * 输入法组字守卫(2026-09 审查 GAP-8-5 / GAP-8-6)。
 *
 * 中文拼音等输入法在候选面板打开(compositionstart 与 compositionend 之间)时,
 * 用户按 Enter / Esc 是给输入法的(上屏拼音、关闭候选框),浏览器仍会把这次 keydown
 * 派发给页面,且 `isComposing === true`;Safari 会在 compositionend 之后再派发一次
 * keyCode 229 的 keydown。「Enter 即提交」的文本框必须忽略这些按键,否则会把拼音
 * 组字缓冲当成列名/根因/项目名提交并关闭编辑态。
 */
export function isImeComposing(event: React.KeyboardEvent): boolean {
  const native = event.nativeEvent as KeyboardEvent | undefined;
  return native?.isComposing === true || event.keyCode === 229 || native?.keyCode === 229;
}
