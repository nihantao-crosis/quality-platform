/**
 * PlatformAdapter — 平台能力抽象（交接文档 §4.2）。
 * Web 与桌面（Tauri）各自实现导入/导出，UI 与 core 不感知运行端。
 */

export interface ExportJob {
  defaultName: string; // 不含扩展名
  ext: string; // 'xlsx' | 'csv' | 'txt'
  filterLabel: string;
  text?: string; // 文本载荷（与 bytes 二选一）
  bytes?: Uint8Array; // 二进制载荷（.xlsx）
}

export interface PickedFile {
  name: string;
  contents?: string; // 文本（csv/txt）
  bytes?: Uint8Array; // 二进制（xlsx/xls）
}

export interface PlatformAdapter {
  /** 是否为桌面端（Tauri 壳） */
  isDesktop: boolean;
  /** 导出文件。返回落盘路径（桌面）或下载文件名（Web）；用户取消返回 null。 */
  exportFile(job: ExportJob): Promise<string | null>;
  /** 打开数据文件选择对话框（csv/txt 读文本,xlsx/xls 读二进制）；取消返回 null。 */
  pickImportFile(): Promise<PickedFile | null>;
}

const BINARY_EXT = /\.(xlsx|xls)$/i;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------- Web 实现：blob 下载 ----------
const webAdapter: PlatformAdapter = {
  isDesktop: false,
  async exportFile(job) {
    const name = `${job.defaultName}.${job.ext}`;
    const blob = job.bytes
      ? new Blob([job.bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' })
      : new Blob(['﻿' + (job.text ?? '')], { type: 'text/plain;charset=utf-8' });
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
      inp.accept = '.csv,.txt,.xlsx,.xls';
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return resolve(null);
        if (BINARY_EXT.test(f.name)) resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        else resolve({ name: f.name, contents: await f.text() });
      };
      inp.oncancel = () => resolve(null);
      inp.click();
    });
  },
};

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 桌面实现：原生对话框 + Rust 命令落盘 ----------
const desktopAdapter: PlatformAdapter = {
  isDesktop: true,
  async exportFile(job) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({
      title: '导出报表',
      defaultPath: `${job.defaultName}.${job.ext}`,
      filters: [{ name: job.filterLabel, extensions: [job.ext] }],
    });
    if (!path) return null;
    if (job.bytes) await invoke('save_binary_file', { path, dataB64: toBase64(job.bytes) });
    else await invoke('save_text_file', { path, contents: '﻿' + (job.text ?? '') });
    return path;
  },
  async pickImportFile() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await open({
      title: '导入数据',
      multiple: false,
      filters: [{ name: '数据文件', extensions: ['csv', 'txt', 'xlsx', 'xls'] }],
    });
    if (!path || Array.isArray(path)) return null;
    const name = path.split(/[\\/]/).pop() ?? path;
    if (BINARY_EXT.test(name)) {
      const b64 = await invoke<string>('read_binary_file', { path });
      return { name, bytes: fromBase64(b64) };
    }
    const contents = await invoke<string>('read_text_file', { path });
    return { name, contents };
  },
};

export const platform: PlatformAdapter = isTauri() ? desktopAdapter : webAdapter;
