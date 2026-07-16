/** 损坏 localStorage 原文的统一隔离区；项目 v2 会连同隔离证据一起导出。 */
import { projectStoreValidationError } from '../platform/project';
import { sessionLog } from './sessionLog';

export const QUARANTINE_STORAGE_KEY = 'qp-quarantine-v1';

interface QuarantineEntry { raw: string; detail: string; detectedAt: string }
type QuarantineMap = Record<string, QuarantineEntry>;

/** 成功保存原始文本返回 true；配额/权限失败时保持 live key 不动并返回 false。 */
export function preserveCorruptStore(key: string, raw: string, detail: string): boolean {
  try {
    let map: QuarantineMap = {};
    const existing = localStorage.getItem(QUARANTINE_STORAGE_KEY);
    if (existing) {
      const parsed = JSON.parse(existing) as unknown;
      if (projectStoreValidationError(QUARANTINE_STORAGE_KEY, parsed) === null) map = parsed as QuarantineMap;
    }
    if (map[key]?.raw !== raw) {
      map[key] = { raw, detail, detectedAt: new Date().toISOString() };
      localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(map));
    }
    sessionLog(`已隔离损坏的本地存储 ${key} · ${detail}`);
    return true;
  } catch {
    sessionLog(`损坏的本地存储 ${key} 隔离失败（可能空间不足）· ${detail}`);
    return false;
  }
}
