/**
 * 分析记录 — Minitab 式「项目工作台」骨架。
 * 每次「保存到项目」把当前分析连同其参数与所属数据集存为一条对象,
 * 可在仪表盘 / 项目管理器回看(切回数据集 + 还原参数 + 跳页),可删除,纳入 .qproj 备份。
 */
import { create } from 'zustand';
import {
  nf, computeCapability, evalRules, computeGageRR, gageStudyData, GAGE_TOLERANCE,
  oneWayAnova, anovaGroups, analyzeDoe, detectFactorial, analyzeFactorial, resolveDoeColumns, aqlPlan, computeDescriptive, type InspectionLevel,
} from '../core';
import { useApp, type SpcType, type DoeView, type HypoTab, type ParetoView } from './appStore';
import { useData } from './dataStore';
import { sessionLog } from './sessionLog';

export type AnalysisKind = 'spc' | 'capability' | 'gagerr' | 'anova' | 'pareto' | 'doe' | 'aql' | 'summary';

export interface AnalysisSnapshot {
  spcType?: SpcType;
  lsl?: number; usl?: number; tgt?: number; lslOn?: boolean; uslOn?: boolean;
  aqlLot?: number; aqlLevel?: InspectionLevel; aqlAQL?: number;
  doeView?: DoeView; hypoTab?: HypoTab; paretoView?: ParetoView;
}

export interface SavedAnalysis {
  id: string;
  kind: AnalysisKind;
  title: string;
  datasetName: string;
  metric: string;
  status: string;
  statusColor: string;
  statusBg: string;
  createdAt: number;
  snapshot: AnalysisSnapshot;
}

const LS_KEY = 'qp-analyses-v1';
const MAX_SAVED = 40;

const OK = { color: '#2c8a45', bg: '#e8f4ea' };
const WARN = { color: '#e0902a', bg: '#fcf3e3' };
const BAD = { color: '#c22f2f', bg: '#fdecec' };
const INFO = { color: '#1f6fb2', bg: '#e7f0f9' };

const SPC_TITLE: Record<SpcType, string> = {
  'xbar-r': 'X̄-R 控制图', 'xbar-s': 'X̄-S 控制图', 'i-mr': 'I-MR 控制图',
  ewma: 'EWMA 控制图', cusum: 'CUSUM 控制图', p: 'P 控制图', c: 'C 控制图',
};

const HYPO_TITLE: Record<HypoTab, string> = {
  anova: '单因子 ANOVA', t1: '单样本 t 检验', t2: '双样本 t 检验', reg: '相关与回归',
};

