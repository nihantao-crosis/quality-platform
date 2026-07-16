/** 项目导入成功到 reload 之间，旧内存 store 不得因 Toast 再覆盖新项目。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('项目导入成功后的旧会话写冻结', () => {
  it('applyProjectText → showToast 后仍保留导入项目 prefs', async () => {
    const { useApp } = await import('../../store/appStore');
    const { applyProjectText } = await import('../../platform/project');
    useApp.getState().setProjectName('旧内存项目');
    const importedPrefs = JSON.stringify({
      version: 3,
      state: {
        chartStyle: '高对比', showGrid: false, projectName: '导入项目',
        lsl: 10, tgt: 20, usl: 30, lslOn: true, uslOn: true, capabilityBins: 17,
      },
    });
    const text = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 2, appVersion: '1.34.0', exportedAt: 't',
      stores: { 'qp-prefs-v1': importedPrefs },
    });

    expect((await applyProjectText(text)).error).toBeNull();
    expect(localStorage.getItem('qp-prefs-v1')).toBe(importedPrefs);
    useApp.getState().showToast('项目已恢复，即将刷新');
    expect(localStorage.getItem('qp-prefs-v1')).toBe(importedPrefs);
  });
});
