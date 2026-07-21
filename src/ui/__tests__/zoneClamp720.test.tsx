/** 批次720 审查修复回归:σ 区带线/标注严格夹在 (LCL,UCL) 开区间内。
 * R/S/MR/C/P 图 LCL 截 0 后,cl−2σ 可为负——非负统计量不得出现负值参考线/标注;
 * SL 标签与 UCL/CL/LCL 标签逐对测距,间距不足不标数。 @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { ControlChart } from '../charts/ControlChart';
import { chartTokens } from '../tokens';

const T = chartTokens('经典', true);

describe('720 σ 区带 LCL 截断', () => {
  it('MR 型(lcl=0):负值 -SL 线与标注均不出现', () => {
    // cl=1, ucl=3.2665(D4·MR̄), lcl=0 → σ=0.7555, cl-2σ=-0.511<0
    const html = render(createElement(ControlChart, {
      T, data: [0.5, 1.2, 0.8, 1.5, 0.9], cl: 1, ucl: 3.2665, lcl: 0, zones: true, dec: 3,
    })).container.innerHTML;
    expect(html).not.toMatch(/-2SL=-/);
    expect(html).not.toMatch(/-1SL=-/);
    // -1SL = 1-0.7555 = 0.2445 > 0 且在 (0, ucl) 内:允许出现(与 LCL=0 标签距离足够)
    expect(html).toContain('+1SL=');
  });

  it('C 型(cl=4,lcl=0):cl-2σ=1.33>0 可画,但与 LCL 重叠场景(cl-2σ≈lcl)不标数', () => {
    // 构造 cl-2σ 恰等于 lcl:cl=2, ucl=5, lcl=0 → σ=1, cl-2σ=0=lcl → zoneInside=false 不画
    const html = render(createElement(ControlChart, {
      T, data: [1, 2, 3, 2, 1], cl: 2, ucl: 5, lcl: 0, zones: true, dec: 1,
    })).container.innerHTML;
    expect(html).not.toContain('-2SL=0.0');
  });

  it('X̄ 型(对称限):四条 SL 全部出现', () => {
    const html = render(createElement(ControlChart, {
      T, data: [10, 11, 9, 10.5, 9.5], cl: 10, ucl: 13, lcl: 7, zones: true, dec: 1, h: 250,
    })).container.innerHTML;
    for (const lbl of ['+1SL=11.0', '+2SL=12.0', '-1SL=9.0', '-2SL=8.0']) expect(html).toContain(lbl);
  });

  it('分阶段 X̄ 图按每段控制限绘制不同 SL，不能退回全局常数或直接消失', () => {
    const html = render(createElement(ControlChart, {
      T,
      data: [10, 10.5, 9.5, 20, 21, 19],
      cl: 15,
      ucl: 24,
      lcl: 6,
      zones: true,
      dec: 1,
      stepSeries: true,
      stageBoundaries: [3],
      clSeries: [10, 10, 10, 20, 20, 20],
      uclSeries: [13, 13, 13, 26, 26, 26],
      lclSeries: [7, 7, 7, 14, 14, 14],
    })).container.innerHTML;
    for (const label of ['+1SL=11.0', '+2SL=12.0', '-1SL=9.0', '-2SL=8.0', '+1SL=22.0', '+2SL=24.0', '-1SL=18.0', '-2SL=16.0']) {
      expect(html).toContain(label);
    }
  });
});
