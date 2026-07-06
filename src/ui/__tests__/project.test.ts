/**
 * 项目文件 (.qproj) 往返测试 — 导出/校验/恢复。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildProjectJson, applyProjectJson, isProjectFile, PROJECT_KEYS } from '../../platform/project';

beforeEach(() => localStorage.clear());

describe('项目文件', () => {
  it('导出 → 清空 → 导入,全部键恢复', () => {
    localStorage.setItem('qp-dataset-v1', JSON.stringify({ name: 't', colNames: ['a'], rows: [[1], [2]], textCols: [], savedAt: 'x' }));
    localStorage.setItem('qp-specs-v1', JSON.stringify({ t: { lsl: 1, tgt: 2, usl: 3 } }));
    localStorage.setItem('qp-fishbone-v1', JSON.stringify({ problem: 'p', categories: [] }));
    const json = buildProjectJson('9.9.9');
    const file = JSON.parse(json);
    expect(file.format).toBe('quality-platform-project');
    expect(file.appVersion).toBe('9.9.9');
    expect(Object.keys(file.stores)).toContain('qp-dataset-v1');

    localStorage.clear();
    expect(applyProjectJson(json)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-specs-v1')!)).toEqual({ t: { lsl: 1, tgt: 2, usl: 3 } });
    expect(localStorage.getItem('qp-dataset-v1')).toContain('"name":"t"');
  });

  it('导入会清掉文件中不存在的项目键(完整替换语义)', () => {
    const json = buildProjectJson('x'); // 空项目
    localStorage.setItem('qp-fishbone-v1', '{"problem":"旧"}');
    expect(applyProjectJson(json)).toBeNull();
    expect(localStorage.getItem('qp-fishbone-v1')).toBeNull();
  });

  it('拒绝:非 JSON / 错误格式 / 高版本 / 损坏值;忽略白名单外键', () => {
    expect(applyProjectJson('not json')).toContain('JSON');
    expect(applyProjectJson('{"format":"other"}')).toContain('不是质量分析平台');
    expect(applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 99, stores: {} }))).toContain('高于');
    expect(
      applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 1, stores: { 'qp-specs-v1': '{bad' } })),
    ).toContain('损坏');
    // 白名单外键不写入
    expect(
      applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 1, stores: { evil: '"x"' } })),
    ).toBeNull();
    expect(localStorage.getItem('evil')).toBeNull();
  });

  it('isProjectFile 与键白名单', () => {
    expect(isProjectFile('备份.qproj')).toBe(true);
    expect(isProjectFile('数据.csv')).toBe(false);
    expect(PROJECT_KEYS).toContain('qp-prefs-v1');
  });
});
