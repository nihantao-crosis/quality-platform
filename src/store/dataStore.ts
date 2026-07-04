/**
 * 活动数据集 store — 变量模型 + 计数模型（P/C）+ 文本分组列。
 * localStorage 持久化：偏好由 appStore persist,数据集与最近列表在此维护。
 */
import { create } from 'zustand';
import {
  buildData, computeVarModel, computePChart, computeCChart,
  type VarModel, type PChartModel, type CChartModel, type TextColumn,
} from '../core';
import { useApp } from './appStore';
import { sessionLog } from './sessionLog';

const LS_DATASET = 'qp-dataset-v1';
const LS_RECENTS = 'qp-recents-v1';
const LS_ATTR = 'qp-attr-v1';
const MAX_RECENTS = 5;
const MAX_MES_SUBGROUPS = 200;

interface StoredDataset {
  name: string;
  colNames: string[];
  rows: number[][];
  textCols: TextColumn[];
  savedAt: string;
}

export interface RecentEntry {
  name: string;
  savedAt: string;
  data: StoredDataset;
}

const DEMO_COLS = ['直径1', '直径2', '直径3', '直径4', '直径5'];

function demoInit(): { model: VarModel; p: PChartModel; c: CChartModel } {
  const D = buildData();
  const model = computeVarModel('质检数据.mtw', DEMO_COLS, D.subs.map((s) => s.vals), {
    indivSeries: D.indiv,
    isDemo: true,
  });
  return {
    model,
    p: computePChart(D.pdef, D.pN, '演示 · 装配线不良', true),
    c: computeCChart(D.cdata, '演示 · 表面缺陷', true),
  };
}

function loadJson<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 存储满时静默失败 */
  }
}

interface DataState {
  model: VarModel;
  textCols: TextColumn[];
  pModel: PChartModel;
  cModel: CChartModel;
  recents: RecentEntry[];
  mesRunning: boolean;
  /** 编辑历史（撤销/重做,仅覆盖手工编辑） */
  undoStack: EditSnapshot[];
  redoStack: EditSnapshot[];
  importMatrix(name: string, colNames: string[], rows: number[][], textCols?: TextColumn[]): void;
  importCounts(kind: 'p' | 'c', name: string, counts: number[], sampleSize?: number): void;
  loadRecent(name: string): void;
  resetDemo(): void;
  /** 手工录入：编辑单元格 / 添加子组（复制末行） / 删除行。编辑演示集自动转「副本」。 */
  updateCell(row: number, col: number, value: number): void;
  addSubgroupRow(): void;
  deleteRow(row: number): void;
  undoEdit(): boolean;
  redoEdit(): boolean;
  /** 新建空白工作表（5 列 × 3 行种子值,手工录入起点） */
  newWorksheet(): void;
  /** 当前数据集另存为「xxx (副本)」并激活 */
  saveAsCopy(): string;
  /** 列 z-score 标准化 → 新数据集 */
  standardize(): string | null;
  /** 生成正态随机数据集 */
  generateRandom(mu: number, sigma: number, k: number, n: number): string;
  /** 按测量列排序（文本列同步重排） */
  sortBy(col: number, asc: boolean): void;
  /** MES 模拟：追加一个子组（首次调用前需 startMesDataset） */
  startMesDataset(n: number): void;
  appendSubgroup(vals: number[]): void;
  setMesRunning(v: boolean): void;
}

/** 依数据量级取合理的小数位 */
function roundTo(v: number, sd: number): number {
  const digits = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.max(sd, 1e-9)))));
  return Number(v.toFixed(digits));
}

/** 当前数据集的默认规格限：演示用原型规格,导入按 μ±4σ 建议 */
export function suggestedSpec(model: VarModel): { lsl: number; tgt: number; usl: number } {
  if (model.isDemo) return { lsl: 24.9, tgt: 25.0, usl: 25.1 };
  const { oMean, oSd } = model;
  return {
    tgt: roundTo(oMean, oSd),
    lsl: roundTo(oMean - 4 * oSd, oSd),
    usl: roundTo(oMean + 4 * oSd, oSd),
  };
}

