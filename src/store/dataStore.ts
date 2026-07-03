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
  importMatrix(name: string, colNames: string[], rows: number[][], textCols?: TextColumn[]): void;
  importCounts(kind: 'p' | 'c', name: string, counts: number[], sampleSize?: number): void;
  loadRecent(name: string): void;
  resetDemo(): void;
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

function suggestSpec(model: VarModel) {
  useApp.setState({ ...suggestedSpec(model), selSub: null });
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

export const useData = create<DataState>((set, get) => ({
  model: initModel,
  textCols: initText,
  pModel: initP,
  cModel: initC,
  recents: loadJson<RecentEntry[]>(LS_RECENTS) ?? [],
  mesRunning: false,

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
  },

  loadRecent: (name) => {
    const r = get().recents.find((x) => x.name === name);
    if (!r) return;
    const model = computeVarModel(r.data.name, r.data.colNames, r.data.rows);
    set({ model, textCols: r.data.textCols ?? [] });
    saveJson(LS_DATASET, r.data);
    suggestSpec(model);
  },

  resetDemo: () => {
    const d = demoInit();
    set({ model: d.model, textCols: [], pModel: d.p, cModel: d.c, mesRunning: false });
    localStorage.removeItem(LS_DATASET);
    localStorage.removeItem(LS_ATTR);
    suggestSpec(d.model);
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
