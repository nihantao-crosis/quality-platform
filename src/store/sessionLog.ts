/**
 * 会话窗口 — Minitab 式分析日志（编辑器菜单「显示会话窗口」）。
 * 记录导入/导出/运行/MES/数据集切换等关键事件,会话级不落盘。
 */
import { create } from 'zustand';

const MAX_ENTRIES = 200;

interface SessionLogState {
  entries: string[];
  visible: boolean;
  log(text: string): void;
  clear(): void;
  toggle(): void;
}

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export const useSessionLog = create<SessionLogState>((set) => ({
  entries: [`[${stamp()}] 会话开始 · 质量分析平台`],
  visible: false,
  log: (text) =>
    set((s) => ({ entries: [...s.entries.slice(-(MAX_ENTRIES - 1)), `[${stamp()}] ${text}`] })),
  clear: () => set({ entries: [`[${stamp()}] 日志已清空`] }),
  toggle: () => set((s) => ({ visible: !s.visible })),
}));

/** 非组件上下文的便捷入口（stores/平台层调用） */
export function sessionLog(text: string) {
  useSessionLog.getState().log(text);
}
