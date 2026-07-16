/** 当前版本偏好即使被手工篡改/截断，也必须在 hydrate 边界逐字段回退。 @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AQL_STATE_STORAGE_KEY, clearAqlBusinessState, DEFAULT_SPC_RULES, resetUiPreferences, useApp } from '../../store/appStore';
import { freshSwitchStatus } from '../../core';
import { buildProjectJsonFull } from '../../platform/project';
import { platform } from '../../platform/adapter';

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    chartStyle: '经典', showGrid: true, projectName: '安全项目',
    lsl: 1, tgt: 2, usl: 3, lslOn: true, uslOn: true, capabilityBins: 13,
    gageUseReal: true, gageValueName: null, gagePartName: null, gageOperatorName: null,
    spcRules: { ...DEFAULT_SPC_RULES }, spcDataLayout: 'auto', spcValueCol: null, spcSubgroupCol: null, spcStageCol: null,
    doeView: 'main', doeTab: 'analyze', doeFactorCols: null, doeRespCol: null, doeModelTerms: null, doeIncludeCurvature: true,
    t1ColName: null, t1Mu0: null, t2ColAName: null, t2ColBName: null, regXName: null, regYName: null,
    paretoView: 'pareto', paretoMergeOther: false, paretoThreshold: 0.95,
    aqlLot: 120, aqlLevel: 'II', aqlAQL: 1,
  });
});

describe('偏好持久化安全', () => {
  it('拒绝当前版本 envelope 中的非法类型、枚举、NaN 语义和双侧同时关闭', async () => {
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: {
        chartStyle: '注入风格', showGrid: 'yes', projectName: '',
        lsl: '坏', tgt: null, usl: Infinity, lslOn: false, uslOn: false, capabilityBins: 999,
        gageUseReal: 'true', gageValueName: 42,
        spcRules: { r1: 'yes', r2: false }, spcDataLayout: '任意', spcValueCol: 1,
        doeView: 'invalid', doeTab: 7, doeFactorCols: [1], doeIncludeCurvature: 'yes',
        t1Mu0: 'zero', paretoView: 'bad', paretoMergeOther: 1, paretoThreshold: 2,
        aqlLot: -1, aqlLevel: 'IV', aqlAQL: 123,
      },
    }));

    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({
      chartStyle: '经典', showGrid: true, projectName: '安全项目',
      lsl: 1, tgt: 2, usl: 3, lslOn: true, uslOn: true, capabilityBins: 13,
      gageUseReal: true, gageValueName: null,
      spcDataLayout: 'auto', spcValueCol: null,
      doeView: 'main', doeTab: 'analyze', doeFactorCols: null, doeIncludeCurvature: true,
      t1Mu0: null, paretoView: 'pareto', paretoMergeOther: false, paretoThreshold: 0.95,
      aqlLot: 120, aqlLevel: 'II', aqlAQL: 1,
    });
    expect(useApp.getState().spcRules).toMatchObject({ ...DEFAULT_SPC_RULES, r2: false });
  });

  it('合法偏好仍能恢复', async () => {
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: { chartStyle: '高对比', showGrid: false, capabilityBins: 20, paretoThreshold: 0.8 },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({ chartStyle: '高对比', showGrid: false, capabilityBins: 20, paretoThreshold: 0.8 });
  });

  it('同版本载荷不能注入未持久化的导航、弹窗、计算器或错误枚举', async () => {
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: {
        chartStyle: '现代', page: 'poison', spcType: 'poison', activeVar: 42,
        modal: { injected: true }, hypoTab: 'poison', calc: null,
      },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({
      chartStyle: '现代', page: 'dashboard', spcType: 'xbar-r', activeVar: '', modal: null,
      hypoTab: 'anova',
    });
    expect(useApp.getState().calc).toBeTruthy();
    expect(typeof useApp.getState().goTo).toBe('function');
  });

  it('重置界面偏好真实生效且保留 AQL 业务账本；清业务数据则立即清空账本', () => {
    useApp.setState({
      chartStyle: '高对比', projectName: '旧项目', aqlLot: 1000,
      aqlSwitch: { ...freshSwitchStatus(), note: 'SECRET-LEDGER' },
    });
    resetUiPreferences();
    expect(useApp.getState()).toMatchObject({ chartStyle: '经典', projectName: '质检项目 2026-Q2', aqlLot: 1000 });
    expect(useApp.getState().aqlSwitch.note).toBe('SECRET-LEDGER');
    expect(localStorage.getItem(AQL_STATE_STORAGE_KEY)).toContain('SECRET-LEDGER');

    clearAqlBusinessState();
    expect(useApp.getState()).toMatchObject({ aqlLot: 120, aqlLevel: 'II', aqlAQL: 1 });
    expect(useApp.getState().aqlSwitch.records).toEqual([]);
    expect(localStorage.getItem(AQL_STATE_STORAGE_KEY)).toBeNull();
  });

  it('偏好落盘超限不向事件冒泡，.qproj 导出当前内存规格而非旧缓存', async () => {
    useApp.getState().setSpec({ lsl: 1, tgt: 2, usl: 3 });
    const old = localStorage.getItem('qp-prefs-v1');
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'qp-prefs-v1') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    platform.datasetDb = null;
    try {
      expect(() => useApp.getState().setSpec({ lsl: 10, tgt: 20, usl: 30 })).not.toThrow();
      expect(useApp.getState()).toMatchObject({ lsl: 10, tgt: 20, usl: 30 });
      expect(localStorage.getItem('qp-prefs-v1')).toBe(old);
      const project = JSON.parse(await buildProjectJsonFull('1.34.0'));
      expect(JSON.parse(project.stores['qp-prefs-v1']).state).toMatchObject({ lsl: 10, tgt: 20, usl: 30 });
    } finally {
      spy.mockRestore();
      // 一次成功写入清除 dirty，避免影响同进程后续导入测试。
      useApp.getState().setSpec({ lsl: 10, tgt: 20, usl: 30 });
    }
  });
});
