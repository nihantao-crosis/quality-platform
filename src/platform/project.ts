/**
 * 项目文件 (.qproj) — 单机数据的完整备份与迁移。
 * 导出:全部 qp-* 本地存储打包为单个 JSON 文件;
 * 导入:白名单校验后写回并重载,另一台机器打开即完整恢复。
 */
import { platform } from './adapter';

/** 允许进出项目文件的存储键（白名单,防止导入任意 localStorage 注入） */
export const PROJECT_KEYS = [
  'qp-dataset-v1',
  'qp-recents-v1',
  'qp-attr-v1',
  'qp-specs-v1',
  'qp-fishbone-v1',
  'qp-analyses-v1',
  'qp-prefs-v1',
] as const;

const FORMAT = 'quality-platform-project';
const FORMAT_VERSION = 1;

interface ProjectFile {
  format: typeof FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  stores: Record<string, string>;
}

export function buildProjectJson(appVersion: string): string {
  const stores: Record<string, string> = {};
  for (const k of PROJECT_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) stores[k] = v;
    } catch { /* 忽略 */ }
  }
  const file: ProjectFile = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    stores,
  };
  return JSON.stringify(file, null, 2);
}

/** 导出项目文件（原生保存对话框 / 浏览器下载）。projectName 用作默认文件名。 */
export async function exportProject(appVersion: string, projectName = '质检项目'): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '_').trim() || '质检项目';
  return platform.exportFile({
    defaultName: `${safe}_${stamp}`,
    ext: 'qproj',
    filterLabel: '质量分析平台项目',
    text: buildProjectJson(appVersion),
  });
}

/** 校验并应用项目文件;成功返回 null,失败返回错误信息。应用后需整页重载。 */
export function applyProjectJson(text: string): string | null {
  let file: ProjectFile;
  try {
    file = JSON.parse(text.replace(/^\uFEFF/, '')); // 去 BOM（导出文本统一带 BOM）
  } catch {
    return '不是有效的项目文件（JSON 解析失败）';
  }
  if (file?.format !== FORMAT) return '不是质量分析平台的项目文件';
  if (typeof file.formatVersion !== 'number' || file.formatVersion > FORMAT_VERSION) {
    return `项目文件版本 ${file.formatVersion} 高于当前应用支持的 ${FORMAT_VERSION},请升级应用`;
  }
  if (!file.stores || typeof file.stores !== 'object') return '项目文件缺少数据';
  // 每个值必须是合法 JSON（存储层约定）
  for (const [k, v] of Object.entries(file.stores)) {
    if (!(PROJECT_KEYS as readonly string[]).includes(k)) continue; // 忽略未知键
    try {
      JSON.parse(v);
    } catch {
      return `项目数据「${k}」损坏`;
    }
  }
  try {
    for (const k of PROJECT_KEYS) {
      const v = file.stores[k];
      if (v != null) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    }
  } catch {
    return '写入本地存储失败（可能空间不足）';
  }
  return null;
}

export function isProjectFile(name: string): boolean {
  return /\.qproj$/i.test(name);
}
