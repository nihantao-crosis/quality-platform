/** 损坏 localStorage 原文的统一隔离区；项目 v2 会连同隔离证据一起导出。 */
import { projectStoreValidationError, QUARANTINE_STORAGE_KEY } from '../platform/project';
import { sessionLog } from './sessionLog';

export { QUARANTINE_STORAGE_KEY };

interface QuarantineEntry { raw: string; detail: string; detectedAt: string }
type QuarantineMap = Record<string, QuarantineEntry>;

/** 成功保存原始文本返回 true；配额/权限失败时保持 live key 不动并返回 false。 */
export function preserveCorruptStore(key: string, raw: string, detail: string): boolean {
  try {
    let map: QuarantineMap = {};
    const existing = localStorage.getItem(QUARANTINE_STORAGE_KEY);
    if (existing) {
      const parsed = ((): unknown => { try { return JSON.parse(existing); } catch { return null; } })();
      if (parsed !== null && projectStoreValidationError(QUARANTINE_STORAGE_KEY, parsed) === null) {
        map = parsed as QuarantineMap;
      } else {
        // 第三轮 P3:隔离区自身损坏时不得以空表覆盖(会销毁其余 key 的全部旧证据)——
        // 先整体移开存证到「墓地键」。
        // 墓地策略 = **保留首份证据**,与本文件其它分支一致(二次损坏保首份 raw、
        // 新原文另存 latestRaw)。自审 P3:此前是「只留最新一份」,第二次损坏会删掉
        // 最早也最完整的那份证据,与「首份最接近损坏前状态」的原则正相反。
        const existingGrave = (() => {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(`${QUARANTINE_STORAGE_KEY}.corrupt-`)) return k;
          }
          return null;
        })();
        const graveKey = `${QUARANTINE_STORAGE_KEY}.corrupt-${Date.now()}`;
        let wrote = existingGrave !== null; // 首份墓地已在 → 视为「证据已保住」,不覆盖
        if (!wrote) {
          try {
            localStorage.setItem(graveKey, existing);
            wrote = true;
          } catch { /* 空间不足:没有任何墓地可依,下面会拒绝继续 */ }
        }
        if (!wrote) {
          // 自审 P1:墓地写入失败(配额满)时**绝不能继续**——下面的 setItem 会用新 map
          // 覆盖 live 隔离区,把这份唯一的旧证据彻底销毁,而且还会返回 true 让调用方
          // 撤掉写保护。宁可本次不存证,也不能销毁已有证据。
          sessionLog(`隔离区已损坏且存储空间不足,无法转存证据;为免销毁旧证据,本次不写入 · ${detail}`);
          return false;
        }
      }
    }
    if (!map[key]) {
      const next = { ...map, [key]: { raw, detail, detectedAt: new Date().toISOString() } };
      // 写入前自检(闭环审核 P3):隔离区自身必须始终通过项目校验器,否则
      // 一个非白名单 key 就会让 .qproj 导出被整体阻断
      if (projectStoreValidationError(QUARANTINE_STORAGE_KEY, next) !== null) {
        // 自审 P2:这里**不能返回 false**——调用方 dataStore.quarantineCorruptStore 会据此
        // 把该 key 永久挂进 protectedCorruptStores,saveJson 从此对它恒失败,而弹出的提示
        // 还错报成「存储已满」。非白名单 key 本就不属于项目持久化范围(不会被 .qproj 导出、
        // 也不该阻断写入),记日志跳过存证即可,返回 true 表示「不必为它设写保护」。
        sessionLog(`隔离区不接受 key ${key}(不在项目白名单),已跳过存证但不阻断写入 · ${detail}`);
        return true;
      }
      map = next;
      localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(map));
    } else if (map[key].raw !== raw) {
      // 同一 key 二次损坏(内容不同):首份证据最接近损坏前状态,不能被后续残片顶掉,
      // 只记日志。**仍返回 true**——本函数返回值的语义是「该 key 的损坏证据是否已安全
      // 保存」,不是「本次原文是否写入」;调用方 dataStore.quarantineCorruptStore 用它
      // 决定能否覆盖 live 值,只要首份证据在,覆盖就是安全的。
      // 自审 P1(此处两轮审查间反复过,勿再改):返回 false 会让 protectedCorruptStores
      // 永远清不掉 → saveJson 对该 key 永久 return false,持久化通道与 .qproj 导出被
      // 锁死,且弹出的提示把原因错报成「存储已满」。
      // 自审:首份证据保留的同时,**最新原文也要留存**——此前直接丢弃,跨损坏事件的
      // 新证据 100% 丢失。项目校验器只校验 raw/detail/detectedAt 的类型、不拒绝额外字段。
      const merged = {
        ...map,
        [key]: { ...map[key], latestRaw: raw, latestDetail: detail, latestDetectedAt: new Date().toISOString() },
      };
      if (projectStoreValidationError(QUARANTINE_STORAGE_KEY, merged) === null) {
        map = merged;
        localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(map));
      }
      sessionLog(`隔离区已存有 ${key} 的首份损坏证据(最接近损坏前状态),本次新原文另存为 latestRaw · ${detail}`);
    }
    // 同一 key 再次损坏:保留首份证据(最接近损坏前状态),后续原文只记日志——
    // 双审 P1:此前写入 `${key}#latest` 新键会被项目校验器整体拒绝,
    // 「数据已损坏、最需要备份时」反而永久阻断 .qproj 导出,第三次事件还会把
    // 含首份证据的整表移进墓地键。隔离区结构必须始终通过自家校验器。
    sessionLog(`已隔离损坏的本地存储 ${key} · ${detail}`);
    return true;
  } catch {
    sessionLog(`损坏的本地存储 ${key} 隔离失败（可能空间不足）· ${detail}`);
    return false;
  }
}
