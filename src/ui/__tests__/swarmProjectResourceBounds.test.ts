/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { MAX_DATASET_NAME_CHARS, MAX_RECENT_DATASETS, MAX_SAVED_AT_CHARS } from '../../core';
import { applyProjectJson, projectStoreValidationError } from '../../platform/project';

describe('.qproj 最近数据集资源边界', () => {
  const recent = (name: string, savedAt = '2026-08-12T00:00:00.000Z') => ({ name, savedAt });

  it('拒绝超过产品不变量的最近条目，而不是导入后渲染全量 DOM', () => {
    const payload = Array.from({ length: MAX_RECENT_DATASETS + 1 }, (_, i) => recent(`d${i}`));
    expect(projectStoreValidationError('qp-recents-v1', payload)).toContain(`${MAX_RECENT_DATASETS}`);
  });

  it('拒绝过长名称、时间戳和重名条目', () => {
    expect(projectStoreValidationError('qp-recents-v1', [recent('x'.repeat(MAX_DATASET_NAME_CHARS + 1))]))
      .toContain('名称超过');
    expect(projectStoreValidationError('qp-recents-v1', [recent('d', 't'.repeat(MAX_SAVED_AT_CHARS + 1))]))
      .toContain('savedAt');
    expect(projectStoreValidationError('qp-recents-v1', [recent('d'), recent('d')]))
      .toContain('重复');
  });

  it('同样拒绝活动工作表与 vault 的超长名称', () => {
    const name = 'x'.repeat(MAX_DATASET_NAME_CHARS + 1);
    expect(projectStoreValidationError('qp-dataset-v1', {
      name, colNames: ['C1'], rows: [[1], [2]], textCols: [], savedAt: 't',
    })).toContain('名称超过');
    const data = JSON.stringify({ name, colNames: ['C1'], rows: [[1], [2]], textCols: [], savedAt: 't' });
    expect(applyProjectJson(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 4, appVersion: '1.43.0', exportedAt: 't',
      stores: {}, vault: { [name]: data },
    }))).toContain('vault 数据集名称超过');
  });
});
