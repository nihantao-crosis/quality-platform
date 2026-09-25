/**
 * SPC 页「检验结果」的有界明细视图(GAP-10-23)。
 *
 * 旧实现每次渲染把主图与离散图的全部判异窗口展开成「点×准则」对象(20 万行漂移数据
 * 约 43–63 万条),排序、去重后只显示前 12 条。这里改用引擎已有的
 * pointRuleDetailLimit 有界通道:每张图只物化按 (点号, 准则) 排序的前 N 条,
 * 同时由 PointRuleSummary 给出完整的命中总数 / 按准则计数;受影响点数直接由
 * 各图的 viol 集合求并得到。窗口型准则在 viol/有界统计中本就逐点标记,与
 * expandSpcRuleItems 的窗口展开是同一「点×准则」集合,故计数、前 N 条与结论卡
 * 均与旧的全量展开逐项一致(fix2609c_perf 测试对拍)。
 */
import type { PointRuleSummary, RuleNo, SpcViolationItem } from '../../core';

/** SPC 页右侧「检验结果」列表显示的明细条数。 */
export const SPC_PAGE_DETAIL_ROWS = 12;

export interface SpcChartViolations {
  chartLabel: string;
  /** 图上实际标红的点(该图自身索引)。 */
  viol: ReadonlySet<number>;
  /** 引擎有界统计(pointRuleDetailLimit 模式)。 */
  summary: PointRuleSummary;
  /** 映射回原观测索引的偏移(I-MR 的 MR 图为 1)。 */
  indexOffset?: number;
  /** 明细文字前缀(离散图为「R 图：」等)。 */
  descPrefix?: string;
}

export interface SpcViolationCounts {
  pointRuleHitCount: number;
  affectedPointCount: number;
  byRule: Partial<Record<number, number>>;
}

export interface SpcViolationView extends SpcViolationCounts {
  /** 主图 + 离散图合并后的前 limit 条,排序与旧 allViolItems 相同。 */
  items: SpcViolationItem[];
  /** 仅离散图的前 limit 条与完整统计(供「先判离散图」与报告)。 */
  variationItems: SpcViolationItem[];
  variation: SpcViolationCounts;
  /** 原观测索引 i 是否为失控点(主图或任一离散图)。 */
  isViolationPoint: (index: number) => boolean;
}

const compareItems = (a: SpcViolationItem, b: SpcViolationItem) =>
  a.i - b.i || a.chartLabel.localeCompare(b.chartLabel) || a.rule - b.rule;

/**
 * EWMA/CUSUM 等只有「超限点」的图:每个标红点一条准则 1 明细。
 * 只挑出最小的 limit 个点号(O(v·limit)),不对整个集合排序。
 */
export function singlePointSummary(viol: ReadonlySet<number>, desc: string, limit = SPC_PAGE_DETAIL_ROWS): PointRuleSummary {
  const smallest: number[] = [];
  if (limit > 0) {
    for (const index of viol) {
      if (smallest.length === limit && index >= smallest[limit - 1]) continue;
      let at = smallest.length;
      while (at > 0 && smallest[at - 1] > index) at--;
      smallest.splice(at, 0, index);
      if (smallest.length > limit) smallest.pop();
    }
  }
  return {
    items: smallest.map((i) => ({ i, rule: 1 as RuleNo, desc })),
    total: viol.size,
    affectedCount: viol.size,
    byRule: viol.size ? { 1: viol.size } : {},
    truncated: viol.size > smallest.length,
  };
}

function boundedItems(source: SpcChartViolations): SpcViolationItem[] {
  const offset = source.indexOffset ?? 0;
  const prefix = source.descPrefix ?? '';
  return source.summary.items.map((item) => ({
    i: item.i + offset,
    rule: item.rule,
    desc: prefix + item.desc,
    chartLabel: source.chartLabel,
  }));
}

function addByRule(target: Partial<Record<number, number>>, source: SpcChartViolations) {
  for (const [rawRule, count] of Object.entries(source.summary.byRule)) {
    if (count == null) continue;
    const rule = Number(rawRule);
    target[rule] = (target[rule] ?? 0) + count;
  }
}

/** 离散图各自索引映射回原观测后,不在 exclude 中的去重点数。 */
function countShiftedPoints(sources: SpcChartViolations[], exclude?: ReadonlySet<number>): number {
  if (sources.length === 1 && !exclude) return sources[0].viol.size;
  const seen = sources.length > 1 ? new Set<number>() : null;
  let count = 0;
  for (const source of sources) {
    const offset = source.indexOffset ?? 0;
    for (const index of source.viol) {
      const original = index + offset;
      if (exclude?.has(original)) continue;
      if (seen) {
        if (seen.has(original)) continue;
        seen.add(original);
      }
      count++;
    }
  }
  return count;
}

export function buildSpcViolationView(
  main: SpcChartViolations,
  variation: SpcChartViolations[],
  limit = SPC_PAGE_DETAIL_ROWS,
): SpcViolationView {
  const variationItems = variation.flatMap(boundedItems).sort(compareItems).slice(0, limit);
  const items = [...boundedItems(main), ...variationItems].sort(compareItems).slice(0, limit);
  const variationByRule: Partial<Record<number, number>> = {};
  let variationHits = 0;
  for (const source of variation) {
    addByRule(variationByRule, source);
    variationHits += source.summary.total;
  }
  const byRule: Partial<Record<number, number>> = {};
  addByRule(byRule, main);
  for (const source of variation) addByRule(byRule, source);
  const mainOffset = main.indexOffset ?? 0;
  const mainPoints: ReadonlySet<number> = mainOffset === 0
    ? main.viol
    : new Set([...main.viol].map((index) => index + mainOffset));
  const variationPointCount = variation.length ? countShiftedPoints(variation) : 0;
  const affectedPointCount = mainPoints.size + (variation.length ? countShiftedPoints(variation, mainPoints) : 0);
  return {
    items,
    pointRuleHitCount: main.summary.total + variationHits,
    affectedPointCount,
    byRule,
    variationItems,
    variation: {
      pointRuleHitCount: variationHits,
      affectedPointCount: variationPointCount,
      byRule: variationByRule,
    },
    isViolationPoint: (index) => mainPoints.has(index)
      || variation.some((source) => source.viol.has(index - (source.indexOffset ?? 0))),
  };
}
