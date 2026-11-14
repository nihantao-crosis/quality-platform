/**
 * fix2611a G25d D3:__APP_VERSION__ 只能经 appVersionText() 安全访问。
 * 宿主未注入 define 时裸用会抛 ReferenceError(保存项目直接失败)，而报告链路回落「开发版」——两条口径分裂。
 * 项目文件的 appVersion 字段只作信息记录：导入侧版本门只看 formatVersion，不解析 appVersion，
 * 因此与 MenuBar 已有做法同源地写入 appVersionText() 的值不会破坏版本门。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALLOWED = new Set(['src/version.d.ts', 'src/platform/reportLabels.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('D3 __APP_VERSION__ 全仓守卫', () => {
  it('非测试源码不得裸用 __APP_VERSION__(定义处与 appVersionText 除外)', () => {
    const offenders = sourceFiles('src')
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => !ALLOWED.has(path))
      .flatMap((path) => readFileSync(path, 'utf8').split('\n')
        .map((line, index) => ({ line, at: `${path}:${index + 1}` }))
        .filter(({ line }) => line.replace(/\/\/.*$/, '').includes('__APP_VERSION__'))
        .map(({ at }) => at));
    expect(offenders, `请改用 appVersionText():${offenders.join('、')}`).toEqual([]);
  });

  it('保存项目的三处入口与菜单同源使用 appVersionText()', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    const toolbar = readFileSync('src/ui/shell/Toolbar.tsx', 'utf8');
    expect(app.match(/exportProject\(appVersionText\(\)/g)?.length).toBe(2);
    expect(toolbar).toContain('exportProject(appVersionText()');
  });

  it('appVersionText 在构建注入下返回 package.json 版本(非「开发版」)', async () => {
    const { appVersionText } = await import('../../platform/reportLabels');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(appVersionText()).toBe(pkg.version);
  });
});
