/**
 * 活动数据集 store — 变量模型 + 计数模型（P/C）+ 文本分组列。
 * localStorage 持久化：偏好由 appStore persist,数据集与最近列表在此维护。
 */
import { create } from 'zustand';
import {
  buildData, computeVarModel, computePChart, computeCChart, evalFormula, truthy, FormulaError,
  type VarModel, type PChartModel, type CChartModel, type TextColumn,
} from '../core';
import { useApp } from './appStore';
import { sessionLog } from './sessionLog';
import { platform } from '../platform/adapter';

const LS_DATASET = 'qp-dataset-v1';
const LS_RECENTS = 'qp-recents-v1';
const LS_ATTR = 'qp-attr-v1';
/** 活动数据集超出 localStorage 配额时的恢复标记(桌面端,数据在 SQLite 库中) */
const LS_ACTIVE_REF = 'qp-active-ref-v1';
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
  /** 完整数据。桌面端条目过大导致配额超限时持久化为轻量条目(数据在 SQLite 库),加载时回落。 */
  data?: StoredDataset;
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

let storageWarned = false;
function saveJson(key: string, v: unknown, silent = false): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    storageWarned = false;
    return true;
  } catch {
    // 存储超限(浏览器 localStorage 通常约 5MB)：应用继续在内存工作。
    // silent=true 时由调用方接管提示(桌面端会转投 SQLite 数据集库)。
    if (!silent && !storageWarned) {
      storageWarned = true;
      sessionLog('本地存储写入失败(可能超限)· 数据仍在内存,建议 保存到项目 导出文件');
      try {
        useApp.getState().showToast('本地存储已满,本次未自动保存;请用「保存到项目」导出为文件');
      } catch { /* 非浏览器环境忽略 */ }
    }
    return false;
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
  /** 从最近列表移除（不影响当前数据集） */
  removeRecent(name: string): void;
  /** 重命名测量列（col 为测量列索引 0-based） */
  renameColumn(col: number, name: string): void;
  /** 删除测量列（至少保留 1 列） */
  deleteColumn(col: number): void;
  /** 在末尾插入测量列（值默认取各行首列的副本,便于随后编辑） */
  insertColumn(): void;
  /** 用公式(引用 C1../列名)算出一列并追加;成功返回 null,失败返回错误信息 */
  addFormulaColumn(name: string, expr: string): string | null;
  /** 按条件表达式(如 C1>25 and C2<=25.1)筛出子集为新数据集 */
  subsetByCondition(cond: string): { ok: true; name: string; kept: number; total: number } | { ok: false; error: string };
  /** 转置：k×n → n×k,生成新数据集「xxx (转置)」 */
  transposeDataset(): void;
  /** 堆叠：多测量列堆成单列 + 「来源列」分组标签,生成新数据集「xxx (堆叠)」 */
  stackColumns(): void;
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
  colNames: string[];
  rows: number[][];
  textCols: TextColumn[];
}

const MAX_UNDO = 20;

function snapshotOf(st: DataState): EditSnapshot {
  return {
    name: st.model.name,
    colNames: [...st.model.colNames],
    rows: st.model.subs.map((s) => [...s.vals]),
    textCols: st.textCols.map((c) => ({ ...c, values: [...c.values] })),
  };
}

function restoreSnapshot(set: SetFn, snap: EditSnapshot) {
  const model = computeVarModel(snap.name, snap.colNames, snap.rows);
  set({ model, textCols: snap.textCols });
  const data: StoredDataset = { name: snap.name, colNames: snap.colNames, rows: snap.rows, textCols: snap.textCols, savedAt: new Date().toISOString() };
  persistActive(data);
}

/** 桌面端把数据集镜像归档到本机 SQLite 数据集库(不受 localStorage 配额限制)。
 * 400ms 尾随防抖,连续编辑只落一次;Web 端 datasetDb 为 null,静默跳过。 */
const vaultTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function archiveToVault(data: StoredDataset) {
  const db = platform.datasetDb;
  if (!db) return;
  const prev = vaultTimers.get(data.name);
  if (prev) clearTimeout(prev);
  vaultTimers.set(data.name, setTimeout(() => {
    vaultTimers.delete(data.name);
    db.put(data.name, JSON.stringify(data)).catch(() => { /* 归档失败不打断编辑 */ });
  }, 400));
}

/** 活动数据集落盘。localStorage 写不下时(超 ~5MB):桌面端即时归档到 SQLite
 * 并留恢复标记(重启自动恢复),Web 端沿用原有超限提示。 */
