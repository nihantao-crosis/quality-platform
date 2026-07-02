/**
 * PlatformAdapter — 平台能力抽象（交接文档 §4.2）。
 * Web 与桌面（Tauri）各自实现导入/导出，UI 与 core 不感知运行端。
 */
import type { ExportFmt } from '../store/appStore';

export interface PlatformAdapter {
  /** 是否为桌面端（Tauri 壳） */
  isDesktop: boolean;
  /**
   * 导出报表。返回落盘路径（桌面）或下载文件名（Web）；用户取消返回 null。
   */
  exportReport(fmt: ExportFmt, defaultName: string, contents: string): Promise<string | null>;
  /**
   * 打开数据文件选择对话框。返回选中文件名与文本内容；取消返回 null。
   */
  pickImportFile(): Promise<{ name: string; contents: string } | null>;
}

const EXT: Record<ExportFmt, { ext: string; label: string }> = {
  pdf: { ext: 'txt', label: '文本报告 (生产版接 PDF 渲染器)' },
  excel: { ext: 'csv', label: 'CSV 数据表' },
  ppt: { ext: 'txt', label: '文本报告 (生产版接 PPT 生成器)' },
  word: { ext: 'txt', label: '文本报告 (生产版接 Word 生成器)' },
};

export function exportExt(fmt: ExportFmt): string {
  return EXT[fmt].ext;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------- Web 实现：blob 下载 ----------
const webAdapter: PlatformAdapter = {
  isDesktop: false,
  async exportReport(fmt, defaultName, contents) {
    const name = `${defaultName}.${EXT[fmt].ext}`;
    const blob = new Blob(['﻿' + contents], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return name;
  },
  async pickImportFile() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.csv,.txt';
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return resolve(null);
        resolve({ name: f.name, contents: await f.text() });
      };
      // 取消事件（部分浏览器支持）
      inp.oncancel = () => resolve(null);
      inp.click();
    });
  },
};

// ---------- 桌面实现：原生对话框 + Rust 命令落盘 ----------
const desktopAdapter: PlatformAdapter = {
  isDesktop: true,
  async exportReport(fmt, defaultName, contents) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const ext = EXT[fmt].ext;
    const path = await save({
      title: '导出报表',
      defaultPath: `${defaultName}.${ext}`,
      filters: [{ name: EXT[fmt].label, extensions: [ext] }],
    });
    if (!path) return null;
    await invoke('save_text_file', { path, contents: '﻿' + contents });
    return path;
  },
  async pickImportFile() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await open({
      title: '导入数据',
      multiple: false,
      filters: [{ name: 'CSV / 文本数据', extensions: ['csv', 'txt'] }],
    });
    if (!path || Array.isArray(path)) return null;
    const contents = await invoke<string>('read_text_file', { path });
    const name = path.split(/[\\/]/).pop() ?? path;
    return { name, contents };
  },
};

export const platform: PlatformAdapter = isTauri() ? desktopAdapter : webAdapter;
