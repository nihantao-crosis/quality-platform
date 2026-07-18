/**
 * MSA 工厂 5 案例黄金对拍（2026-07-18 电机一厂验收包）。
 *
 * 数据源:fixtures/gage-factory-cases-2026-07.tsv(自「MSA案例数据源7.18.xlsx」Sheet1 逐格导出,270 观测)。
 * 期望值三层精度(不把截图舍入当真实精度):
 *  1) EXPECTED_HP —— 独立 Python 复算(openpyxl+fsum+mpmath,不经过本引擎)的高精度期望,
 *     引擎断言用相对容差 1e-9;
 *  2) EXPECTED_PPT —— 「MSA案例结果5个7.18.pptx」会话窗口截图逐位转录值,
 *     按截图小数位四舍五入后必须全等(显示层对拍口径);
 *  3) 结构断言 —— 单人无再现性/操作员行、三人交互 p≥0.05 删除、ndc、工厂/AIAG 双判定与 OK/NG。
 * 案例2 为「过程公差上限=100」单侧口径:%Tol=3×SD/(USL−总均值)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeGageRR, assessGage, computeGagePanelData,
  type GageObservation, type GageToleranceSpec, type GageComponentKey,
} from '../gage';
import { CONTROL_CONSTANTS } from '../spc';

// ---------- 夹具装载 ----------

interface FactoryCase {
  id: number;
  observations: GageObservation[];
  operators: string[];
}

function loadCases(): Map<number, FactoryCase> {
  const text = readFileSync(new URL('./fixtures/gage-factory-cases-2026-07.tsv', import.meta.url), 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith('case'));
  const cases = new Map<number, FactoryCase>();
  const trialCounter = new Map<string, number>();
  for (const line of lines) {
    const [caseText, partText, operatorText, valueText] = line.split('\t');
    const id = Number(caseText);
    let entry = cases.get(id);
    if (!entry) {
      entry = { id, observations: [], operators: [] };
      cases.set(id, entry);
    }
    if (!entry.operators.includes(operatorText)) entry.operators.push(operatorText);
    const operator = entry.operators.indexOf(operatorText);
    const part = Number(partText) - 1;
    const key = `${id}:${part}:${operator}`;
    const trial = trialCounter.get(key) ?? 0;
    trialCounter.set(key, trial + 1);
    entry.observations.push({ part, operator, trial, value: Number(valueText) });
  }
  return cases;
}

const CASES = loadCases();

// ---------- 第 1 层:独立复算高精度期望(相对容差 1e-9) ----------

type HpRow = { sd: number; sv: number; psv: number; ptol: number };
interface HpCase {
  tol: GageToleranceSpec;
  grand: number;
  ndc: number;
  interactionP: number | null;
  components: Partial<Record<GageComponentKey, HpRow>>;
  factoryOk: boolean;
}

const EXPECTED_HP: Record<number, HpCase> = {
  1: {
    tol: { mode: 'width', value: 1 }, grand: 3.3146666666666667, ndc: 42, interactionP: null, factoryOk: true,
    components: {
      grr: { sd: 0.003651483716699386, sv: 0.021908902300196317, psv: 3.347205459690695, ptol: 2.190890230019632 },
      repeatability: { sd: 0.003651483716699386, sv: 0.021908902300196317, psv: 3.347205459690695, ptol: 2.190890230019632 },
      part: { sd: 0.10902938781542988, sv: 0.6541763268925793, psv: 99.94396537865913, ptol: 65.41763268925793 },
      total: { sd: 0.10909051627314233, sv: 0.654543097638854, psv: 100.0, ptol: 65.45430976388539 },
    },
  },
  2: {
    tol: { mode: 'upper', value: 100 }, grand: 60.67666666666666, ndc: 21, interactionP: null, factoryOk: true,
    components: {
      grr: { sd: 2.2579489217723667, sv: 13.5476935306342, psv: 6.418635278981523, ptol: 17.226023816183183 },
      repeatability: { sd: 2.2579489217723667, sv: 13.5476935306342, psv: 6.418635278981523, ptol: 17.226023816183183 },
      part: { sd: 35.105482319559286, sv: 210.63289391735572, psv: 99.79379299914108, ptol: 267.8217689887544 },
      total: { sd: 35.17802186340531, sv: 211.06813118043186, psv: 100.0, ptol: 268.3751773931065 },
    },
  },
  3: {
    tol: { mode: 'width', value: 3 }, grand: 73.41499999999999, ndc: 2, interactionP: null, factoryOk: false,
    components: {
      grr: { sd: 0.5620557504969325, sv: 3.3723345029815945, psv: 43.80067113939886, ptol: 112.41115009938649 },
      repeatability: { sd: 0.5620557504969325, sv: 3.3723345029815945, psv: 43.80067113939886, ptol: 112.41115009938649 },
      part: { sd: 1.1535718550187304, sv: 6.921431130112382, psv: 89.89717018759951, ptol: 230.7143710037461 },
      total: { sd: 1.2832126446376784, sv: 7.699275867826071, psv: 100.0, ptol: 256.6425289275357 },
    },
  },
  4: {
    tol: { mode: 'width', value: 1.4 }, grand: 0.7762222222222223, ndc: 13, interactionP: 0.1670331969130977, factoryOk: true,
    components: {
      grr: { sd: 0.04157853928140014, sv: 0.24947123568840082, psv: 10.51344820502612, ptol: 17.819373977742917 },
      repeatability: { sd: 0.039430778901593216, sv: 0.2365846734095593, psv: 9.97037074487089, ptol: 16.89890524353995 },
      reproducibility: { sd: 0.013190473986502724, sv: 0.07914284391901635, psv: 3.335311135349989, ptol: 5.65306027992974 },
      operator: { sd: 0.013190473986502724, sv: 0.07914284391901635, psv: 3.335311135349989, ptol: 5.65306027992974 },
      part: { sd: 0.3932878231111841, sv: 2.3597269386671047, psv: 99.44580135350226, ptol: 168.5519241905075 },
      total: { sd: 0.39547956551041796, sv: 2.372877393062508, psv: 100.0, ptol: 169.4912423616077 },
    },
  },
  5: {
    tol: { mode: 'width', value: 4 }, grand: 25.011222222222223, ndc: 1, interactionP: 0.08400526972192861, factoryOk: false,
    components: {
      grr: { sd: 0.33109395928730445, sv: 1.9865637557238267, psv: 68.21572536154446, ptol: 49.66409389309567 },
      repeatability: { sd: 0.33104268495053546, sv: 1.9862561097032128, psv: 68.20516124227554, ptol: 49.65640274258032 },
      reproducibility: { sd: 0.0058267158231494, sv: 0.0349602949388964, psv: 1.2004859502943088, ptol: 0.87400737347241 },
      operator: { sd: 0.0058267158231494, sv: 0.0349602949388964, psv: 1.2004859502943088, ptol: 0.87400737347241 },
      part: { sd: 0.3549001675735847, sv: 2.1294010054415082, psv: 73.12054987073293, ptol: 53.235025136037706 },
      total: { sd: 0.48536309997804916, sv: 2.912178599868295, psv: 100.0, ptol: 72.80446499670738 },
    },
  },
};

// ---------- 第 2 层:PPT 会话窗口截图转录值(按截图小数位舍入后全等) ----------

/** [key, SD, 6×SD, %SV, %Tol] —— 数字字符串保留截图原样小数位,用于推导舍入位数 */
type PptRow = [GageComponentKey, string, string, string, string];
const EXPECTED_PPT: Record<number, PptRow[]> = {
  1: [
    ['grr', '0.003651', '0.021909', '3.35', '2.19'],
    ['repeatability', '0.003651', '0.021909', '3.35', '2.19'],
    ['part', '0.109029', '0.654176', '99.94', '65.42'],
    ['total', '0.109091', '0.654543', '100.00', '65.45'],
  ],
  2: [
    ['grr', '2.2579', '13.548', '6.42', '17.23'],
    ['repeatability', '2.2579', '13.548', '6.42', '17.23'],
    ['part', '35.1055', '210.633', '99.79', '267.82'],
    ['total', '35.1780', '211.068', '100.00', '268.38'],
  ],
  3: [
    ['grr', '0.56206', '3.37233', '43.80', '112.41'],
    ['repeatability', '0.56206', '3.37233', '43.80', '112.41'],
    ['part', '1.15357', '6.92143', '89.90', '230.71'],
    ['total', '1.28321', '7.69928', '100.00', '256.64'],
  ],
  4: [
    ['grr', '0.041579', '0.24947', '10.51', '17.82'],
    ['repeatability', '0.039431', '0.23658', '9.97', '16.90'],
    ['reproducibility', '0.013190', '0.07914', '3.34', '5.65'],
    ['operator', '0.013190', '0.07914', '3.34', '5.65'],
    ['part', '0.393288', '2.35973', '99.45', '168.55'],
    ['total', '0.395480', '2.37288', '100.00', '169.49'],
  ],
  5: [
    ['grr', '0.331094', '1.98656', '68.22', '49.66'],
    ['repeatability', '0.331043', '1.98626', '68.21', '49.66'],
    ['reproducibility', '0.005827', '0.03496', '1.20', '0.87'],
    ['operator', '0.005827', '0.03496', '1.20', '0.87'],
    ['part', '0.354900', '2.12940', '73.12', '53.24'],
    ['total', '0.485363', '2.91218', '100.00', '72.80'],
  ],
};

