/** v1.43 第二轮：1000σ 确认必须贯穿状态栏、总览、保存摘要与真实导出调度器。
 * @vitest-environment jsdom */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import App from '../../App';
import { assessSpcCharts, capabilityWarningFingerprint, computeCapability, DEFAULT_RULE_K, nf } from '../../core';
import { buildExportJob } from '../../platform/report';
import { useAnalyses } from '../../store/analyses';
import { DEFAULT_SPC_RULES, useApp } from '../../store/appStore';
import { capabilitySpecKey, capabilitySubgroupSemantics, resolveCapabilityMeasurementData, useData } from '../../store/dataStore';

const VALUES = [-1e-6, 0, 1e-6, -5e-7, 5e-7, 2e-7];
const SPEC = { lsl: -1, tgt: 0, usl: 1 };

function prepareAcknowledgedCapability() {
  useData.getState().importMatrix('微位移.csv', ['位移'], VALUES.map((value) => [value]));
  useApp.setState({
    page: 'dashboard',
    spcDataLayout: 'individuals',
    spcValueCol: '位移',
    spcSubgroupCol: null,
    capSubgroupMode: 'spc',
    lsl: SPEC.lsl,
    tgt: SPEC.tgt,
    usl: SPEC.usl,
    lslOn: true,
    uslOn: true,
    capabilityWarningAcknowledgement: null,
  });
  const data = useData.getState();
  const prepared = resolveCapabilityMeasurementData(data.model, data.textCols);
  if (!prepared.model) throw new Error(prepared.error);
  const fingerprint = capabilityWarningFingerprint(
    capabilitySpecKey(data.model, data.textCols)!,
    prepared.model.all,
    prepared.model.sigmaWithin,
    SPEC,
    capabilitySubgroupSemantics(data.model, data.textCols)!,
  );
  if (!fingerprint) throw new Error('夹具未触发远距离规格警告');
  useApp.getState().acknowledgeCapabilityWarning(fingerprint);
  return { data: useData.getState(), capabilityModel: prepared.model };
}

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [] });
  useApp.setState({ capabilityWarningAcknowledgement: null });
});

describe('1000σ 确认消费点同源', () => {
  it('确认后总览和状态栏显示与能力页相同的 Cpk，保存摘要不再回落未分析', () => {
    const { capabilityModel } = prepareAcknowledgedCapability();
    const expected = nf(computeCapability(
      capabilityModel.all,
      capabilityModel.sigmaWithin,
      SPEC,
      { allowDistantSpec: true },
    ).cpk, 2);
    const view = render(<App />);
    expect(view.container.textContent).toContain(`过程能力 Cpk${expected}`);
    expect(view.container.textContent).toContain(`Cpk ${expected}`);

    act(() => { useApp.getState().goTo('capability'); });
    act(() => { useAnalyses.getState().saveCurrent(); });
    const saved = useAnalyses.getState().saved[0];
    expect(saved.metric).toBe(`Cpk ${expected}`);
    expect(saved.status).not.toBe('未分析');
  });

  it('真实导出调度器在四种格式中都消费确认并披露，未确认仍 fail-closed', async () => {
    const { data, capabilityModel } = prepareAcknowledgedCapability();
    const assessment = assessSpcCharts(data.model, DEFAULT_SPC_RULES, DEFAULT_RULE_K, 'i-mr');

    const blocked = await buildExportJob(
      'pdf', data.model, SPEC, assessment, undefined, capabilityModel, assessment.chartPointCount,
    );
    expect(blocked.text).toContain('能力分析未运行');

    const jobs = await Promise.all((['pdf', 'excel', 'word', 'ppt'] as const).map((format) =>
      buildExportJob(
        format,
        data.model,
        SPEC,
        assessment,
        undefined,
        capabilityModel,
        assessment.chartPointCount,
        { allowDistantSpec: true },
      )));

    expect(jobs[0].text).toContain('显式确认继续计算远距离规格');
    expect(jobs[0].text).not.toContain('能力分析未运行');

    const workbook = XLSX.read(jobs[1].bytes, { type: 'array' });
    const summary = XLSX.utils.sheet_to_csv(workbook.Sheets['统计摘要']);
    expect(summary).toContain('规格风险确认');
    expect(summary).not.toContain('能力分析,未运行');

    const docx = await JSZip.loadAsync(jobs[2].bytes!);
    const docxXml = await docx.file('word/document.xml')!.async('string');
    expect(docxXml).toContain('显式确认继续计算远距离规格');

    const pptx = await JSZip.loadAsync(jobs[3].bytes!);
    const slideXml = (await Promise.all(
      Object.keys(pptx.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map((name) => pptx.file(name)!.async('string')),
    )).join('\n');
    expect(slideXml).toContain('显式确认继续计算远距离规格');
  }, 30_000);
});

// v1.43 安全/功能审查确认缺陷(analyses.ts:681):能力快照固化了 spcRules/spcRuleK/
// spcSigmaMethod 供稳定性计数复现,却漏了 spcType(决定取 R 图/S 图族)。回放时沿用
// 当前页面 spcType,会让保存卡与回看后的页面/导出结论翻转。
describe('能力快照固化 spcType(稳定性计数 R图/S图族)', () => {
  it('保存时写入 spcType;回放还原保存值,不继承当前页面', async () => {
    prepareAcknowledgedCapability();
    useApp.setState({ page: 'capability', spcType: 'xbar-s' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toBeTruthy();
    // 固化:能力快照必须带上保存时的 spcType
    expect(saved!.snapshot.spcType).toBe('xbar-s');

    // 用户此后把控制图切回 X̄-R,再回看该记录
    useApp.setState({ spcType: 'xbar-r' });
    const ok = await useAnalyses.getState().restore(saved!.id);
    expect(ok).toBe(true);
    // 回放必须还原保存时的 X̄-S,而不是沿用当前的 X̄-R
    expect(useApp.getState().spcType).toBe('xbar-s');
  });

  it('旧能力快照(无 spcType)回落 X̄-R,不继承当前的 X̄-S', async () => {
    prepareAcknowledgedCapability();
    useApp.setState({ page: 'capability', spcType: 'xbar-r' });
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved).toBeTruthy();
    // 模拟 v1.43 前的旧快照:未固化 spcType
    const legacy = { ...saved!, snapshot: { ...saved!.snapshot, spcType: undefined } };
    useAnalyses.setState({ saved: [legacy] });

    useApp.setState({ spcType: 'xbar-s' });
    const ok = await useAnalyses.getState().restore(legacy.id);
    expect(ok).toBe(true);
    // 旧记录回落子组图族历史默认 X̄-R,绝不继承当前页面的 X̄-S 而改写历史结论
    expect(useApp.getState().spcType).toBe('xbar-r');
  });
});
