/**
 * 活动数据集 store — 变量数据模型（演示或导入）+ 计数型演示序列（P/C 图）。
 * 所有页面统计量由 /core 纯函数从此处的数据实时计算。
 */
import { create } from 'zustand';
import { buildData, computeVarModel, type VarModel } from '../core';
import { useApp } from './appStore';

/** P/C 图演示序列（计数型数据与测量矩阵无关，导入变量数据后仍为演示） */
export interface AttrDemo {
  pN: number;
  pdef: number[];
  pprop: number[];
  pbar: number;
  pUcl: number;
  pLcl: number;
  cdata: number[];
  cbar: number;
  cUcl: number;
  cLcl: number;
}

const DEMO_COLS = ['直径1', '直径2', '直径3', '直径4', '直径5'];

function demoModel(): { model: VarModel; attr: AttrDemo } {
  const D = buildData();
  const model = computeVarModel(
    '质检数据.mtw',
    DEMO_COLS,
    D.subs.map((s) => s.vals),
    { indivSeries: D.indiv, isDemo: true }, // I-MR 保留原型专用演示序列
  );
  const attr: AttrDemo = {
    pN: D.pN, pdef: D.pdef, pprop: D.pprop, pbar: D.pbar, pUcl: D.pUcl, pLcl: D.pLcl,
    cdata: D.cdata, cbar: D.cbar, cUcl: D.cUcl, cLcl: D.cLcl,
  };
  return { model, attr };
}

interface DataState {
  model: VarModel;
  attr: AttrDemo;
  importMatrix(name: string, colNames: string[], rows: number[][]): void;
  resetDemo(): void;
}

const init = demoModel();

/** 依数据量级取合理的小数位（0.01→4 位，10→2 位…） */
function roundTo(v: number, sd: number): number {
  const digits = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.max(sd, 1e-9)))));
  return Number(v.toFixed(digits));
}

/** 当前数据集的默认规格限：演示数据用原型规格,导入数据按 μ±4σ 建议 */
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

export const useData = create<DataState>((set) => ({
  model: init.model,
  attr: init.attr,
  importMatrix: (name, colNames, rows) => {
    const model = computeVarModel(name, colNames, rows);
    set({ model });
    suggestSpec(model);
  },
  resetDemo: () => {
    const model = demoModel().model;
    set({ model });
    suggestSpec(model);
  },
}));
