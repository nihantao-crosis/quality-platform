/** v1.43 third audit round: DOE hierarchy/block enumeration and numeric edges. */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createHash } from 'node:crypto';
import {
  capabilityWarningFingerprint,
  computeGageRR,
  factorialBlockOptions,
  factorialBlockPlan,
  factorialHierarchyClosure,
  linearRegression,
  toggleFactorialHierarchyTerm,
  type GageObservation,
} from '../../core';
import { buildActiveAnalysisReport } from '../../platform/activeAnalysisReport';
import { useAnalyses } from '../../store/analyses';
import { useApp } from '../../store/appStore';
import {
  capabilitySpecKey,
  capabilitySubgroupSemantics,
  rememberSpecForCapabilityMeasurement,
  syncSpecForCapabilityMeasurement,
  useData,
} from '../../store/dataStore';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useAnalyses.setState({ saved: [], lastError: null });
  useApp.setState({
    page: 'doe',
    doeTab: 'analyze',
    doeFactorCols: null,
    doeRespCol: null,
    doeModelTerms: null,
    doeIncludeCurvature: false,
    capSubgroupMode: 'spc',
    capSubgroupSize: 5,
    capValueCol: null,
    capSubgroupIdCol: null,
    spcDataLayout: 'auto',
    spcValueCol: null,
    spcSubgroupCol: null,
    spcStageCol: null,
    spcSigmaMethod: 'classic',
  });
});

describe('DOE legal blocks and strong hierarchy', () => {
  it('enumerates every planner-legal block count for factors 2..4 and replicates 1..10', () => {
    for (let factors = 2; factors <= 4; factors += 1) {
      for (let replicates = 1; replicates <= 10; replicates += 1) {
        const expected: number[] = [];
        for (let blocks = 1; blocks <= (1 << factors) * replicates; blocks *= 2) {
          try {
            factorialBlockPlan(factors, blocks, replicates);
            expected.push(blocks);
          } catch { /* planner is the authority */ }
        }
        expect(factorialBlockOptions(factors, replicates)).toEqual(expected);
      }
    }
    expect(factorialBlockOptions(2, 2)).toContain(4);
    expect(factorialBlockOptions(3, 4)).toContain(16);
    expect(factorialBlockOptions(4, 8)).toContain(64);
  });

  it('adds all parents with a high-order term and cascades dependent interactions when a parent is removed', () => {
    const names = ['A', 'B', 'C'];
    expect(factorialHierarchyClosure(names, ['A×B×C'])).toEqual([
      'A', 'B', 'C', 'A×B', 'A×C', 'B×C', 'A×B×C',
    ]);
    const selected = ['A', 'B', 'C', 'A×B', 'A×C', 'B×C', 'A×B×C'];
    expect(toggleFactorialHierarchyTerm(names, selected, 'A', false)).toEqual(['B', 'C', 'B×C']);
    expect(toggleFactorialHierarchyTerm(names, ['A', 'B'], 'A×B', true)).toEqual(['A', 'B', 'A×B']);
  });

  it('page selection, saved snapshot and specialist report normalize the same hierarchy', () => {
    const A = [-1, 1, -1, 1, -1, 1, -1, 1];
    const B = [-1, -1, 1, 1, -1, -1, 1, 1];
    const C = [-1, -1, -1, -1, 1, 1, 1, 1];
    const Y = A.map((a, index) => 30 + 3 * a + 2 * B[index] + C[index] + 5 * a * B[index]);
    useData.getState().importMatrix('DOE层级', ['A', 'B', 'C', 'Y'], A.map((a, index) => [a, B[index], C[index], Y[index]]));
    useApp.setState({
      page: 'doe', doeFactorCols: ['A', 'B', 'C'], doeRespCol: 'Y',
      // Simulate an old/non-hierarchical snapshot.
      doeModelTerms: ['A×B'], doeIncludeCurvature: false,
    });

    const report = buildActiveAnalysisReport();
    expect(report?.summary[0]).toContain('模型项 A、B、A×B');
    const saved = useAnalyses.getState().saveCurrent();
    expect(saved?.snapshot.doeModelTerms).toEqual(['A', 'B', 'A×B']);
    expect(saved?.metric).toBeTruthy();
  });
});

