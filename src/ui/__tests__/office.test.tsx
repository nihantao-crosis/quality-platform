/**
 * Office 导出测试 — node 环境无 canvas,验证无图降级路径产出合法 OOXML(ZIP)。
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildDocx, buildPptx } from '../../platform/officeExport';
import { buildData, computeVarModel } from '../../core';

const D = buildData();
const M = computeVarModel('质检数据.mtw', ['直径1', '直径2', '直径3', '直径4', '直径5'], D.subs.map((s) => s.vals), { isDemo: true });
const SPEC = { lsl: 24.9, tgt: 25.0, usl: 25.1 };

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b; // 'PK'

describe('Office 真渲染导出（无图降级）', () => {
  it('Word .docx 为合法 ZIP 且非空', async () => {
    const bytes = await buildDocx(M, SPEC);
    expect(isZip(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(2000);
  });
  it('PowerPoint .pptx 为合法 ZIP 且非空', async () => {
    const bytes = await buildPptx(M, SPEC);
    expect(isZip(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(10000);
  });
});
