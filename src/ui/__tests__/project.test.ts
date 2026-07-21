/**
 * 项目文件 (.qproj) 往返测试 — 导出/校验/恢复。
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildProjectJson, applyProjectJson, isProjectFile, PROJECT_KEYS } from '../../platform/project';
import { freshSwitchStatus, MAX_AQL_RECORDS } from '../../core/aqlSwitch';

beforeEach(() => localStorage.clear());

const storedDataset = (name: string, rows: number[][] = [[1], [2]]) => ({
  name, colNames: rows[0].map((_, index) => `C${index + 1}`), rows, textCols: [], savedAt: 't',
});

const analysisSource = (name: string) => ({
  name, colNames: ['C1'], rows: [[1], [2]], textCols: [],
});

const specMap = (name: string, shift = 0) => ({
  [name]: { lsl: shift + 1, tgt: shift + 2, usl: shift + 3 },
});

const fishbone = {
  problem: '问题',
  categories: Array.from({ length: 6 }, (_, index) => ({ name: `分类${index + 1}`, causes: [] as string[] })),
};

const aqlState = (patch: Record<string, unknown> = {}) => ({
  aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlMethod: 'gb', aqlAcMethod: 'gb',
  aqlSwitch: freshSwitchStatus(), ...patch,
});

describe('项目文件', () => {
  it('导出 → 清空 → 导入,全部键恢复', () => {
    localStorage.setItem('qp-dataset-v1', JSON.stringify(storedDataset('t')));
    localStorage.setItem('qp-specs-v1', JSON.stringify({ t: { lsl: 1, tgt: 2, usl: 3 } }));
    localStorage.setItem('qp-fishbone-v1', JSON.stringify(fishbone));
    localStorage.setItem('qp-analysis-data-v1', JSON.stringify({ d1: analysisSource('历史数据') }));
    localStorage.setItem('qp-aql-state-v1', JSON.stringify(aqlState()));
    const json = buildProjectJson('9.9.9');
    const file = JSON.parse(json);
    expect(file.format).toBe('quality-platform-project');
    expect(file.formatVersion).toBe(4);
    expect(file.appVersion).toBe('9.9.9');
    expect(Object.keys(file.stores)).toContain('qp-dataset-v1');

    localStorage.clear();
    expect(applyProjectJson(json)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-specs-v1')!)).toEqual({ t: { lsl: 1, tgt: 2, usl: 3 } });
    expect(localStorage.getItem('qp-dataset-v1')).toContain('"name":"t"');
    expect(localStorage.getItem('qp-analysis-data-v1')).toContain('历史数据');
    expect(JSON.parse(localStorage.getItem('qp-aql-state-v1')!).aqlLot).toBe(2000);
  });

  it('v4 qproj 对批次720字段、MSA量具信息与 v7 分析快照完整往返', () => {
    const prefs = {
      version: 3,
      state: {
        chartStyle: '经典', showGrid: true, projectName: '720往返',
        lsl: 0, tgt: 5, usl: 10, lslOn: true, uslOn: true, capabilityBins: 13,
        spcSigmaMethod: 'classic', spcShowZones: true,
        gageUseReal: true, gageValueName: '响应A', gagePartName: '部件', gageOperatorName: '测试人',
        gageTolMode: 'width', gageTolValue: 10, gageStandard: 'factory',
        gageGaugeName: '数显千分尺-01', gageReportBy: '张工',
        gageStudyDate: '2026-07-21', gageNotes: '产线 A 首件研究',
        gageBatchCols: ['响应A', '响应B'],
        gageTolByCol: {
          响应A: { mode: 'width', value: 10 },
          响应B: { mode: 'upper', value: 100 },
        },
        aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1, aqlRegime: 'percent',
        aqlMethod: 'gb', aqlAcMethod: 'gb', aqlSwitch: freshSwitchStatus(),
      },
    };
    const analysis = {
      id: 'msa-720', kind: 'gagerr', title: 'MSA批量', datasetName: '工厂表', metric: '2个响应', status: '已分析',
      statusColor: '#2c8a45', statusBg: '#e8f4ea', createdAt: 1,
      snapshot: {
        snapshotVersion: 7,
        gageValueName: null,
        gagePartName: '部件',
        gageOperatorName: '测试人',
        gageGaugeName: '数显千分尺-01',
        gageReportBy: '张工',
        gageStudyDate: '2026-07-21',
        gageNotes: '产线 A 首件研究',
        gageBatchCols: ['响应A', '响应B'],
        gageTolByCol: {
          响应A: { mode: 'width', value: 10 },
          响应B: { mode: 'upper', value: 100 },
        },
        spcSigmaMethod: 'classic',
        spcShowZones: true,
      },
    };
    localStorage.setItem('qp-prefs-v1', JSON.stringify(prefs));
    localStorage.setItem('qp-analyses-v1', JSON.stringify([analysis]));
    const project = buildProjectJson('1.41.0');
    expect(JSON.parse(project).formatVersion).toBe(4);

    localStorage.clear();
    expect(applyProjectJson(project)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-prefs-v1')!)).toEqual(prefs);
    expect(JSON.parse(localStorage.getItem('qp-analyses-v1')!)).toEqual([analysis]);
  });

  it('导入会清掉文件中不存在的项目键(完整替换语义)', () => {
    const json = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: { 'qp-dataset-v1': JSON.stringify(storedDataset('新数据')) },
    });
    localStorage.setItem('qp-fishbone-v1', '{"problem":"旧"}');
    localStorage.setItem('qp-active-ref-v1', '旧机残留.csv');
    localStorage.setItem('qp-aql-state-v1', JSON.stringify(aqlState({ aqlLot: 999 })));
    expect(applyProjectJson(json)).toBeNull();
    expect(localStorage.getItem('qp-fishbone-v1')).toBeNull();
    expect(localStorage.getItem('qp-active-ref-v1')).toBeNull();
    expect(localStorage.getItem('qp-aql-state-v1')).toBeNull();
  });

  it('拒绝:非 JSON / 错误格式 / 高版本 / 损坏值;忽略白名单外键', () => {
    expect(applyProjectJson('not json')).toContain('JSON');
    expect(applyProjectJson('{"format":"other"}')).toContain('不是质量分析平台');
    expect(applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 0, stores: {} }))).toContain('无效');
    expect(applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 1.5, stores: {} }))).toContain('无效');
    expect(applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 99, stores: {} }))).toContain('高于');
    expect(
      applyProjectJson(JSON.stringify({ format: 'quality-platform-project', formatVersion: 1, stores: { 'qp-specs-v1': '{bad' } })),
    ).toContain('损坏');
    // 白名单外键不写入
    expect(
      applyProjectJson(JSON.stringify({
        format: 'quality-platform-project', formatVersion: 1,
        stores: { 'qp-specs-v1': '{}', evil: '"x"' },
      })),
    ).toBeNull();
    expect(localStorage.getItem('evil')).toBeNull();
  });

  it('拒绝空 stores 或仅含未知键的项目，且保留当前项目', () => {
    localStorage.setItem('qp-dataset-v1', '"当前数据"');
    const project = (stores: Record<string, string>) => JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't', stores,
    });

    expect(applyProjectJson(project({}))).toContain('没有可识别');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"当前数据"');
    expect(applyProjectJson(project({ evil: '"伪项目"' }))).toContain('没有可识别');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"当前数据"');
    expect(localStorage.getItem('evil')).toBeNull();
  });

  it('已知 store 的明显结构投毒全部在写入前拒绝', () => {
    const badWorksheet = { name: '坏表', colNames: ['C1', 'C2'], rows: [[1, 2], [3]], textCols: [], savedAt: 't' };
    const baseAnalysis = {
      id: 'a1', kind: 'spc', title: 't', datasetName: 'd', metric: 'm', status: 's',
      statusColor: '#000', statusBg: '#fff', createdAt: 1,
    };
    const cases: Array<[string, unknown]> = [
      ['qp-dataset-v1', badWorksheet],
      ['qp-recents-v1', [{ name: '坏表', savedAt: 't', data: badWorksheet }]],
      ['qp-attr-v1', { p: { name: 'P', counts: [1, 2], sampleSize: 1 } }],
      ['qp-specs-v1', { 批次: { lsl: 1, tgt: '2', usl: 3 } }],
      ['qp-fishbone-v1', { problem: 'p', categories: [] }],
      ['qp-analyses-v1', [{ ...baseAnalysis, snapshot: { sourceData: badWorksheet } }]],
      ['qp-analysis-data-v1', { d1: badWorksheet }],
      ['qp-pareto-v1', { name: 'P', rows: [{ name: '缺陷', count: -1 }] }],
      ['qp-prefs-v1', { version: 3, state: { lsl: '不是数值' } }],
      ['qp-prefs-v1', { version: 3, state: { doeFactorCols: [1] } }],
      ['qp-prefs-v1', { version: 4, state: {} }],
      ['qp-prefs-v1', { version: 3, state: { chartStyle: '注入值' } }],
      ['qp-prefs-v1', { version: 3, state: { gageStudyDate: '2026-02-29' } }],
      ['qp-prefs-v1', { version: 3, state: { page: 'poison', modal: {}, calc: null } }],
      ['qp-analyses-v1', [{
        ...baseAnalysis, kind: 'gagerr',
        snapshot: { snapshotVersion: 7, gageStudyDate: '2026-04-31' },
      }]],
      ['qp-aql-state-v1', aqlState({ injected: 'poison' })],
      ['qp-aql-state-v1', aqlState({ aqlSwitch: { ...freshSwitchStatus(), records: [{}] } })],
      ['qp-specs-v1', { 批次: { lsl: 1, tgt: 2, usl: 3, lslOn: false, uslOn: false } }],
      ['qp-dataset-v1', {
        name: '重名表', colNames: ['测量'], rows: [[1], [2]], savedAt: 't',
        textCols: [{ name: ' 测量 ', values: ['A', 'B'] }],
      }],
    ];
    const marker = JSON.stringify({ name: '当前', rows: [{ name: '保留', count: 1 }] });
    for (const [key, value] of cases) {
      localStorage.setItem('qp-pareto-v1', marker);
      const error = applyProjectJson(JSON.stringify({
        format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
        stores: { [key]: JSON.stringify(value) },
      }));
      expect(error, key).toContain(`「${key}」损坏`);
      expect(localStorage.getItem('qp-pareto-v1'), key).toBe(marker);
    }
  });

  it('合法 store 结构与 v0 偏好仍可导入，保留向后兼容', () => {
    const data = storedDataset('兼容数据');
    const stores = {
      'qp-dataset-v1': JSON.stringify(data),
      'qp-recents-v1': JSON.stringify([
        { name: '兼容数据', savedAt: 't', data },
        { name: '轻量旧数据', savedAt: 'old' },
      ]),
      'qp-attr-v1': JSON.stringify({
        p: { name: 'P', counts: [0, 1], sampleSize: 10 },
        c: { name: 'C', counts: [1, 2] },
      }),
      'qp-specs-v1': '{}',
      'qp-fishbone-v1': JSON.stringify({ data: fishbone, isDemo: false }),
      'qp-analyses-v1': '[]',
      'qp-analysis-data-v1': '{}',
      'qp-pareto-v1': JSON.stringify({ name: 'P', rows: [{ name: '缺陷', count: 0.5 }] }),
      'qp-prefs-v1': JSON.stringify({
        version: 0,
        state: {
          chartStyle: '经典', spcDataLayout: 'auto', doeView: 'main', doeTab: 'analyze',
          paretoView: 'pareto', aqlMethod: 'shift', aqlAcMethod: 'binom', doeFactorCols: null,
        },
      }),
      'qp-aql-state-v1': JSON.stringify(aqlState()),
    };
    const project = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: '0.9.0', exportedAt: 'old', stores,
    });

    expect(applyProjectJson(project)).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-recents-v1')!)).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem('qp-prefs-v1')!).version).toBe(0);
    expect(JSON.parse(localStorage.getItem('qp-aql-state-v1')!).aqlSwitch.records).toEqual([]);
  });

  it('项目文件兼容 P 图逐批样本量，并拒绝长度不一致或不良数超批量', () => {
    const project = (p: unknown) => JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: '1.34.0', exportedAt: 't',
      stores: { 'qp-attr-v1': JSON.stringify({ p }) },
    });
    const valid = { name: '逐批 P', counts: [1, 8, 2], sampleSizes: [10, 40, 20] };
    expect(applyProjectJson(project(valid))).toBeNull();
    expect(JSON.parse(localStorage.getItem('qp-attr-v1')!).p.sampleSizes).toEqual([10, 40, 20]);

    expect(applyProjectJson(project({ ...valid, sampleSizes: [10, 40] }))).toContain('等长');
    expect(applyProjectJson(project({ ...valid, counts: [11, 8, 2] }))).toContain('不能超过');
    expect(applyProjectJson(project({ ...valid, sampleSizes: [10, 0, 20] }))).toContain('正整数');
  });

  it('分析历史引用外置工作表时，项目必须同时包含对应 analysis-data', () => {
    const marker = JSON.stringify({ name: '当前', rows: [{ name: '保留', count: 1 }] });
    localStorage.setItem('qp-pareto-v1', marker);
    const analysis = {
      id: 'a1', kind: 'spc', title: 't', datasetName: 'd', metric: 'm', status: 's',
      statusColor: '#000', statusBg: '#fff', createdAt: 1, snapshot: { sourceDataKey: 'd-missing' },
    };
    const project = (analysisData?: Record<string, unknown>) => JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: 'x', exportedAt: 't',
      stores: {
        'qp-analyses-v1': JSON.stringify([analysis]),
        ...(analysisData ? { 'qp-analysis-data-v1': JSON.stringify(analysisData) } : {}),
      },
    });

    expect(applyProjectJson(project())).toContain('未包含在项目文件中');
    expect(localStorage.getItem('qp-pareto-v1')).toBe(marker);
    expect(applyProjectJson(project({ 'd-missing': analysisSource('历史数据') }))).toBeNull();
  });

  it('写入前拒绝同版本 .qproj 中非法 AQL 状态和损坏责任记录', () => {
    localStorage.setItem('qp-dataset-v1', '"原项目"');
    const prefs = (aqlSwitch: unknown) => JSON.stringify({
      version: 2,
      state: { aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0, aqlSwitch },
    });
    const project = (rawPrefs: string) => JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: '1.33.0',
      exportedAt: '2026-07-15T00:00:00.000Z',
      stores: { 'qp-prefs-v1': rawPrefs, 'qp-dataset-v1': JSON.stringify(storedDataset('外来项目')) },
    });

    const badRecord = applyProjectJson(project(prefs({ ...freshSwitchStatus(), records: [{}] })));
    expect(badRecord).toContain('责任账本');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"原项目"');

    const badReduced = applyProjectJson(project(prefs({
      ...freshSwitchStatus(), state: 'reduced', switchingScore: 30,
      productionSteady: false, reducedApproved: false,
    })));
    expect(badReduced).toContain('放宽状态');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"原项目"');

    const unknownState = applyProjectJson(project(prefs({ ...freshSwitchStatus(), state: 'tightend' })));
    expect(unknownState).toContain('检验状态无效');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"原项目"');
  });

  it('拒绝 stores 数组，不能把畸形项目当作空项目清掉当前数据', () => {
    localStorage.setItem('qp-prefs-v1', '"当前偏好"');
    localStorage.setItem('qp-dataset-v1', '"当前数据"');
    const error = applyProjectJson(JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: '1.33.0',
      exportedAt: '2026-07-15T00:00:00.000Z', stores: [],
    }));
    expect(error).toContain('stores');
    expect(localStorage.getItem('qp-prefs-v1')).toBe('"当前偏好"');
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"当前数据"');
  });

  it('拒绝超过单项目上限的 AQL 责任账本，且不改写当前项目', () => {
    localStorage.setItem('qp-dataset-v1', '"当前数据"');
    const raw = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: '1.33.0',
      exportedAt: '2026-07-15T00:00:00.000Z',
      stores: {
        'qp-prefs-v1': JSON.stringify({
          version: 3,
          state: {
            aqlLot: 2000, aqlLevel: 'II', aqlAQL: 1.0,
            aqlSwitch: { ...freshSwitchStatus(), records: Array(MAX_AQL_RECORDS + 1).fill({}) },
          },
        }),
      },
    });
    expect(applyProjectJson(raw)).toContain(`${MAX_AQL_RECORDS} 条上限`);
    expect(localStorage.getItem('qp-dataset-v1')).toBe('"当前数据"');
  });

  it('写入中途失败会回滚已经替换的项目键', () => {
    const originalDataset = JSON.stringify(storedDataset('原数据'));
    const originalSpecs = JSON.stringify(specMap('原数据'));
    localStorage.setItem('qp-dataset-v1', originalDataset);
    localStorage.setItem('qp-specs-v1', originalSpecs);
    const raw = JSON.stringify({
      format: 'quality-platform-project', formatVersion: 1, appVersion: '1.33.0',
      exportedAt: '2026-07-15T00:00:00.000Z',
      stores: {
        'qp-dataset-v1': JSON.stringify(storedDataset('新数据')),
        'qp-specs-v1': JSON.stringify(specMap('新数据', 10)),
      },
    });
    const originalSetItem = Storage.prototype.setItem;
    let injected = false;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'qp-specs-v1' && !injected) {
        injected = true;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });
    try {
      expect(applyProjectJson(raw)).toContain('写入本地存储失败');
      expect(localStorage.getItem('qp-dataset-v1')).toBe(originalDataset);
      expect(localStorage.getItem('qp-specs-v1')).toBe(originalSpecs);
    } finally {
      spy.mockRestore();
    }
  });

  it('isProjectFile 与键白名单', () => {
    expect(isProjectFile('备份.qproj')).toBe(true);
    expect(isProjectFile('数据.csv')).toBe(false);
    expect(PROJECT_KEYS).toContain('qp-prefs-v1');
    expect(PROJECT_KEYS).toContain('qp-analysis-data-v1');
    expect(PROJECT_KEYS).toContain('qp-active-ref-v1');
    expect(PROJECT_KEYS).toContain('qp-copy-sequences-v1');
    expect(PROJECT_KEYS).toContain('qp-aql-state-v1');
    expect(PROJECT_KEYS).toContain('qp-quarantine-v1');
  });
});