describe('capability acknowledgement fingerprint', () => {
  const values = [10, 10.1, 9.9, 10.05, 9.95, 10.02];
  const spec = { lsl: 500, tgt: 900, usl: 1400 };

  it('is fixed-size/stable but changes for order and subgroup semantics even when moments match', () => {
    const reordered = [10.1, 10, 9.9, 10.05, 9.95, 10.02];
    const first = capabilityWarningFingerprint('dataset:value', values, 0.1, spec, 'const:2');
    expect(first).toMatch(/^capability-warning:v2:sha256:[0-9a-f]{64}$/);
    expect(first!.length).toBeLessThan(128);
    const numberText = (value: number | null) => value == null ? null : Object.is(value, -0) ? '-0' : value.toString();
    const oraclePayload = JSON.stringify({
      v: 2,
      measurementKey: 'dataset:value',
      subgroupSemantics: 'const:2',
      spec: { lsl: numberText(spec.lsl), tgt: numberText(spec.tgt), usl: numberText(spec.usl) },
      sigmaWithin: numberText(0.1),
      observations: values.map(numberText),
    });
    expect(first).toBe(`capability-warning:v2:sha256:${createHash('sha256').update(oraclePayload).digest('hex')}`);
    expect(capabilityWarningFingerprint('dataset:value', values, 0.1, spec, 'const:2')).toBe(first);
    expect(capabilityWarningFingerprint('dataset:value', reordered, 0.1, spec, 'const:2')).not.toBe(first);
    expect(capabilityWarningFingerprint('dataset:value', values, 0.1, spec, 'id:批次')).not.toBe(first);
  });

  it('规格键只跟随物理测量特性，确认语义则跟随子组角色', () => {
    useData.getState().importMatrix('能力口径', ['测量', '组'], values.map((value, index) => [value, Math.floor(index / 2) + 1]));
    useApp.setState({ capSubgroupMode: 'const', capValueCol: '测量', capSubgroupSize: 2 });
    const before = capabilitySpecKey(useData.getState().model, useData.getState().textCols);
    const semanticsBefore = capabilitySubgroupSemantics(useData.getState().model, useData.getState().textCols);
    expect(semanticsBefore).toContain('const');
    useApp.setState({ capabilityBins: 37 });
    expect(capabilitySpecKey(useData.getState().model, useData.getState().textCols)).toBe(before);
    useApp.setState({ capSubgroupSize: 3 });
    expect(capabilitySpecKey(useData.getState().model, useData.getState().textCols)).toBe(before);
    expect(capabilitySubgroupSemantics(useData.getState().model, useData.getState().textCols)).not.toBe(semanticsBefore);

    // 同一测量特性改变子组方式，图纸规格不应被重置。
    const remembered = { lsl: 1, tgt: 2, usl: 3, lslOn: true, uslOn: false };
    rememberSpecForCapabilityMeasurement(useData.getState().model, useData.getState().textCols, remembered);
    useApp.setState({ capSubgroupSize: 2 });
    useApp.setState({ lsl: -9, tgt: 0, usl: 9, lslOn: true, uslOn: true });
    expect(syncSpecForCapabilityMeasurement()).toBe(true);
    expect(useApp.getState()).toMatchObject(remembered);
  });
});

describe('extreme finite coordinates', () => {
  it('computes a finite regression intercept without forming slope*meanX first', () => {
    const result = linearRegression(
      [9e307, 1e308, 1.1e308],
      [8e307, 1e308, 1.2e308],
    );
    expect(result.slope).toBeCloseTo(2, 12);
    expect(Math.abs((result.intercept + 1e308) / 1e308)).toBeLessThan(1e-14);
    expect(result.r2).toBeCloseTo(1, 14);
  });

  it('Gage scales coordinates before centering when a finite endpoint difference overflows', () => {
    const normalized = [-1, -0.9, -0.8, -0.65, 0.65, 0.8, 0.9, 1];
    const makeStudy = (scale: number): GageObservation[] => {
      let index = 0;
      const rows: GageObservation[] = [];
      for (let part = 0; part < 2; part += 1) {
        for (let operator = 0; operator < 2; operator += 1) {
          for (let trial = 0; trial < 2; trial += 1) {
            rows.push({ part, operator, trial, value: normalized[index++] * scale });
          }
        }
      }
      return rows;
    };
    const baseline = computeGageRR(makeStudy(1), null);
    const extreme = computeGageRR(makeStudy(Number.MAX_VALUE), null);
    expect(extreme.totalGageRR).toBeCloseTo(baseline.totalGageRR, 12);
    expect(extreme.verdict).toBe(baseline.verdict);
    expect(extreme.ndc).toBe(baseline.ndc);
    extreme.components.forEach((component, index) => {
      expect(component.pctContribution).toBeCloseTo(baseline.components[index].pctContribution, 12);
      expect(component.pctStudyVar).toBeCloseTo(baseline.components[index].pctStudyVar, 12);
      expect(Number.isFinite(component.sd)).toBe(true);
      expect(Number.isFinite(component.studyVar)).toBe(true);
      expect(Number.isFinite(component.variance)).toBe(true);
    });
  });
});
