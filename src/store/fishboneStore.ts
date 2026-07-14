/** 鱼骨图数据与演示标记的单一持久化入口。 */
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
  try {
    const raw = localStorage.getItem(FISHBONE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        const envelope = parsed as { data?: unknown; isDemo?: unknown };
        if (validFishbone(envelope.data) && typeof envelope.isDemo === 'boolean') {
          return { data: cloneFishbone(envelope.data), isDemo: envelope.isDemo };
        }
      }
      if (validFishbone(parsed)) return { data: cloneFishbone(parsed), isDemo: false };
    }
  } catch { /* 回落内置示例 */ }
  return { data: cloneFishbone(FISHBONE_DEFAULT), isDemo: true };
}

export function loadFishbone(): FishboneData {
  return loadFishboneState().data;
}

export function saveFishboneState(data: FishboneData, isDemo = false): void {
  if (!validFishbone(data)) throw new Error('鱼骨图必须包含完整的 6M 分类');
  localStorage.setItem(FISHBONE_STORAGE_KEY, JSON.stringify({ data: cloneFishbone(data), isDemo }));
}