function persistActive(data: StoredDataset) {
  const db = platform.datasetDb;
  if (saveJson(LS_DATASET, data, db != null)) {
    try { localStorage.removeItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
    return;
  }
  if (!db) return; // Web 端:saveJson 已提示
  try { localStorage.setItem(LS_ACTIVE_REF, data.name); } catch { /* 标记写不进也不致命 */ }
  const prev = vaultTimers.get(data.name); // 绕过防抖,立即归档,避免窗口期丢数据
  if (prev) { clearTimeout(prev); vaultTimers.delete(data.name); }
  db.put(data.name, JSON.stringify(data)).then(() => {
    sessionLog(`数据集 ${data.name} 超浏览器配额,已存入本机数据集库(重启自动恢复)`);
    try {
      useApp.getState().showToast('数据集超出浏览器存储配额,已安全存入本机数据集库,重启自动恢复');
    } catch { /* 非浏览器环境忽略 */ }
  }).catch(() => {
    try { useApp.getState().showToast('数据集过大且归档失败,请用「保存到项目」导出为文件'); } catch { /* 忽略 */ }
  });
}

/** 最近列表落盘。写不下时桌面端把条目瘦身(仅名称/时间,数据在 SQLite 库)再写一次。 */
function persistRecents(recents: RecentEntry[]) {
  const db = platform.datasetDb;
  if (saveJson(LS_RECENTS, recents, db != null)) return;
  if (!db) return;
  const light = recents.map((r) => ({ name: r.name, savedAt: r.savedAt }));
  saveJson(LS_RECENTS, light, true);
}

/** 编辑落库：演示集首次编辑转「质检数据 (副本)」,导入集原名持久化并同步最近列表。
 * colNames 省略时沿用当前列名（值编辑）;传入时用于列结构变化（重命名/增删列）。 */
function applyEdit(set: SetFn, get: GetFn, rows: number[][], textCols: TextColumn[], colNames?: string[]) {
  const st = get();
  const m = st.model;
  // 编辑前快照入撤销栈,清空重做栈
  set({
    undoStack: [...st.undoStack.slice(-(MAX_UNDO - 1)), snapshotOf(st)],
    redoStack: [],
  });
  const cols = colNames ?? m.colNames;
  const name = m.isDemo ? '质检数据 (副本)' : m.name;
  const model = computeVarModel(name, cols, rows);
  const data: StoredDataset = { name, colNames: cols, rows, textCols, savedAt: new Date().toISOString() };
  const recents = [
    { name, savedAt: data.savedAt, data },
    ...get().recents.filter((r) => r.name !== name),
  ].slice(0, MAX_RECENTS);
  set({ model, textCols, recents });
  persistActive(data);
  persistRecents(recents);
  archiveToVault(data);
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
    persistActive(data);
    persistRecents(recents);
    archiveToVault(data);
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
    if (r?.data) {
      const model = computeVarModel(r.data.name, r.data.colNames, r.data.rows);
      set({ model, textCols: r.data.textCols ?? [] });
      persistActive(r.data);
      suggestSpec(model);
      sessionLog(`加载最近数据集 ${name}`);
      return;
    }
    // 条目缺失或为轻量条目(数据超配额只存在库中)时,桌面端回落本机 SQLite 数据集库
    platform.datasetDb?.get(name).then((json) => {
      if (!json) return;
      const data = JSON.parse(json) as StoredDataset;
      const model = computeVarModel(data.name, data.colNames, data.rows);
      set({ model, textCols: data.textCols ?? [] });
      persistActive(data);
      suggestSpec(model);
      sessionLog(`从数据集库加载 ${name}`);
    }).catch(() => { /* 库中无此集或读取失败,静默 */ });
  },

  resetDemo: () => {
    const d = demoInit();
    set({ model: d.model, textCols: [], pModel: d.p, cModel: d.c, mesRunning: false });
    try {
      localStorage.removeItem(LS_DATASET);
      localStorage.removeItem(LS_ATTR);
      localStorage.removeItem(LS_ACTIVE_REF);
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
    restoreSnapshot(set, snap);
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
    restoreSnapshot(set, snap);
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

  removeRecent: (name) => {
    const recents = get().recents.filter((r) => r.name !== name);
    set({ recents });
    saveJson(LS_RECENTS, recents);
  },

  renameColumn: (col, name) => {
    const m = get().model;
    const clean = name.trim();
    if (col < 0 || col >= m.n || clean === '' || clean === m.colNames[col]) return;
    const colNames = m.colNames.map((c, i) => (i === col ? clean : c));
    applyEdit(set, get, m.subs.map((s) => [...s.vals]), get().textCols, colNames);
  },

  deleteColumn: (col) => {
    const m = get().model;
    if (m.n <= 1) return; // 至少保留 1 个测量列
    if (col < 0 || col >= m.n) return;
    const colNames = m.colNames.filter((_, i) => i !== col);
    const rows = m.subs.map((s) => s.vals.filter((_, i) => i !== col));
    applyEdit(set, get, rows, get().textCols, colNames);
    useApp.setState({ selSub: null });
  },

  insertColumn: () => {
    const m = get().model;
    if (m.n >= 10) return; // 控制图常数表上限
    const colNames = [...m.colNames, `测量${m.n + 1}`];
    const rows = m.subs.map((s) => [...s.vals, s.vals[s.vals.length - 1]]);
    applyEdit(set, get, rows, get().textCols, colNames);
  },

  addFormulaColumn: (name, expr) => {
    const m = get().model;
    if (m.n >= 10) return '测量列已达上限（10 列），无法再添加';
    const clean = name.trim() || `公式${m.n + 1}`;
    const columns = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    let values: number[];
    try {
      values = evalFormula(expr, { columns, colNames: m.colNames, rowCount: m.k }).values;
    } catch (e) {
      return e instanceof FormulaError ? e.message : '公式计算失败：' + (e as Error).message;
    }
    if (values.every((v) => !Number.isFinite(v))) return '公式在所有行上都算不出有限值,请检查表达式';
    // 保留精度但落成有限值(除零等 → 0),模型要求有限数
    const safe = values.map((v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : 0));
    const colNames = [...m.colNames, clean];
    const rows = m.subs.map((s, i) => [...s.vals, safe[i]]);
    applyEdit(set, get, rows, get().textCols, colNames);
    sessionLog(`新增公式列「${clean}」= ${expr.trim()}`);
    return null;
  },

  subsetByCondition: (cond) => {
    const m = get().model;
    const columns = m.colNames.map((_, j) => m.subs.map((s) => s.vals[j]));
    let flags: number[];
    try {
      flags = evalFormula(cond, { columns, colNames: m.colNames, rowCount: m.k }).values;
    } catch (e) {
      return { ok: false, error: e instanceof FormulaError ? e.message : '条件计算失败：' + (e as Error).message };
    }
    const keep = flags.map((v) => truthy(v));
    const kept = keep.filter(Boolean).length;
    if (kept === m.k) return { ok: false, error: `条件对全部 ${m.k} 行都成立,未筛除任何行` };
    if (kept < 2) return { ok: false, error: `仅 ${kept} 行满足条件,不足 2 行无法构成数据集` };
    const rows = m.subs.filter((_, i) => keep[i]).map((s) => [...s.vals]);
    const textCols = get().textCols.map((c) => ({ ...c, values: c.values.filter((_, i) => keep[i]) }));
    const base = m.name.replace(/\.[^.]+$/, '');
    const name = `${base} (子集)`;
    get().importMatrix(name, [...m.colNames], rows, textCols);
    sessionLog(`条件筛选「${cond.trim()}」→ ${name} · 保留 ${kept}/${m.k} 行`);
    return { ok: true, name, kept, total: m.k };
  },

  transposeDataset: () => {
    const m = get().model;
    const rows = m.subs.map((s) => s.vals);
    if (rows.length > 10) {
      throw new Error(`转置后子组大小为 ${rows.length},超出控制图常数表上限 10`);
    }
    const t: number[][] = Array.from({ length: m.n }, (_, j) => rows.map((r) => r[j]));
    const colNames = rows.map((_, i) => `子组${i + 1}`);
    const base = m.name.replace(/ \(转置\)$/, '');
    get().importMatrix(`${base} (转置)`, colNames, t);
  },

  stackColumns: () => {
    const m = get().model;
    if (m.n < 2) throw new Error('单列数据无需堆叠');
    const rows: number[][] = [];
    const source: string[] = [];
    // 按列堆叠：列内行序保持（Minitab Stack 语义）
    m.colNames.forEach((cn, j) => {
      m.subs.forEach((s) => {
        rows.push([s.vals[j]]);
        source.push(cn);
      });
    });
    const base = m.name.replace(/ \(堆叠\)$/, '');
    get().importMatrix(`${base} (堆叠)`, ['测量值'], rows, [{ name: '来源列', values: source }]);
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

/** 启动恢复:活动数据集曾因超配额只存到 SQLite 库时(留有标记),从库中取回。
 * Web 端 datasetDb 为 null 直接跳过;测试中可显式调用。 */
export function hydrateActiveFromVault(): void {
  const db = platform.datasetDb;
  if (!db) return;
  let ref: string | null = null;
  try { ref = localStorage.getItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
  if (!ref || useData.getState().model.name === ref) return;
  db.get(ref).then((json) => {
    if (!json) {
      try { localStorage.removeItem(LS_ACTIVE_REF); } catch { /* 忽略 */ }
      return;
    }
    const data = JSON.parse(json) as StoredDataset;
    const model = computeVarModel(data.name, data.colNames, data.rows);
    useData.setState({ model, textCols: data.textCols ?? [] });
    suggestSpec(model);
    sessionLog(`从数据集库恢复活动数据集 ${ref}(上次因超配额存于本机库)`);
  }).catch(() => { /* 恢复失败保持现状 */ });
}

hydrateActiveFromVault();
