/**
 * 跨标签页写冲突检测(盲审 P2)。
 *
 * 本应用以 Web/PWA 形态部署(已安装的 PWA 窗口 + 浏览器标签共享同源 localStorage),
 * 但此前全仓**零** `storage` 监听:标签 A 只要改一个无关字段,订阅器就会用自己内存里
 * 的旧值把标签 B 刚写入的整个键覆盖掉,且没有任何提示。受害的是三份责任数据——
 * AQL 转移账本(最多 1000 条批次追溯记录,`aqlSwitch.ts` 自述「绝不静默删除旧批次
 * 追溯记录」)、最近数据集列表、已保存分析记录。
 *
 * 处理方式不是「弹个警告了事」,而是**外部写入发生时立刻把该键重新水合进内存**,
 * 让本地后续修改叠加在别的标签页的最新值之上——常见场景(两个标签改不同字段)因此
 * 真正做到不丢数据;同时给一次提示,让用户知道数据来自另一窗口。
 */

/** 外部(其它标签页)写入某个键时的回调。 */
type ExternalWriteHandler = (key: string) => void;

const handlers = new Map<string, ExternalWriteHandler>();
/** 本标签页自己刚写过的键:用于区分「自己的写」与「别人的写」。 */
const localWrites = new Map<string, string | null>();
let installed = false;

/** 本标签页写入后登记,避免把自己的写当成外部写(某些浏览器会回投事件)。 */
export function markLocalWrite(key: string, value: string | null): void {
  localWrites.set(key, value);
}

/**
 * 注册某个存储键的外部写入处理器。重复注册同一键会覆盖(热重载/严格模式双执行安全)。
 * 返回注销函数。
 */
export function watchExternalWrite(key: string, handler: ExternalWriteHandler): () => void {
  handlers.set(key, handler);
  installStorageListener();
  return () => { handlers.delete(key); };
}

function installStorageListener(): void {
  if (installed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  installed = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    // 只关心本源 localStorage 上被监听的键
    if (event.storageArea != null && event.storageArea !== window.localStorage) return;
    const key = event.key;
    if (key == null) return; // localStorage.clear() 触发的整体事件,不做逐键处理
    const handler = handlers.get(key);
    if (!handler) return;
    // 与本标签页最后一次写入完全相同 → 是自己的写被回投,忽略
    if (localWrites.has(key) && localWrites.get(key) === event.newValue) return;
    handler(key);
  });
}

/** 仅供测试:重置模块状态。 */
export function __resetCrossTabForTests(): void {
  handlers.clear();
  localWrites.clear();
}