const LS_SPECS = 'qp-specs-v1';
type SpecMap = Record<string, { lsl: number; tgt: number; usl: number }>;

/** 记住某数据集的规格限（Capability 页编辑时写入） */
export function rememberSpecFor(name: string, spec: { lsl: number; tgt: number; usl: number }) {
  const map = loadJson<SpecMap>(LS_SPECS) ?? {};
  map[name] = spec;
  saveJson(LS_SPECS, map);
}

/** 切换数据集时恢复其规格限;没有记忆则按 μ±4σ 建议 */
function suggestSpec(model: VarModel) {
  const saved = (loadJson<SpecMap>(LS_SPECS) ?? {})[model.name];
  useApp.setState({ ...(saved ?? suggestedSpec(model)), selSub: null });
}

// ---------- 启动恢复 ----------
const demo = demoInit();
const storedAttr = loadJson<{ p?: { name: string; counts: number[]; sampleSize: number }; c?: { name: string; counts: number[] } }>(LS_ATTR);
const stored = loadJson<StoredDataset>(LS_DATASET);

let initModel = demo.model;
let initText: TextColumn[] = [];
if (stored) {
  try {
    initModel = computeVarModel(stored.name, stored.colNames, stored.rows);
    initText = stored.textCols ?? [];
  } catch {
    initModel = demo.model;
  }
}
let initP = demo.p;
let initC = demo.c;
if (storedAttr?.p) {
  try {
    initP = computePChart(storedAttr.p.counts, storedAttr.p.sampleSize, storedAttr.p.name);
  } catch { /* 保留演示 */ }
}
if (storedAttr?.c) {
  try {
    initC = computeCChart(storedAttr.c.counts, storedAttr.c.name);
  } catch { /* 保留演示 */ }
}

function persistAttr(p: PChartModel, c: CChartModel) {
  saveJson(LS_ATTR, {
    p: p.isDemo ? undefined : { name: p.name, counts: p.pdef, sampleSize: p.pN },
    c: c.isDemo ? undefined : { name: c.name, counts: c.cdata },
  });
}

type SetFn = (partial: Partial<DataState>) => void;
type GetFn = () => DataState;

interface EditSnapshot {
  name: string;
  rows: number[][];
  textCols: TextColumn[];
}

const MAX_UNDO = 20;

function snapshotOf(st: DataState): EditSnapshot {
  return {
    name: st.model.name,
    rows: st.model.subs.map((s) => [...s.vals]),
    textCols: st.textCols.map((c) => ({ ...c, values: [...c.values] })),
  };
}

function restoreSnapshot(set: SetFn, snap: EditSnapshot, m: { colNames: string[] }) {
  const model = computeVarModel(snap.name, m.colNames, snap.rows);
  set({ model, textCols: snap.textCols });
  const data: StoredDataset = { name: snap.name, colNames: m.colNames, rows: snap.rows, textCols: snap.textCols, savedAt: new Date().toISOString() };
  saveJson(LS_DATASET, data);
}

