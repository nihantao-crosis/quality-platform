/** 2026-09 全面审查第 1b 批 · G6b-docs(M6)：README 的项目文件格式说明必须与真实写出版本一致。
 * 复审者场景：FORMAT_VERSION 已提到 5，README 仍写「当前导出使用 formatVersion 2」，
 * 也没有写明 v1.42.x 打不开 v1.43 导出文件（只会提示升级）——混用新旧版本的工厂用户直接撞墙。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_FORMAT_VERSION } from '../../platform/project';

const readme = readFileSync('README.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

describe('M6 README 项目文件格式说明', () => {
  it('「当前导出」声明的格式版本只有一处，且等于真实写出的 PROJECT_FORMAT_VERSION', () => {
    const claims = [...readme.matchAll(/当前导出使用\s*\*\*formatVersion\s*(\d+)\*\*/g)].map((m) => Number(m[1]));
    expect(claims).toEqual([PROJECT_FORMAT_VERSION]);
  });

  it('当前版本的发布说明写明格式降级不兼容、旧版提示升级与旧文件迁移', () => {
    const heading = readme.split('\n').find((line) => line.startsWith('## ') && line.includes(`v${pkg.version}`)
      && line.includes('发布说明'));
    expect(heading, `README 缺少 v${pkg.version} 发布说明条目`).toBeDefined();
    const start = readme.indexOf(heading!);
    const next = readme.indexOf('\n## ', start + heading!.length);
    const section = readme.slice(start, next < 0 ? undefined : next);
    expect(section).toContain(`formatVersion ${PROJECT_FORMAT_VERSION}`);
    // 旧读取器（v1.42.x FORMAT_VERSION=4）的真实拒绝文案，用户在旧版上看到的就是这句。
    expect(section).toContain(`项目文件版本 ${PROJECT_FORMAT_VERSION} 高于当前应用支持的 ${PROJECT_FORMAT_VERSION - 1},请升级应用`);
    expect(section).toContain('v1.42.x');
    // v1–v4 旧文件导入迁移的两条语义
    expect(section).toContain('最近列表');
    expect(section).toContain('残留分析数据');
    // v3/v4/v5 各自语义都要写到
    for (const v of [3, 4, 5]) expect(section).toMatch(new RegExp(`\\bv${v}\\b`));
  });
});
