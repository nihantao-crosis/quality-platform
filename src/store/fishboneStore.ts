/** 鱼骨图数据与演示标记的单一持久化入口。 */
import { projectStoreValidationError, registerProjectLifecycleHooks, STORAGE_SPACE_RELEASE_HINT } from '../platform/project';
import { preserveCorruptStore } from './quarantine';
// dataStore 不(直接或间接)导入本模块,单向依赖无循环;探针让离开拦截/桌面关窗确认覆盖鱼骨图(STORE-10)。
import { registerUnpersistedStateProbe } from './dataStore';

export interface FishboneData {
  problem: string;
  categories: { name: string; causes: string[] }[];
}

export interface FishboneState {
  data: FishboneData;
  /** true 表示尚未由用户录入，仅显示内置示例。 */
  isDemo: boolean;
}

export const FISHBONE_STORAGE_KEY = 'qp-fishbone-v1';
let dirtyFishboneJson: string | null = null;
let protectedCorruptFishbone: { raw: string; detail: string } | null = null;

export const FISHBONE_DEFAULT: FishboneData = {
  problem: '尺寸超差',
  categories: [
    { name: '人 (Man)', causes: ['新员工操作不熟练', '对刀凭经验无标准'] },
    { name: '机 (Machine)', causes: ['刀具磨损未监控', '主轴热变形'] },
    { name: '料 (Material)', causes: ['毛坯硬度批次波动'] },
    { name: '法 (Method)', causes: ['工序卡未更新', '装夹方式不统一'] },
    { name: '环 (Environment)', causes: ['车间昼夜温差大'] },
    { name: '测 (Measurement)', causes: ['量具未按期校准'] },
  ],
};

export function cloneFishbone(data: FishboneData): FishboneData {
  return {
    problem: data.problem,
    categories: data.categories.map((category) => ({ name: category.name, causes: [...category.causes] })),
  };
}

function validFishbone(value: unknown): value is FishboneData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<FishboneData>;
  return typeof data.problem === 'string'
    && Array.isArray(data.categories)
    && data.categories.length === 6
    && data.categories.every((category) => category
      && typeof category.name === 'string'
      && Array.isArray(category.causes)
      && category.causes.every((cause) => typeof cause === 'string'));
}

/**
 * 新格式为带 isDemo 的 envelope；旧版直接保存 FishboneData，按真实用户数据兼容。
 * 没有有效持久化内容时返回明确标记的内置示例。
 */
export function loadFishboneState(): FishboneState {
  let raw: string | null = null;
  try {
    // localStorage 配额失败后，页面、报告与项目导出都必须继续看到同一份最新内存状态。
    raw = dirtyFishboneJson ?? localStorage.getItem(FISHBONE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      const detail = projectStoreValidationError(FISHBONE_STORAGE_KEY, parsed);
      if (detail) {
        if (!preserveCorruptStore(FISHBONE_STORAGE_KEY, raw, detail)) {
          protectedCorruptFishbone = { raw, detail };
        } else protectedCorruptFishbone = null;
        return { data: cloneFishbone(FISHBONE_DEFAULT), isDemo: true };
      }
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        const envelope = parsed as { data?: unknown; isDemo?: unknown };
        if (validFishbone(envelope.data) && typeof envelope.isDemo === 'boolean') {
          return { data: cloneFishbone(envelope.data), isDemo: envelope.isDemo };
        }
      }
      if (validFishbone(parsed)) return { data: cloneFishbone(parsed), isDemo: false };
    }
  } catch {
    if (raw && !preserveCorruptStore(FISHBONE_STORAGE_KEY, raw, 'JSON 解析失败或写入被截断')) {
      protectedCorruptFishbone = { raw, detail: 'JSON 解析失败或写入被截断' };
    } else if (raw) protectedCorruptFishbone = null;
  }
  return { data: cloneFishbone(FISHBONE_DEFAULT), isDemo: true };
}

export function loadFishbone(): FishboneData {
  return loadFishboneState().data;
}

/** 鱼骨图 UI、历史回放与持久化共用的写入前校验。 */
export function fishboneWriteValidationError(data: unknown, isDemo = false): string | null {
  return projectStoreValidationError(FISHBONE_STORAGE_KEY, { data, isDemo });
}

export function saveFishboneState(data: FishboneData, isDemo = false): void {
  const detail = fishboneWriteValidationError(data, isDemo);
  if (detail) throw new Error(detail);
  const encoded = JSON.stringify({ data: cloneFishbone(data), isDemo });
  if (protectedCorruptFishbone) {
    const { raw, detail } = protectedCorruptFishbone;
    if (!preserveCorruptStore(FISHBONE_STORAGE_KEY, raw, detail)) {
      dirtyFishboneJson = encoded;
      throw new Error('损坏的鱼骨图原文尚未成功隔离，已禁止覆盖；请先释放本地存储空间');
    }
    protectedCorruptFishbone = null;
  }
  try {
    localStorage.setItem(FISHBONE_STORAGE_KEY, encoded);
    dirtyFishboneJson = null;
  } catch (error) {
    dirtyFishboneJson = encoded;
    throw error;
  }
}

/** “清除业务数据”显式丢弃内存中尚未落盘的鱼骨编辑。 */
export function clearFishboneState(): void {
  dirtyFishboneJson = null;
  protectedCorruptFishbone = null;
  try { localStorage.removeItem(FISHBONE_STORAGE_KEY); } catch { /* 调用方会统一提示清除错误 */ }
}

registerProjectLifecycleHooks({
  beforeExport: () => {
    // fix2609m A3:鱼骨图只在进入鱼骨图页时读取；启动后直接保存项目时先按读取侧同一函数校验 live 值，
    // 损坏则先隔离(导出按降级视图省略该键)，隔离失败仍 fail-closed。内存有未落盘载荷时导出取它，无需校验 live。
    if (dirtyFishboneJson === null) loadFishboneState();
    if (protectedCorruptFishbone) {
      throw new Error(`损坏的鱼骨图原文尚未成功复制到隔离区，项目未导出；请先${STORAGE_SPACE_RELEASE_HINT}，再重试保存项目（损坏原文仍保留在本机，不会被覆盖）`);
    }
  },
  projectStoreOverrides: () => dirtyFishboneJson
    ? { [FISHBONE_STORAGE_KEY]: dirtyFishboneJson }
    : {},
});

// STORE-10:鱼骨图写入 localStorage 失败、仅在内存(dirtyFishboneJson)时,与活动表同一判定纳入
// beforeunload / 桌面关窗确认,不再静默丢失。
registerUnpersistedStateProbe('鱼骨图', () => dirtyFishboneJson !== null);