const relClose = (actual: number, expected: number) => {
  const tolerance = 1e-9 * Math.max(Math.abs(expected), 1e-12);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

const roundTo = (value: number, decimals: number) => Number(value.toFixed(decimals));
const decimalsOf = (text: string) => (text.includes('.') ? text.split('.')[1].length : 0);

describe('MSA 工厂 5 案例黄金对拍(引擎高精度层,相对 1e-9)', () => {
  for (const [idText, hp] of Object.entries(EXPECTED_HP)) {
    const id = Number(idText);
    it(`案例${id}:全部方差分量行与独立复算逐项一致`, () => {
      const entry = CASES.get(id)!;
      const result = computeGageRR(entry.observations, hp.tol);
      relClose(result.grandMean, hp.grand);
      expect(result.ndc).toBe(hp.ndc);
      if (hp.interactionP == null) {
        expect(result.interaction).toBeNull();
        expect(result.operatorCount).toBe(1);
        expect(result.components.map((component) => component.key))
          .toEqual(['grr', 'repeatability', 'part', 'total']);
      } else {
        expect(result.interaction).not.toBeNull();
        relClose(result.interaction!.pValue, hp.interactionP);
        expect(result.interaction!.retained).toBe(false);
        expect(result.components.map((component) => component.key))
          .toEqual(['grr', 'repeatability', 'reproducibility', 'operator', 'part', 'total']);
      }
      for (const [key, row] of Object.entries(hp.components)) {
        const component = result.components.find((candidate) => candidate.key === key)!;
        expect(component).toBeDefined();
        relClose(component.sd, row.sd);
        relClose(component.studyVar, row.sv);
        relClose(component.pctStudyVar, row.psv);
        expect(component.pctTolerance).not.toBeNull();
        relClose(component.pctTolerance!, row.ptol);
      }
    });
  }
});

describe('MSA 工厂 5 案例黄金对拍(PPT 会话窗口舍入层)', () => {
  for (const [idText, rows] of Object.entries(EXPECTED_PPT)) {
    const id = Number(idText);
    it(`案例${id}:按截图小数位舍入后与 Minitab 输出逐位全等`, () => {
      const entry = CASES.get(id)!;
      const result = computeGageRR(entry.observations, EXPECTED_HP[id].tol);
      for (const [key, sdText, svText, psvText, ptolText] of rows) {
        const component = result.components.find((candidate) => candidate.key === key)!;
        expect(component).toBeDefined();
        expect(roundTo(component.sd, decimalsOf(sdText))).toBe(Number(sdText));
        expect(roundTo(component.studyVar, decimalsOf(svText))).toBe(Number(svText));
        expect(roundTo(component.pctStudyVar, decimalsOf(psvText))).toBe(Number(psvText));
        expect(roundTo(component.pctTolerance!, decimalsOf(ptolText))).toBe(Number(ptolText));
      }
    });
  }
});

describe('MSA 工厂 5 案例判定(工厂口径 ≤10 理想/≤20 可接受,%SV 与 %Tol 取较差)', () => {
  it('OK/NG 与工厂 PPT 结论一致:1/2/4 OK,3/5 NG', () => {
    for (const [idText, hp] of Object.entries(EXPECTED_HP)) {
      const entry = CASES.get(Number(idText))!;
      const result = computeGageRR(entry.observations, hp.tol);
      const assessment = assessGage(result, 'factory');
      expect(assessment.judgedOnTolerance).toBe(true);
      expect(assessment.grade !== 'bad').toBe(hp.factoryOk);
    }
  });
  it('案例4 双口径分歧:工厂=可接受(≤20),AIAG=临界(10–30)', () => {
    const entry = CASES.get(4)!;
    const result = computeGageRR(entry.observations, EXPECTED_HP[4].tol);
    expect(assessGage(result, 'factory').label).toBe('可接受');
    expect(assessGage(result, 'aiag').label).toBe('临界');
  });
  it('案例1 工厂=理想;案例3/5 两口径均不可接受', () => {
    const one = computeGageRR(CASES.get(1)!.observations, EXPECTED_HP[1].tol);
    expect(assessGage(one, 'factory').label).toBe('理想');
    for (const id of [3, 5]) {
      const result = computeGageRR(CASES.get(id)!.observations, EXPECTED_HP[id].tol);
      expect(assessGage(result, 'factory').label).toBe('不可接受');
      expect(assessGage(result, 'aiag').label).toBe('不可接受');
    }
  });
  it('无公差时工厂口径只按 %SV 判定并注明次要指标未计算', () => {
    const result = computeGageRR(CASES.get(1)!.observations, null);
    const assessment = assessGage(result, 'factory');
    expect(assessment.judgedOnTolerance).toBe(false);
    expect(assessment.grade).toBe('good');
    expect(assessment.detail).toContain('未提供过程公差');
  });
});

describe('单侧公差守卫与口径细节', () => {
  it('案例2 单侧分母 = USL − 总均值(39.32),系数 3 而非 6', () => {
    const entry = CASES.get(2)!;
    const result = computeGageRR(entry.observations, { mode: 'upper', value: 100 });
    const grr = result.components.find((component) => component.key === 'grr')!;
    relClose(grr.pctTolerance!, (3 * grr.sd) / (100 - result.grandMean) * 100);
    expect(result.toleranceNote).toBeNull();
  });
  it('总均值越过上限 → %公差全部 null 并给出说明,不输出负值/无穷', () => {
    const entry = CASES.get(2)!;
    const result = computeGageRR(entry.observations, { mode: 'upper', value: 50 }); // 均值 60.68 > 50
    expect(result.toleranceNote).toContain('已达到或越过公差上限');
    expect(result.components.every((component) => component.pctTolerance === null)).toBe(true);
  });
  it('大基值(1e9 量级)单侧公差不被守卫误伤:距离 0.5 正常计算(v1.40 对抗审查修复)', () => {
    const data: GageObservation[] = [];
    for (let part = 0; part < 3; part++) {
      for (let trial = 0; trial < 2; trial++) {
        data.push({ part, operator: 0, trial, value: 1e9 + part * 0.3 + trial * 0.2 });
      }
    }
    const base = computeGageRR(data, null);
    const result = computeGageRR(data, { mode: 'upper', value: base.grandMean + 0.5 });
    expect(result.toleranceNote).toBeNull();
    const grr = result.components.find((component) => component.key === 'grr')!;
    expect(grr.pctTolerance).not.toBeNull();
    relClose(grr.pctTolerance!, ((3 * grr.sd) / 0.5) * 100);
  });

  it('小基值(2e-9 量级)单侧公差同样正常计算,阈值无绝对量纲下限', () => {
    const data: GageObservation[] = [];
    for (let part = 0; part < 3; part++) {
      for (let trial = 0; trial < 2; trial++) {
        data.push({ part, operator: 0, trial, value: 2e-9 + part * 2e-10 + trial * 1e-11 });
      }
    }
    const base = computeGageRR(data, null);
    const result = computeGageRR(data, { mode: 'upper', value: base.grandMean * 1.2 });
    expect(result.toleranceNote).toBeNull();
    expect(result.components.find((component) => component.key === 'grr')!.pctTolerance).not.toBeNull();
  });

  it('距离为浮点噪声量级时说明「噪声量级」,不再谎称已越限', () => {
    const entry = CASES.get(2)!;
    const base = computeGageRR(entry.observations, null);
    const result = computeGageRR(entry.observations, { mode: 'upper', value: base.grandMean + 1e-13 });
    expect(result.toleranceNote).toContain('浮点噪声');
    expect(result.toleranceNote).not.toContain('已达到或越过');
    expect(result.components.every((component) => component.pctTolerance === null)).toBe(true);
  });

  it('P0 回归:均值越单侧限时工厂判定必须红色阻断「不能判定」,绝不退回绿色「理想」', () => {
    const entry = CASES.get(2)!;
    const rejected = computeGageRR(entry.observations, { mode: 'upper', value: 50 }); // 均值 60.68 > 50
    const factory = assessGage(rejected, 'factory');
    expect(factory.grade).toBe('bad');
    expect(factory.label).toBe('不能判定');
    expect(factory.label).not.toBe('理想');
    expect(factory.blocked).toBe(true);
    expect(factory.detail).toContain('规格状态异常');
    // 未提供公差是用户明确选择,仍按 %SV 单指标判定,不阻断
    const none = computeGageRR(entry.observations, null);
    const noneAssessment = assessGage(none, 'factory');
    expect(noneAssessment.detail).toContain('未提供过程公差');
    expect(noneAssessment.blocked).toBeUndefined();
  });

  it('computeGagePanelData 大重复数(200000)循环求极差不栈溢出', () => {
    const data: GageObservation[] = [];
    for (let part = 0; part < 2; part++) {
      for (let trial = 0; trial < 200000; trial++) {
        data.push({ part, operator: 0, trial, value: part + Math.sin(trial) * 0.01 });
      }
    }
    const panel = computeGagePanelData(data, null);
    expect(panel.cellRanges[0]).toHaveLength(2);
    expect(panel.cellRanges[0][0]).toBeGreaterThan(0.019);
    expect(panel.cellRanges[0][0]).toBeLessThanOrEqual(0.02);
  });

  it('下限口径对称:lower 用 均值−LSL;均值低于下限时同样拒绝', () => {
    const entry = CASES.get(2)!;
    const good = computeGageRR(entry.observations, { mode: 'lower', value: 20 });
    const grr = good.components.find((component) => component.key === 'grr')!;
    relClose(grr.pctTolerance!, (3 * grr.sd) / (good.grandMean - 20) * 100);
    const bad = computeGageRR(entry.observations, { mode: 'lower', value: 70 });
    expect(bad.toleranceNote).toContain('已达到或越过公差下限');
  });
});

describe('图形面板数据(4/6 联图共用纯计算)', () => {
  it('案例4:R̄ 与 D3/D4·R̄、X̄̄±A2·R̄ 控制限自洽(n=3)', () => {
    const entry = CASES.get(4)!;
    const constants = CONTROL_CONSTANTS[3];
    const panel = computeGagePanelData(entry.observations, constants);
    expect(panel.operatorCount).toBe(3);
    expect(panel.partCount).toBe(10);
    // R̄ 手工核对:所有 30 个胞极差的平均
    const allRanges = panel.cellRanges.flat();
    const rBar = allRanges.reduce((a, b) => a + b, 0) / allRanges.length;
    relClose(panel.rBar, rBar);
    relClose(panel.rLimits!.ucl, constants.D4 * rBar);
    expect(panel.rLimits!.lcl).toBe(0); // n=3 时 D3=0
    relClose(panel.xbarLimits!.cl, panel.grandMean);
    relClose(panel.xbarLimits!.ucl - panel.xbarLimits!.cl, constants.A2 * rBar);
  });
  it('案例1(单人):面板数据退化为 1 操作员组,均值/极差行数=部件数', () => {
    const entry = CASES.get(1)!;
    const panel = computeGagePanelData(entry.observations, CONTROL_CONSTANTS[3]);
    expect(panel.operatorCount).toBe(1);
    expect(panel.cellMeans).toHaveLength(1);
    expect(panel.cellMeans[0]).toHaveLength(10);
    relClose(panel.grandMean, EXPECTED_HP[1].grand);
  });
});