/** 依当前页 + 数据集 + 参数,生成一条分析记录（不入栈,仅计算摘要） */
function buildSummary(kind: AnalysisKind): Omit<SavedAnalysis, 'id' | 'createdAt' | 'datasetName' | 'snapshot'> | null {
  const app = useApp.getState();
  const { model: M, pModel, cModel } = useData.getState();
  switch (kind) {
    case 'spc': {
      if (app.spcType === 'p') {
        return { kind, title: SPC_TITLE.p, metric: `p̄ ${nf(pModel.pbar, 3)}`, status: '控制图', ...pick(INFO) };
      }
      if (app.spcType === 'c') {
        return { kind, title: SPC_TITLE.c, metric: `c̄ ${nf(cModel.cbar, 2)}`, status: '控制图', ...pick(INFO) };
      }
      const means = M.subs.map((s) => s.mean);
      const sig = (M.uclX - M.xbarbar) / 3;
      const { list } = evalRules(means, M.xbarbar, sig, app.spcRules);
      const n = list.length;
      return {
        kind, title: SPC_TITLE[app.spcType],
        metric: n > 0 ? `${n} 失控点` : '过程受控',
        status: n > 0 ? '需关注' : '受控', ...pick(n > 0 ? BAD : OK),
      };
    }
    case 'capability': {
      const cap = computeCapability(M.all, M.sigmaWithin, {
        lsl: app.lslOn ? app.lsl : null, tgt: app.tgt, usl: app.uslOn ? app.usl : null,
      });
      const good = cap.verdict === 'sufficient';
      const mid = cap.verdict === 'marginal';
      return {
        kind, title: '过程能力分析', metric: `Cpk ${nf(cap.cpk, 2)}`,
        status: good ? '能力充足' : mid ? '能力临界' : '能力不足', ...pick(good ? OK : mid ? WARN : BAD),
      };
    }
    case 'gagerr': {
      const g = computeGageRR(gageStudyData(), GAGE_TOLERANCE);
      const ok = g.verdict === 'acceptable';
      return {
        kind, title: '测量系统分析 Gage R&R', metric: `GRR ${nf(g.totalGageRR, 1)}%`,
        status: ok ? '可接受' : g.verdict === 'marginal' ? '临界' : '不可接受', ...pick(ok ? OK : WARN),
      };
    }
    case 'anova': {
      const tab = app.hypoTab;
      if (tab === 'anova') {
        // 与 ANOVA 页默认模式一致:出厂演示集→演示;有文本分组列按首列分组;否则宽表(各数值列一组)
        const { textCols } = useData.getState();
        let groups: number[][] | null = null;
        if (M.isDemo) {
          groups = anovaGroups().map((x) => x.vals);
        } else if (textCols.length >= 1 && M.colNames.length >= 1) {
          const byLabel = new Map<string, number[]>();
          textCols[0].values.forEach((l, i) => {
            if (!byLabel.has(l)) byLabel.set(l, []);
            byLabel.get(l)!.push(M.subs[i].vals[0]);
          });
          const gs = [...byLabel.values()];
          if (gs.length >= 2 && gs.every((g) => g.length >= 2)) groups = gs;
        }
        if (!groups && M.colNames.length >= 2 && M.k >= 2) {
          groups = M.colNames.map((_, j) => M.subs.map((sub) => sub.vals[j]));
        }
        try {
          const a = oneWayAnova(groups ?? anovaGroups().map((x) => x.vals));
          return {
            kind, title: HYPO_TITLE.anova, metric: `P ${nf(a.pValue, 3)}`,
            status: a.significant ? '显著' : '不显著', ...pick(a.significant ? INFO : OK),
          };
        } catch {
          return { kind, title: HYPO_TITLE.anova, metric: '数据不足', status: '未分析', ...pick(WARN) };
        }
      }
      return { kind, title: HYPO_TITLE[tab], metric: '假设检验', status: '已分析', ...pick(INFO) };
    }
    case 'pareto': {
      if (app.paretoView === 'fishbone') {
        return { kind, title: '因果图（鱼骨图）', metric: '6M 分析', status: '已分析', ...pick(INFO) };
      }
      const pm = useData.getState().paretoModel;
      if (!pm || pm.rows.length === 0) {
        return { kind, title: '帕累托图 · 缺陷分析', metric: '示例数据', status: '演示', ...pick(INFO) };
      }
      const sorted = [...pm.rows].sort((a, b) => b.count - a.count);
      const total = sorted.reduce((a, r) => a + r.count, 0) || 1;
      const topN = Math.min(2, sorted.length);
      const pct = Math.round((sorted.slice(0, topN).reduce((a, r) => a + r.count, 0) / total) * 100);
      return { kind, title: `帕累托图 · ${pm.name}`, metric: `Top${topN} = ${pct}%`, status: '已分析', ...pick(OK) };
    }
    case 'doe': {
      if (M.isDemo) {
        const r = analyzeDoe();
        const sig = r.terms.filter((t) => t.sig).map((t) => t.name.split(' ')[0]);
        return {
          kind, title: '实验设计 · 2³ 全因子(示例)', metric: sig.length ? `${sig.join('、')} 显著` : '无显著项',
          status: '演示', ...pick(INFO),
        };
      }
      // 真实数据:与 DOE 分析页共用 resolveDoeColumns(同一选择/同一 4 因子上限),
      // 保证「保存到项目的汇总卡」与分析页所见一致,避免页面出结果而卡片显示未分析。
      const nc = M.colNames.length;
      if (nc >= 3) {
        const { factorIdx, respIdx } = resolveDoeColumns(M.colNames, app.doeFactorCols, app.doeRespCol);
        const facs = factorIdx.map((i) => ({ name: M.colNames[i], values: M.subs.map((s) => s.vals[i]) }));
        const resp = M.subs.map((s) => s.vals[respIdx]);
        const det = detectFactorial(facs, resp);
        if (det.ok) {
          const fr = analyzeFactorial(det.design);
          const sig = fr.terms.filter((t) => t.sig).map((t) => t.name);
          return {
            kind, title: `实验设计 · ${det.design.factorNames.length} 因子`,
            metric: sig.length ? `${sig.slice(0, 3).join('、')} 显著` : '无显著项',
            status: '已分析', ...pick(INFO),
          };
        }
      }
      return { kind, title: '实验设计 (DOE)', metric: '数据非因子设计', status: '未分析', ...pick(WARN) };
    }
    case 'aql': {
      const plan = aqlPlan(app.aqlLot, app.aqlLevel, app.aqlAQL);
      return {
        kind, title: '抽样检验 · AQL 方案', metric: `n=${plan.n} Ac=${plan.ac}`,
        status: '已生成', ...pick(INFO),
      };
    }
    case 'summary': {
      const d = computeDescriptive(M.all);
      return {
        kind, title: '描述性统计 · 图形化摘要',
        metric: `x̄ ${nf(d.mean, 3)} · s ${nf(d.stdev, 3)}`,
        status: !d.adAvailable ? '已汇总' : d.ad.normal ? '正态' : '非正态',
        ...pick(!d.adAvailable ? INFO : d.ad.normal ? OK : WARN),
      };
    }
    default:
      return null;
  }
}

