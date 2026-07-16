/** 鱼骨编辑落盘失败时，报告与 .qproj 必须使用最新内存状态。 @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectJsonFull } from '../../platform/project';
import { platform } from '../../platform/adapter';
import {
  clearFishboneState, loadFishboneState, saveFishboneState, type FishboneData,
} from '../../store/fishboneStore';

const fishbone = (problem: string): FishboneData => ({
  problem,
  categories: ['人', '机', '料', '法', '环', '测'].map((name) => ({ name, causes: [`${problem}-${name}`] })),
});

beforeEach(() => {
  localStorage.clear();
  clearFishboneState();
  platform.datasetDb = null;
});

afterEach(() => {
  clearFishboneState();
});

describe('鱼骨持久化配额兜底', () => {
  it('写盘失败后读取与完整项目导出仍取最新编辑，不回退旧鱼骨', async () => {
    saveFishboneState(fishbone('旧问题'));
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'qp-fishbone-v1') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    try {
      expect(() => saveFishboneState(fishbone('新问题'))).toThrow();
      expect(loadFishboneState().data.problem).toBe('新问题');
      const project = JSON.parse(await buildProjectJsonFull('1.34.0'));
      expect(JSON.parse(project.stores['qp-fishbone-v1']).data.problem).toBe('新问题');
      expect(JSON.parse(localStorage.getItem('qp-fishbone-v1')!).data.problem).toBe('旧问题');
    } finally {
      spy.mockRestore();
    }
  });
});
