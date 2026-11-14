/**
 * 2026-09 全面审查第 7 批 G23c C3(整体 diff 复审 P2):README v1.43.0 发布说明缺少 4a/4b/5a/5b/3b/6 批的
 * 用户可见变化,且「除 CORE-01 外本批未改其他统计口径」与 σ̂ 守卫改判「不可判定」冲突;AQL 账本记录链
 * 核对会在启动/导入时隔离旧账本,却没有列入「升级前必读」。
 * 这里只核对 README 的事实陈述与当前实现一致(关键数字取自生产常量,不写死)。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';
import { MAX_PARETO_PLOT_BARS } from '../charts/misc';
import { MAX_PARETO_TABLE_ROWS } from '../pages/SimplePages';
import { MAX_DOE_MATRIX_ROWS } from '../pages/Doe';

const readme = readFileSync('README.md', 'utf8');

function releaseSection(): string {
  const heading = readme.split('\n').find((line) => line.startsWith('## ') && line.includes(`v${pkg.version}`) && line.includes('发布说明'));
  expect(heading, `README 缺少 v${pkg.version} 发布说明`).toBeDefined();
  const start = readme.indexOf(heading!);
  const next = readme.indexOf('\n## ', start + heading!.length);
  return readme.slice(start, next < 0 ? undefined : next);
}

function subsection(section: string, predicate: (heading: string) => boolean): string {
  const heading = section.split('\n').find((line) => line.startsWith('### ') && predicate(line));
  expect(heading).toBeDefined();
  const start = section.indexOf(heading!);
  const next = section.indexOf('\n### ', start + heading!.length);
  return section.slice(start, next < 0 ? undefined : next);
}

function bullet(section: string, title: string): string {
  const line = section.split('\n').find((l) => l.startsWith(`- **${title}`));
  expect(line, `缺少「${title}」条目`).toBeDefined();
  return line!;
}

describe('C3 README v1.43.0 发布说明与实现一致', () => {
  it('(a) 不再声称「除 CORE-01 外未改其他统计口径」;σ̂ 守卫改判不可判定写明为口径收口', () => {
    const section = releaseSection();
    expect(section).not.toMatch(/本批未改其他统计口径/);
    expect(section).toMatch(/零变异.*σ̂.*数值分辨率.*不可判定.*口径收口.*非零变异数据的结果逐位不变/);
    const guard = bullet(section, 'SPC σ̂ 守卫');
    for (const term of ['X̄-R', 'X̄-S', 'I-MR', '总览', '工作表', '记录', '不可判定']) expect(guard).toContain(term);
  });

  it('(b) 「升级前必读」单列 AQL 账本记录链核对:legacy 接受范围、隔离后果、恢复路径', () => {
    const section = releaseSection();
    const aql = subsection(section, (h) => h.includes('AQL') && h.includes('记录链') && h.includes('升级前必读'));
    expect(aql).toContain('legacy');
    expect(aql).toContain('v1.32');
    expect(aql).toContain('严一档');
    expect(aql).toMatch(/加严|暂停/);
    expect(aql).toContain('纸质记录');
    expect(aql).toContain('隔离');
    expect(aql).toMatch(/项目导出.*阻止|阻止.*项目导出/);
    expect(aql).toMatch(/\.qproj.*拒绝|拒绝.*\.qproj/);
    expect(aql).toContain('文件 → 打开…');
    expect(aql).toContain('清除数据并恢复演示');
    expect(aql).toContain('不是防篡改签名');
  });

  it('(c) 补齐本批其余用户可见变化', () => {
    const section = releaseSection();
    // 桌面关窗 / 数据集库损坏(既有条目保留)
    expect(section).toMatch(/关窗.*Cmd\+Q.*未持久化.*确认/);
    expect(section).toContain('datasets.db.corrupt-<时间戳>');
    // 已隔离损坏键按降级视图导出(含按需读取的键)
    const degraded = bullet(section, '已隔离的损坏数据按降级视图导出');
    expect(degraded).toContain('qp-quarantine-v1');
    expect(degraded).toMatch(/规格限.*鱼骨图.*副本序号/);
    // 最近列表首尾空格重名启动迁移
    expect(bullet(section, '最近列表首尾空格重名')).toContain('隔离区');
    // 导出快照期间:单格编辑暂存、结构性编辑与撤销/重做拒绝
    const snapshot = bullet(section, '项目备份快照期间的编辑');
    expect(snapshot).toMatch(/单元格.*暂存/);
    expect(snapshot).toMatch(/删行.*排序.*撤销\/重做.*拒绝/);
    expect(section).not.toContain('撤销已暂存');
    // 撤销层数显示
    expect(section).toContain('可撤销步数');
    // 帕累托 / DOE 显示上限(数字取生产常量)
    const caps = bullet(section, '大数据量显示上限');
    expect(caps).toContain(`${MAX_PARETO_PLOT_BARS} 类`);
    expect(caps).toContain(`${MAX_PARETO_TABLE_ROWS} 行`);
    expect(caps).toContain(`前 ${MAX_DOE_MATRIX_ROWS} 行`);
    // xlsx Root Entry/
    expect(section).toContain('Root Entry/');
    // reportNum 报告数值文本
    const reportNum = bullet(section, '报告数值文本');
    expect(reportNum).toContain('3 位有效数字');
    expect(reportNum).toContain('原始观测');
  });

  it('(c) 手工数值输入:μ₀/过程公差/规格限的回退语义与 C1 一致,不再写「结果仍按上一次有效值」', () => {
    const line = bullet(releaseSection(), '手工数值输入');
    expect(line).not.toContain('结果仍按上一次有效值 μ₀');
    expect(line).not.toMatch(/注明仍按上一次有效值/);
    expect(line).toContain('编辑前的值');
    expect(line).toMatch(/1,000.*「1」|「1」.*1,000/);
    expect(line).toContain('AQL 批量 N');
  });

  it('C2:写明浏览器目标与后行断言约束(只写文档)', () => {
    const line = bullet(releaseSection(), '旧版 WebKit');
    expect(line).toContain('safari14');
    expect(line).toContain('16.4');
    expect(line).toContain('macOS 10.15');
    expect(line).toContain('后行断言');
  });
});