/** 编辑落库：演示集首次编辑转「质检数据 (副本)」,导入集原名持久化并同步最近列表 */
function applyEdit(set: SetFn, get: GetFn, rows: number[][], textCols: TextColumn[]) {
  const st = get();
  const m = st.model;
  // 编辑前快照入撤销栈,清空重做栈
  set({
    undoStack: [...st.undoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
    redoStack: [],
  });
  const name = m.isDemo ? '质检数据 (副本)' : m.name;
  const model = computeVarModel(name, m.colNames, rows);
  const data: StoredDataset = { name, colNames: m.colNames, rows, textCols, savedAt: new Date().toISOString() };
  const recents = [
    { name, savedAt: data.savedAt, data },
    ...get().recents.filter((r) => r.name !== name),
  ].slice(0, MAX_RECENTS);
  set({ model, textCols, recents });
  saveJson(LS_DATASET, data);
  saveJson(LS_RECENTS, recents);
}

export const useData = create<DataState>((set, get) => ({
  model: initModel,
  textCols: initText,
  pModel: initP,
  cModel: initC,
  recents: loadJson<RecentEntry[]>(LS_RECENTS) ?? [],
  mesRunning: false,
  undoStack: [],
  redoStack: [],

  importMatrix: (name, colNames, rows, textCols = []) => {
    const model = computeVarModel(name, colNames, rows);
    const data: StoredDataset = { name, colNames, rows, textCols, savedAt: new Date().toISOString() };
    const recents = [
      { name, savedAt: data.savedAt, data },
      ...get().recents.filter((r) => r.name !== name),
    ].slice(0, MAX_RECENTS);
    set({ model, textCols, recents });
    saveJson(LS_DATASET, data);
    saveJson(LS_RECENTS, recents);
    suggestSpec(model);
    sessionLog(`导入变量数据 ${name} · ${rows.length} 子组 × ${colNames.length} 列`);
  },

  importCounts: (kind, name, counts, sampleSize = 50) => {
    if (kind === 'p') {
      const pModel = computePChart(counts, sampleSize, name);
      set({ pModel });
      persistAttr(pModel, get().cModel);
    } else {
      const cModel = computeCChart(counts, name);
      set({ cModel });
      persistAttr(get().pModel, cModel);
    }
    useApp.setState({ selSub: null, spcType: kind });
    sessionLog(`导入计数数据 ${name} · ${counts.length} 个${kind === 'p' ? '样本(P图)' : '单位(C图)'}`);
  },

  loadRecent: (name) => {
    const r = get().recents.find((x) => x.name === name);
    if (!r) return;
    const model = computeVarModel(r.data.name, r.data.colNames, r.data.rows);
    set({ model, textCols: r.data.textCols ?? [] });
    saveJson(LS_DATASET, r.data);
    suggestSpec(model);
    sessionLog(`加载最近数据集 ${name}`);
  },

  resetDemo: () => {
    const d = demoInit();
    set({ model: d.model, textCols: [], pModel: d.p, cModel: d.c, mesRunning: false });
    try {
      localStorage.removeItem(LS_DATASET);
      localStorage.removeItem(LS_ATTR);
    } catch { /* 非浏览器环境忽略 */ }
    suggestSpec(d.model);
    sessionLog('恢复演示数据集 质检数据.mtw');
  },

  updateCell: (row, col, value) => {
    if (!Number.isFinite(value)) return;
    const m = get().model;
    const rows = m.subs.map((s) => [...s.vals]);
    if (row < 0 || row >= rows.length || col < 0 || col >= m.n) return;
    rows[row][col] = value;
    applyEdit(set, get, rows, get().textCols);
  },

  addSubgroupRow: () => {
    const m = get().model;
    const rows = m.subs.map((s) => [...s.vals]);
    rows.push([...rows[rows.length - 1]]); // 复制末行,便于就地修改
    const textCols = get().textCols.map((c) => ({ ...c, values: [...c.values, c.values[c.values.length - 1] ?? ''] }));
    applyEdit(set, get, rows, textCols);
  },

  deleteRow: (row) => {
    const m = get().model;
    if (m.k <= 2) return; // 模型至少 2 行
    const rows = m.subs.map((s) => [...s.vals]);
    if (row < 0 || row >= rows.length) return;
    rows.splice(row, 1);
    const textCols = get().textCols.map((c) => {
      const values = [...c.values];
      values.splice(row, 1);
      return { ...c, values };
    });
    applyEdit(set, get, rows, textCols);
    useApp.setState({ selSub: null });
  },

  undoEdit: () => {
    const st = get();
    const snap = st.undoStack[st.undoStack.length - 1];
    if (!snap) return false;
    set({
      undoStack: st.undoStack.slice(0, -1),
      redoStack: [...st.redoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
    });
    restoreSnapshot(set, snap, st.model);
    sessionLog('撤销编辑');
    return true;
  },

  redoEdit: () => {
    const st = get();
    const snap = st.redoStack[st.redoStack.length - 1];
    if (!snap) return false;
    set({
      redoStack: st.redoStack.slice(0, -1),
      undoStack: [...st.undoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
    });
    restoreSnapshot(set, snap, st.model);
    sessionLog('重做编辑');
    return true;
  },

  newWorksheet: () => {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
    const name = `新建工作表_${stamp}`;
    const colNames = ['测量1', '测量2', '测量3', '测量4', '测量5'];
    const rows = Array.from({ length: 3 }, () =>
      Array.from({ length: 5 }, () => Number((10 + (Math.random() - 0.5) * 0.2).toFixed(3))),
    );
    get().importMatrix(name, colNames, rows);
    set({ undoStack: [], redoStack: [] });
  },

  saveAsCopy: () => {
    const m = get().model;
    const base = m.name.replace(/ \(副本\d*\)$/, '');
    const existing = get().recents.filter((r) => r.name.startsWith(base + ' (副本')).length;
    const name = `${base} (副本${existing > 0 ? existing + 1 : ''})`;
    get().importMatrix(name, m.colNames, m.subs.map((s) => [...s.vals]), get().textCols);
    return name;
  },

  standardize: () => {
    const m = get().model;
    // 各列 z = (x − x̄ⱼ)/sⱼ;列内无变异则拒绝
    const cols = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    const stats = cols.map((v) => {
      const mu = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length - 1));
      return { mu, sd };
    });
    if (stats.some((x) => x.sd === 0)) return null;
    const rows = m.subs.map((s) => s.vals.map((v, j) => Number(((v - stats[j].mu) / stats[j].sd).toFixed(4))));
    const name = m.name.replace(/\.[^.]+$/, '') + ' (标准化)';
    get().importMatrix(name, m.colNames.map((c) => c + '_z'), rows, get().textCols);
    return name;
  },

  generateRandom: (mu, sigma, k, n) => {
    const randn = () => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const digits = Math.max(0, Math.min(6, 3 - Math.floor(Math.log10(Math.max(sigma, 1e-9)))));
    const rows = Array.from({ length: k }, () =>
      Array.from({ length: n }, () => Number((mu + randn() * sigma).toFixed(digits))),
    );
    const name = `随机数据 N(${mu},${sigma})`;
    get().importMatrix(name, Array.from({ length: n }, (_, i) => `X${i + 1}`), rows);
    return name;
  },

  sortBy: (col, asc) => {
    const m = get().model;
    if (col < 0 || col >= m.n) return;
    const idx = m.subs.map((_, i) => i).sort((a, b) =>
      asc ? m.subs[a].vals[col] - m.subs[b].vals[col] : m.subs[b].vals[col] - m.subs[a].vals[col],
    );
    const rows = idx.map((i) => [...m.subs[i].vals]);
    const textCols = get().textCols.map((c) => ({ ...c, values: idx.map((i) => c.values[i]) }));
    applyEdit(set, get, rows, textCols);
    sessionLog(`按「${m.colNames[col]}」${asc ? '升序' : '降序'}排序`);
  },

  startMesDataset: (n) => {
    // 以两个种子子组起步（模型要求 ≥2 行）
    const seedRows = [
      Array.from({ length: n }, () => 25 + (Math.random() - 0.5) * 0.05),
      Array.from({ length: n }, () => 25 + (Math.random() - 0.5) * 0.05),
    ];
    const colNames = Array.from({ length: n }, (_, i) => `测点${i + 1}`);
    const model = computeVarModel('MES 实时采集', colNames, seedRows);
    set({ model, textCols: [] });
    suggestSpec(model);
  },

  appendSubgroup: (vals) => {
    const m = get().model;
    if (m.subs.length >= MAX_MES_SUBGROUPS) {
      set({ mesRunning: false });
      return;
    }
    const rows = [...m.subs.map((s) => s.vals), vals];
    const model = computeVarModel(m.name, m.colNames, rows);
    set({ model });
  },

  setMesRunning: (mesRunning) => set({ mesRunning }),
}));
