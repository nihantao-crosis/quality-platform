/** v1.43 第二轮：DOE 语义、1000σ 确认和发布验签结构的行为守护。
 * @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import {
  analyzeFactorial,
  buildDoeConclusion,
  capabilityInputError,
  capabilitySpecDistanceWarning,
  capabilityWarningFingerprint,
  computeCapability,
  detectFactorial,
  factorialBlockPlan,
  factorialOptimizationTerms,
  generateFactorialDesign,
} from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useApp } from '../../store/appStore';
import { capabilitySpecKey, resolveCapabilityMeasurementData, useData } from '../../store/dataStore';
import { Capability } from '../pages/Capability';
import { chartTokens } from '../tokens';

const factors4 = ['A', 'B', 'C', 'D'].map((name) => ({ name, low: -1, high: 1 }));

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({
    page: 'capability',
    spcDataLayout: 'individuals',
    spcValueCol: null,
    spcSubgroupCol: null,
    capSubgroupMode: 'spc',
    capSubgroupSize: 5,
    capValueCol: null,
    capSubgroupIdCol: null,
    capabilityWarningAcknowledgement: null,
  });
});

describe('DOE 区组与优化语义', () => {
  it('2^4/4 的实现、生成元、定义对比和定义字来自同一方案', () => {
    const plan = factorialBlockPlan(4, 4, 1);
    expect(plan.generatorLabels).toEqual(['BC', 'ABD']);
    expect(plan.definingContrasts).toEqual(['BC', 'ABD', 'ACD']);
    expect(plan.definingWords).toEqual(['I=BC·L1', 'I=ABD·L2', 'I=ACD·L1·L2']);
    const design = generateFactorialDesign(factors4, { blocks: 4, randomize: false });
    expect(design.blockPlan).toEqual(plan);
    expect(design.blockPlan?.description).toContain('生成元 BC、ABD');
    expect(design.blockPlan?.description).toContain('定义对比 BC、ABD、ACD');
  });

  it('完整仿行直接分区时不伪造处理效应生成元', () => {
    const plan = factorialBlockPlan(3, 2, 2);
    expect(plan.replicateBlocks).toBe(2);
    expect(plan.generatedBlocks).toBe(1);
    expect(plan.generatorLabels).toEqual([]);
    expect(plan.definingContrasts).toEqual([]);
    expect(plan.description).toContain('完整仿行直接分区');
  });

  it('优化文案披露显著项与仅因层级原则保留的父项', () => {
    const detected = detectFactorial([
      { name: 'A', values: [-1, 1, -1, 1, -1, 1, -1, 1] },
      { name: 'B', values: [-1, -1, 1, 1, -1, -1, 1, 1] },
      { name: 'C', values: [-1, -1, -1, -1, 1, 1, 1, 1] },
    ], [20, 0, 0, 20, 20, 0, 0, 20]); // 主要是 A×B，A/B 为层级父项
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    const result = analyzeFactorial(detected.design, { terms: ['A', 'B', 'C', 'A×B'] });
    // 夹具可能为零残差；显式标记交互后验证层级集合和文案本体。
    result.terms.forEach((term) => { term.sig = term.name === 'A×B'; });
    const terms = factorialOptimizationTerms(result, detected.design);
    expect(terms.significantTerms).toEqual(['A×B']);
    expect(terms.hierarchyParentTerms).toEqual(expect.arrayContaining(['A', 'B']));
    const text = buildDoeConclusion({
      status: 'unique', aliases: result.aliases, hasSignificantInteraction: true,
      sigTermNames: terms.significantTerms, hierarchyParentNames: terms.hierarchyParentTerms,
      detail: '残差自由度 4', factorCount: 3, respName: '响应', settings: 'A=高、B=高、C=低',
    });
    expect(text).toContain('显著项:A×B');
    expect(text).toContain('按层级原则保留未显著父项');
    expect(text).toContain('预测值仍由完整拟合模型给出');
  });

  it('README 不再声称已废弃的 ABC/ACD 方案', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).not.toContain('2^4/4 区组用 ABC、ACD');
    expect(readme).not.toContain('2^4/4 用 ABC、ACD');
    expect(readme).toContain('2^4/4 区组用 BC、ABD');
  });
});

describe('1000σ 强警告确认', () => {
  const values = [10, 10.1, 9.9, 10.05, 9.95, 10.02];
  const spec = { lsl: 500, tgt: 900, usl: 1400 };

  it('默认 fail closed，只有显式 allow 才计算，且 fingerprint 随角色/规格/数据变化', () => {
    const warning = capabilitySpecDistanceWarning(values, 0.1, spec);
    expect(warning?.code).toBe('distant-spec');
    expect(capabilityInputError(values, 0.1, spec)).toContain('显式确认');
    expect(capabilityInputError(values, 0.1, spec, { allowDistantSpec: true })).toBeNull();
    expect(Number.isFinite(computeCapability(values, 0.1, spec, { allowDistantSpec: true }).cpk)).toBe(true);
    const base = capabilityWarningFingerprint('dataset:A', values, 0.1, spec);
    expect(base).not.toBeNull();
    expect(capabilityWarningFingerprint('dataset:B', values, 0.1, spec)).not.toBe(base);
    expect(capabilityWarningFingerprint('dataset:A', values, 0.1, { ...spec, usl: 1401 })).not.toBe(base);
    expect(capabilityWarningFingerprint('dataset:A', [...values, 10.03], 0.1, spec)).not.toBe(base);
  });

  it('页面要求显式确认，确认后报告披露，改规格立即失效', () => {
    useData.getState().importMatrix('螺钉.csv', ['高度'], values.map((value) => [value]));
    useApp.setState({
      page: 'capability', spcDataLayout: 'individuals', spcValueCol: '高度',
      lsl: spec.lsl, tgt: spec.tgt, usl: spec.usl, lslOn: true, uslOn: true,
      capabilityWarningAcknowledgement: null,
    });
    const view = render(createElement(Capability, { T: chartTokens('经典', true) }));
    expect(view.container.textContent).toContain('强警告');
    expect(view.container.textContent).not.toContain('能力评估');
    fireEvent.click(screen.getByRole('button', { name: /我已核对/ }));
    expect(view.container.textContent).toContain('已显式确认超 1000σ 规格');

    const report = buildActiveAnalysisReport();
    expect(report?.warnings.join(' ')).toContain('用户已对当前测量角色');
    expect(report?.warnings.join(' ')).toContain('超过 1000 倍标准差');
    useApp.getState().setSpec({ usl: 1401 });
    expect(useApp.getState().capabilityWarningAcknowledgement).toBeNull();
  });

  it('持久确认必须与当前能力角色 fingerprint 完全相等', () => {
    useData.getState().importMatrix('螺钉.csv', ['高度'], values.map((value) => [value]));
    useApp.setState({ spcDataLayout: 'individuals', spcValueCol: '高度', ...spec, lslOn: true, uslOn: true });
    const data = useData.getState();
    const prepared = resolveCapabilityMeasurementData(data.model, data.textCols);
    if (!prepared.model) throw new Error(prepared.error);
    const fingerprint = capabilityWarningFingerprint(
      capabilitySpecKey(data.model, data.textCols)!, prepared.model.all, prepared.model.sigmaWithin, spec,
    );
    useApp.getState().acknowledgeCapabilityWarning(fingerprint);
    expect(useApp.getState().capabilityWarningAcknowledgement).toBe(fingerprint);
    useApp.getState().setCapabilitySubgroup({ capSubgroupMode: 'const', capValueCol: '高度' });
    expect(useApp.getState().capabilityWarningAcknowledgement).toBeNull();
  });
});

describe('发布工作流结构', () => {
  it('解析 YAML 后确认验签和全资产字节绑定都是 draft 转正的前置步骤', () => {
    const yaml = readFileSync('.github/workflows/release.yml', 'utf8');
    const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', [
      "doc=YAML.safe_load(STDIN.read, permitted_classes: [], aliases: true)",
      "job=doc.fetch('jobs').fetch('publish-release')",
      "puts JSON.generate({'needs'=>job['needs'], 'steps'=>job.fetch('steps').map{|s| {'name'=>s['name'], 'run'=>s['run']} }})",
    ].join(';')], { input: yaml, encoding: 'utf8' });
    expect(ruby.status, ruby.stderr).toBe(0);
    const job = JSON.parse(ruby.stdout) as { needs: string[]; steps: Array<{ name?: string; run?: string }> };
    expect(job.needs).toEqual(expect.arrayContaining(['updater-json', 'portable']));
    const verifyIndex = job.steps.findIndex((step) => step.name?.includes('embedded public key'));
    const digestDownloadIndex = job.steps.findIndex((step) => step.name?.includes('immutable digests'));
    const exactAssetsIndex = job.steps.findIndex((step) => step.run?.includes('release_asset_manifest.py verify'));
    const publishIndex = job.steps.findIndex((step) => step.run?.includes('--draft=false'));
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(digestDownloadIndex).toBeGreaterThan(-1);
    expect(exactAssetsIndex).toBeGreaterThan(verifyIndex);
    expect(publishIndex).toBeGreaterThan(exactAssetsIndex);
    const verify = job.steps[verifyIndex].run ?? '';
    // 工作流与测试必须执行同一个 fail-closed 验签脚本；
    // 不再搜索一份无法执行反例的内嵌源码字符。
    expect(verify).toContain('.github/scripts/verify_updater_assets.py');
    expect(verify).toContain("tauri.conf.json");
    const gate = readFileSync('.github/scripts/verify_updater_assets.py', 'utf8');
    expect(gate).toContain('check=True');
    expect(gate).toContain("entry.get(\"signature\") != encoded_signature");

    const assetGate = job.steps[exactAssetsIndex].run ?? '';
    expect(assetGate).toContain('--manifests-dir');
    expect(assetGate).toContain('--assets-json');
    expect(assetGate).toContain('--assets-dir');
    const manifestGate = readFileSync('.github/scripts/release_asset_manifest.py', 'utf8');
    expect(manifestGate).toContain('unrecognized assets');
    expect(manifestGate).toContain('does not match its immutable build digest');
  });
});
