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
    gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
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

  it('MSA 公差、判定与量具信息持久化往返；非法值逐字段回落', async () => {
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: {
        gageTolMode: 'upper', gageTolValue: 100, gageStandard: 'aiag',
        gageGaugeName: '数显千分尺-01', gageReportBy: '张工',
        gageStudyDate: '2026-07-21', gageNotes: '产线 A 首件研究',
      },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({
      gageTolMode: 'upper', gageTolValue: 100, gageStandard: 'aiag',
      gageGaugeName: '数显千分尺-01', gageReportBy: '张工',
      gageStudyDate: '2026-07-21', gageNotes: '产线 A 首件研究',
    });

    useApp.setState({
      gageTolMode: 'auto', gageTolValue: null, gageStandard: 'factory',
      gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
    });
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: {
        gageTolMode: '任意', gageTolValue: 'NaN', gageStandard: 7,
        gageGaugeName: 'x'.repeat(81), gageReportBy: 7,
        // 格式正确但日历上不存在，也必须逐字段回落。
        gageStudyDate: '2026-02-29', gageNotes: 'x'.repeat(201),
      },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({
      gageTolMode: 'auto', gageTolValue: null, gageStandard: 'factory',
      gageGaugeName: '', gageReportBy: '', gageStudyDate: '', gageNotes: '',
    });
  });

  it('批次720 MSA 公差随列记忆:切列换口径不串用、记忆可恢复、应用到全部显式生效', () => {
    useApp.setState({ gageValueName: '螺钉高度', gageTolMode: 'width', gageTolValue: 1, gageTolByCol: {}, gageBatchCols: null });
    // 切到平衡量值:螺钉高度的公差入记忆,新列无记忆 → none(绝不带旧值)
    useApp.getState().switchGageMeasurement('螺钉高度', '平衡量值');
    expect(useApp.getState()).toMatchObject({ gageValueName: '平衡量值', gageTolMode: 'none', gageTolValue: null });
    expect(useApp.getState().gageTolByCol['螺钉高度']).toEqual({ mode: 'width', value: 1 });
    // 平衡量值设上限 100 后切回螺钉高度:各自恢复
    useApp.setState({ gageTolMode: 'upper', gageTolValue: 100 });
    useApp.getState().switchGageMeasurement('平衡量值', '螺钉高度');
    expect(useApp.getState()).toMatchObject({ gageValueName: '螺钉高度', gageTolMode: 'width', gageTolValue: 1 });
    useApp.getState().switchGageMeasurement('螺钉高度', '平衡量值');
    expect(useApp.getState()).toMatchObject({ gageTolMode: 'upper', gageTolValue: 100 });
    // 应用到全部:显式覆盖
    useApp.getState().applyGageTolToCols(['电阻值', '螺钉高度']);
    expect(useApp.getState().gageTolByCol['电阻值']).toEqual({ mode: 'upper', value: 100 });
    expect(useApp.getState().gageTolByCol['螺钉高度']).toEqual({ mode: 'upper', value: 100 });
  });

  it('MSA 批量列去重并封顶 64；公差记忆按最近使用保留而非误删刚触碰列', () => {
    const cols = Array.from({ length: 65 }, (_, index) => `响应${index + 1}`);
    useApp.getState().setGageBatchCols([...cols, '响应1']);
    expect(useApp.getState().gageBatchCols).toHaveLength(64);
    expect(new Set(useApp.getState().gageBatchCols).size).toBe(64);
    const selected = useApp.getState().gageBatchCols ?? [];
    expect(selected[selected.length - 1]).toBe('响应64');

    const memory = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
      `历史响应${index + 1}`, { mode: 'width' as const, value: index + 1 },
    ]));
    useApp.setState({
      gageValueName: '历史响应1', gageTolMode: 'upper', gageTolValue: 999,
      gageTolByCol: memory,
    });
    useApp.getState().switchGageMeasurement('历史响应1', '新响应');
    useApp.setState({ gageTolMode: 'lower', gageTolValue: 123 });
    useApp.getState().switchGageMeasurement('新响应', '另一个响应');
    const remembered = useApp.getState().gageTolByCol;
    expect(Object.keys(remembered)).toHaveLength(65);
    expect(remembered['历史响应1']).toEqual({ mode: 'upper', value: 999 });
    expect(remembered['历史响应2']).toEqual({ mode: 'width', value: 2 });
    expect(remembered['新响应']).toEqual({ mode: 'lower', value: 123 });
  });

  it('MSA 满容量切换先恢复目标公差，并保全 64 个批量列', () => {
    const selected = Array.from({ length: 64 }, (_, index) => `C${index + 1}`);
    const memory = Object.fromEntries([
      ...selected.map((name, index) => [name, { mode: 'width' as const, value: index + 1 }] as const),
      ['C65', { mode: 'lower' as const, value: -5 }] as const,
    ]);
    useApp.setState({
      gageValueName: 'C66', gageTolMode: 'upper', gageTolValue: 999,
      gageBatchCols: selected, gageTolByCol: memory,
    });
    useApp.getState().switchGageMeasurement('C66', 'C1');
    expect(useApp.getState()).toMatchObject({ gageValueName: 'C1', gageTolMode: 'width', gageTolValue: 1 });
    expect(Object.keys(useApp.getState().gageTolByCol)).toHaveLength(65);
    for (const name of selected) expect(useApp.getState().gageTolByCol[name]).toBeDefined();
  });

  it('批次720 gageTolByCol/gageBatchCols 持久化往返;坏条目逐项丢弃不废整包', async () => {
    useApp.setState({ gageTolByCol: {}, gageBatchCols: null });
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: {
        gageBatchCols: ['螺钉高度', '平衡量值'],
        gageTolByCol: {
          '螺钉高度': { mode: 'width', value: 1 },
          '坏模式': { mode: '任意', value: 1 },
          '坏数值': { mode: 'upper', value: 'NaN' },
          '电阻值': { mode: 'none', value: null },
        },
      },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState().gageBatchCols).toEqual(['螺钉高度', '平衡量值']);
    expect(useApp.getState().gageTolByCol).toEqual({
      '螺钉高度': { mode: 'width', value: 1 },
      '电阻值': { mode: 'none', value: null },
    });
  });

  it('批次720 SPC σ 估计方法/区带开关持久化往返;非法值回落', async () => {
    useApp.setState({ spcSigmaMethod: 'pooled', spcShowZones: true });
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: { spcSigmaMethod: 'classic', spcShowZones: false },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({ spcSigmaMethod: 'classic', spcShowZones: false });

    useApp.setState({ spcSigmaMethod: 'pooled', spcShowZones: true });
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: { spcSigmaMethod: 'rbar-ish', spcShowZones: 'no' },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState()).toMatchObject({ spcSigmaMethod: 'pooled', spcShowZones: true });
  });

  it('旧 Pareto 合并状态首次水合时明确提示并重置为展开全部类别', async () => {
    useApp.setState({ toast: null, paretoMergeOther: false });
    localStorage.setItem('qp-prefs-v1', JSON.stringify({
      version: 3,
      state: { paretoMergeOther: true },
    }));
    await useApp.persist.rehydrate();
    expect(useApp.getState().paretoMergeOther).toBe(false);
    expect(useApp.getState().toast).toContain('展开全部类别');
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