function pick(c: { color: string; bg: string }) {
  return { statusColor: c.color, statusBg: c.bg };
}

function snapshotOf(kind: AnalysisKind): AnalysisSnapshot {
  const a = useApp.getState();
  const snap: AnalysisSnapshot = {};
  if (kind === 'spc') snap.spcType = a.spcType;
  if (kind === 'capability') { snap.lsl = a.lsl; snap.usl = a.usl; snap.tgt = a.tgt; snap.lslOn = a.lslOn; snap.uslOn = a.uslOn; }
  if (kind === 'aql') { snap.aqlLot = a.aqlLot; snap.aqlLevel = a.aqlLevel; snap.aqlAQL = a.aqlAQL; }
  if (kind === 'doe') snap.doeView = a.doeView;
  if (kind === 'anova') snap.hypoTab = a.hypoTab;
  if (kind === 'pareto') snap.paretoView = a.paretoView;
  return snap;
}

function load(): SavedAnalysis[] {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? (JSON.parse(s) as SavedAnalysis[]) : [];
  } catch {
    return [];
  }
}

function persist(saved: SavedAnalysis[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(saved));
  } catch { /* 超限由 dataStore.saveJson 已统一提示 */ }
}

const ANALYSIS_PAGES: AnalysisKind[] = ['spc', 'capability', 'gagerr', 'anova', 'pareto', 'doe', 'aql', 'summary'];

interface AnalysesState {
  saved: SavedAnalysis[];
  /** 保存当前页的分析为一条记录;非分析页返回 null */
  saveCurrent(): SavedAnalysis | null;
  remove(id: string): void;
  restore(id: string): void;
}

export const useAnalyses = create<AnalysesState>((set, get) => ({
  saved: load(),

  saveCurrent: () => {
    const page = useApp.getState().page;
    if (!ANALYSIS_PAGES.includes(page as AnalysisKind)) return null;
    const kind = page as AnalysisKind;
    const summary = buildSummary(kind);
    if (!summary) return null;
    const entry: SavedAnalysis = {
      ...summary,
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: Date.now(),
      datasetName: useData.getState().model.name,
      snapshot: snapshotOf(kind),
    };
    const saved = [entry, ...get().saved].slice(0, MAX_SAVED);
    set({ saved });
    persist(saved);
    sessionLog(`保存分析 ${entry.title} · ${entry.metric} · 数据集 ${entry.datasetName}`);
    return entry;
  },

  remove: (id) => {
    const saved = get().saved.filter((a) => a.id !== id);
    set({ saved });
    persist(saved);
  },

  restore: (id) => {
    const a = get().saved.find((x) => x.id === id);
    if (!a) return;
    // 切回记录所属的数据集（若在最近列表）
    if (a.datasetName !== useData.getState().model.name) {
      const rec = useData.getState().recents.find((r) => r.name === a.datasetName);
      if (rec) useData.getState().loadRecent(a.datasetName);
    }
    // 还原分析参数
    const s = a.snapshot;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (v !== undefined) patch[k] = v;
    useApp.setState(patch);
    if (s.hypoTab) useApp.getState().setHypoTab(s.hypoTab);
    if (s.paretoView) useApp.getState().setParetoView(s.paretoView);
    if (s.doeView) useApp.getState().setDoeView(s.doeView);
    useApp.getState().goTo(a.kind);
    sessionLog(`回看分析 ${a.title} · 数据集 ${a.datasetName}`);
  },
}));

/** .qproj 恢复后重新加载分析记录（供 reload 前调用无意义,reload 会重建;此处供测试/内部） */
export function reloadAnalyses() {
  useAnalyses.setState({ saved: load() });
}
