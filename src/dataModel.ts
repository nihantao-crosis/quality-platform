/** 全局演示数据集单例 — buildData 为确定性生成，App 与弹窗共用一份。 */
import { buildData } from './core';

export const DATA = buildData();
