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
  /** 桌面端 SQLite 数据集库快照(name → 数据集 JSON)。可选,旧版本读取时忽略。 */
  vault?: Record<string, string>;
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

/** 完整导出:桌面端把 SQLite 数据集库一并嵌入(排除最近列表里已带全量数据的,避免双份)。 */
export async function buildProjectJsonFull(appVersion: string): Promise<string> {
  const base = JSON.parse(buildProjectJson(appVersion)) as ProjectFile;
  const db = platform.datasetDb;
  if (db) {
    try {
      // 最近列表中已随 stores 携带完整数据的数据集,不再重复嵌入
      const inRecents = new Set<string>();
      try {
        const recents = JSON.parse(base.stores['qp-recents-v1'] ?? '[]') as Array<{ name: string; data?: unknown }>;
        for (const r of recents) if (r.data != null) inRecents.add(r.name);
      } catch { /* 解析失败按全部嵌入处理 */ }
      const vault: Record<string, string> = {};
      for (const meta of await db.list()) {
        if (inRecents.has(meta.name)) continue;
        const json = await db.get(meta.name);
        if (json != null) vault[meta.name] = json;
      }
      if (Object.keys(vault).length > 0) base.vault = vault;
    } catch { /* 库读取失败不阻断导出,仍出 stores 部分 */ }
  }
  return JSON.stringify(base, null, 2);
}

/** 导出项目文件（原生保存对话框 / 浏览器下载）。projectName 用作默认文件名。 */
export async function exportProject(appVersion: string, projectName = '质检项目'): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '_').trim() || '质检项目';
  return platform.exportFile({
    defaultName: `${safe}_${stamp}`,
    ext: 'qproj',
    filterLabel: '质量分析平台项目',
    text: await buildProjectJsonFull(appVersion),
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

/** 完整导入:stores 写回 localStorage;文件带 vault 且本端为桌面时,把库数据集恢复进 SQLite。
 * 返回 { error, note }:error 非空即失败;note 为补充提示(恢复个数 / Web 端跳过)。 */
export async function applyProjectText(text: string): Promise<{ error: string | null; note?: string }> {
  const err = applyProjectJson(text);
  if (err) return { error: err };
  let vault: Record<string, string> | undefined;
  try {
    vault = (JSON.parse(text.replace(/^\uFEFF/, '')) as ProjectFile).vault;
  } catch { /* applyProjectJson 已通过,不会走到这 */ }
  if (!vault || Object.keys(vault).length === 0) return { error: null };
  const db = platform.datasetDb;
  if (!db) {
    return { error: null, note: `项目内含 ${Object.keys(vault).length} 个库数据集,仅桌面版可恢复,本次已跳过` };
  }
  let ok = 0;
  for (const [name, json] of Object.entries(vault)) {
    try {
      JSON.parse(json); // 防注入:必须是合法 JSON 才入库
      await db.put(name, json);
      ok++;
    } catch { /* 单个损坏跳过 */ }
  }
  return { error: null, note: `已恢复 ${ok} 个数据集到本机数据集库` };
}
