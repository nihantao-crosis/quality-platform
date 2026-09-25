/**
 * fix2609n · G24c-store C1(第 7 批复审 P3):导出前对「已登记写保护」的损坏键一律按 saveJson/saveFishboneState
 * 同一口径重试隔离——不管内存里有没有未落盘载荷(dirty)。
 * - 隔离区写不下 → 仍 fail-closed,文案让用户释放空间;
 * - 用户照文案释放空间后重试导出 → 放行,且导出的是内存里未落盘的最新编辑(不丢编辑);
 * - live 已被另一窗口修正/清除 → 保护解除,导出放行(即使隔离区仍写不下)。
 * 复现参考:fix-batch7/reviewG/reviewG_G23a-store/a3_lazy.test.ts「鱼骨图 dirty」「规格限」。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const QUARANTINE = 'qp-quarantine-v1';
const FISHBONE = 'qp-fishbone-v1';
const SPECS = 'qp-specs-v1';
const nativeSetItem = Storage.prototype.setItem;
let failQuarantine = false;
let failKey: string | null = null;

beforeEach(() => {
  localStorage.clear();
  failQuarantine = false;
  failKey = null;
  vi.resetModules();
  Storage.prototype.setItem = function limited(this: Storage, key: string, value: string) {
    if (failQuarantine && key.startsWith(QUARANTINE)) throw new DOMException('quota', 'QuotaExceededError');
    if (failKey !== null && key === failKey) throw new DOMException('quota', 'QuotaExceededError');
    nativeSetItem.call(this, key, value);
  };
});

afterEach(() => {
  Storage.prototype.setItem = nativeSetItem;
  localStorage.clear();
  vi.resetModules();
});

async function boot() {
  const adapter = await import('../../platform/adapter');
  adapter.platform.datasetDb = null;
  const project = await import('../../platform/project');
  const ds = await import('../../store/dataStore');
  await import('../../store/analyses');
  const fb = await import('../../store/fishboneStore');
  return { project, ds, fb };
}

type ProjectModule = typeof import('../../platform/project');

async function exportStores(project: ProjectModule): Promise<Record<string, string>> {
  return (JSON.parse(await project.buildProjectJsonFull('t')) as { stores: Record<string, string> }).stores;
}

const EDITED_PROBLEM = '孔径偏大(未落盘编辑)';

describe('C1 鱼骨图：已登记写保护 + 内存未落盘编辑', () => {
  it('隔离区写不下 → 拒绝；释放空间后重试导出放行，导出内存编辑，损坏原文进隔离区', async () => {
    const corrupt = '{"data":1}';
    localStorage.setItem(FISHBONE, corrupt);
    const { project, fb } = await boot();
    failQuarantine = true;
    fb.loadFishboneState(); // 进入鱼骨图页：读取侧隔离失败 → 登记写保护
    const edited = fb.cloneFishbone(fb.FISHBONE_DEFAULT);
    edited.problem = EDITED_PROBLEM;
    expect(() => fb.saveFishboneState(edited, false)).toThrow(/尚未成功隔离/); // 写入被拒 → dirty
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(project.STORAGE_SPACE_RELEASE_HINT);

    failQuarantine = false; // 用户按文案释放了空间
    const stores = await exportStores(project);
    const exported = JSON.parse(stores[FISHBONE]) as { data: { problem: string }; isDemo: boolean };
    expect(exported.data.problem).toBe(EDITED_PROBLEM);
    expect(exported.isDemo).toBe(false);
    expect((JSON.parse(stores[QUARANTINE]) as Record<string, { raw: string }>)[FISHBONE].raw).toBe(corrupt);
    // 内存编辑仍可见，保护已解除后下一次保存可正常落盘
    expect(fb.loadFishboneState().data.problem).toBe(EDITED_PROBLEM);
    fb.saveFishboneState(edited, false);
    expect(JSON.parse(localStorage.getItem(FISHBONE)!).data.problem).toBe(EDITED_PROBLEM);
  });

  it('live 被另一窗口修正为合法值 → 保护解除，导出放行(隔离区仍写不下也无关)', async () => {
    localStorage.setItem(FISHBONE, '{"data":');
    const { project, fb } = await boot();
    failQuarantine = true;
    fb.loadFishboneState();
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(/鱼骨图/);
    const fixed = fb.cloneFishbone(fb.FISHBONE_DEFAULT);
    fixed.problem = '另一窗口修正';
    const fixedRaw = JSON.stringify({ data: fixed, isDemo: false });
    nativeSetItem.call(localStorage, FISHBONE, fixedRaw);
    const stores = await exportStores(project);
    expect(stores[FISHBONE]).toBe(fixedRaw);
  });

  it('live 被另一窗口清除 → 保护解除，导出放行', async () => {
    localStorage.setItem(FISHBONE, '{"data":1}');
    const { project, fb } = await boot();
    failQuarantine = true;
    fb.loadFishboneState();
    localStorage.removeItem(FISHBONE);
    const stores = await exportStores(project);
    expect(stores[FISHBONE]).toBeUndefined();
  });

  it('对照：live 仍是同一损坏原文且隔离区仍写不下 → 继续 fail-closed，原文不被改写', async () => {
    const corrupt = '{"data":1}';
    localStorage.setItem(FISHBONE, corrupt);
    const { project, fb } = await boot();
    failQuarantine = true;
    fb.loadFishboneState();
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(project.STORAGE_SPACE_RELEASE_HINT);
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(project.STORAGE_SPACE_RELEASE_HINT);
    expect(localStorage.getItem(FISHBONE)).toBe(corrupt);
  });
});

describe('C1 规格限：已登记写保护 + 内存未落盘载荷', () => {
  it('隔离区写不下 → 拒绝；释放空间后重试导出放行，导出内存载荷', async () => {
    const { project, ds } = await boot();
    failKey = SPECS;
    ds.rememberSpecFor('X', { lsl: 1, tgt: 2, usl: 3 }); // 规格限写不下 → dirty
    failKey = null;
    const corrupt = '{"a":';
    nativeSetItem.call(localStorage, SPECS, corrupt); // 另一窗口/中断写入污染 live
    failQuarantine = true;
    ds.rememberSpecFor('Y', { lsl: 4, tgt: 5, usl: 6 }); // 读取侧触达 → 隔离失败 → 登记写保护
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(project.STORAGE_SPACE_RELEASE_HINT);

    failQuarantine = false;
    const stores = await exportStores(project);
    const specs = JSON.parse(stores[SPECS]) as Record<string, { lsl: number }>;
    expect(specs.X).toEqual({ lsl: 1, tgt: 2, usl: 3 });
    expect((JSON.parse(stores[QUARANTINE]) as Record<string, { raw: string }>)[SPECS].raw).toBe(corrupt);
    expect(localStorage.getItem(SPECS)).toBe(corrupt); // 导出本身不改写 live
  });

  it('无 dirty:live 被另一窗口修正为合法值 → 保护解除，导出放行(隔离区仍写不下)', async () => {
    const { project, ds } = await boot();
    nativeSetItem.call(localStorage, SPECS, '{"a":{"lsl":"q"}}');
    failQuarantine = true;
    ds.rememberSpecFor('Y', { lsl: 4, tgt: 5, usl: 6 }); // 读取侧触达 → 隔离失败 → 登记写保护(写入被拒，无 dirty)
    await expect(project.buildProjectJsonFull('t')).rejects.toThrow(/qp-specs-v1/);
    const fixedRaw = JSON.stringify({ a: { lsl: 1, tgt: 2, usl: 3 } });
    nativeSetItem.call(localStorage, SPECS, fixedRaw);
    const stores = await exportStores(project);
    expect(stores[SPECS]).toBe(fixedRaw);
  });

  it('dirty + 保护:live 被另一窗口清除 → 保护解除，导出内存载荷', async () => {
    const { project, ds } = await boot();
    failKey = SPECS;
    ds.rememberSpecFor('X', { lsl: 1, tgt: 2, usl: 3 });
    failKey = null;
    nativeSetItem.call(localStorage, SPECS, '{"a":');
    failQuarantine = true;
    ds.rememberSpecFor('Y', { lsl: 4, tgt: 5, usl: 6 });
    localStorage.removeItem(SPECS);
    const stores = await exportStores(project);
    expect((JSON.parse(stores[SPECS]) as Record<string, unknown>).X).toBeDefined();
  });
});
