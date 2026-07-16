/** 独立 AQL 责任账本损坏时必须保留原始证据并阻止残缺导出。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('AQL 独立账本持久化安全', () => {
  it('损坏记录不会在启动时被默认空账本覆盖，完整项目导出 fail-closed', async () => {
    const corrupt = JSON.stringify({
      aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlMethod: 'gb', aqlAcMethod: 'gb',
      aqlSwitch: { state: 'normal', records: [{}] },
    });
    localStorage.setItem('qp-aql-state-v1', corrupt);

    const { useApp } = await import('../../store/appStore');
    expect(localStorage.getItem('qp-aql-state-v1')).toBe(corrupt);
    expect(useApp.getState().toast).toContain('损坏的 AQL 责任账本');

    const { buildProjectJsonFull } = await import('../../platform/project');
    await expect(buildProjectJsonFull('1.34.0')).rejects.toThrow('AQL 责任账本已损坏');
    expect(localStorage.getItem('qp-aql-state-v1')).toBe(corrupt);
  });

  it('截断 JSON 同样原样隔离，不会被启动迁移覆盖', async () => {
    localStorage.setItem('qp-aql-state-v1', '{"aqlLot":2000');
    await import('../../store/appStore');
    expect(localStorage.getItem('qp-aql-state-v1')).toBe('{"aqlLot":2000');
  });
});
