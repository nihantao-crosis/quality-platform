/**
 * 2026-09 全面审查第 7 批 G23c C2(G18 复审 P2):sanitizeFileName 为清掉孤立代理项用了后行断言正则。
 * vite 默认 target 含 safari14,esbuild 把它降级成运行时 new RegExp(...);WebKit 16.4 以前
 * (macOS 10.15 WKWebView 最高 Safari 15.6、iOS/iPadOS 15.4–16.3 PWA)每次调用都抛 SyntaxError,
 * 保存项目、项目汇总、全部报表导出的文件名全部失败。修复:按码元线性扫描,不依赖后行断言。
 * 另加仓库卫生守卫:首屏(非懒加载)源码禁止出现后行断言。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../../platform/reportLabels';

const HI = '\uD800';
const LO = '\uDC00';
const PAIR = '😀'; // 😀
/** 后行断言的两种写法;拼接构造,避免本测试文件自身被卫生扫描命中。 */
const LOOKBEHIND = new RegExp(['\\(\\?<', '[=!]'].join(''));

describe('C2 sanitizeFileName 孤立代理项:线性扫描、结果不变', () => {
  it('孤立高/低代理替换为 _,合法代理对原样保留', () => {
    expect(sanitizeFileName(`a${HI}b`)).toBe('a_b');
    expect(sanitizeFileName(`a${LO}b`)).toBe('a_b');
    expect(sanitizeFileName(`x${PAIR}y`)).toBe(`x${PAIR}y`);
    expect(sanitizeFileName(`${LO}${HI}`)).toBe('__'); // 顺序颠倒的「对」不是合法代理对
    expect(sanitizeFileName(`${HI}${HI}${LO}`)).toBe(`_${HI}${LO}`); // 前一个孤立,后两个成对
    expect(sanitizeFileName(`${HI}${LO}${LO}`)).toBe(`${HI}${LO}_`);
    expect(sanitizeFileName(`报告${HI}`)).toBe('报告_');
    expect(sanitizeFileName(`${LO}报告`)).toBe('_报告');
  });

  it('与其它清洗规则的组合不变:非法字符/控制字符/末尾点空格/保留设备名/限长只在码点边界切', () => {
    expect(sanitizeFileName(`a/b:${HI}c\u0001.. `)).toBe('a_b__c_');
    expect(sanitizeFileName(`CON${PAIR}`)).toBe(`CON${PAIR}`);
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    const long = 'a'.repeat(79) + PAIR + 'b';
    expect(sanitizeFileName(long)).toBe('a'.repeat(79)); // 第 80 码元是高代理 → 退一格,不拆对
    expect(sanitizeFileName(`${'.'.repeat(5)}${LO}`)).toBe('....._');
    expect(sanitizeFileName(`${HI}`)).toBe('_');
    expect(sanitizeFileName('')).toBe('未命名');
  });

  it('长串线性时间:20 万个交错孤立代理在百毫秒级完成', () => {
    const raw = `${HI}x${LO}`.repeat(70_000);
    const started = performance.now();
    const out = sanitizeFileName(raw);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).toBe('_x_'.repeat(26) + '_x');
  });

  it('按 vite 默认浏览器目标(safari14)转译后,reportLabels 产物不含后行断言', async () => {
    const file = 'src/platform/reportLabels.ts';
    const out = await transformWithEsbuild(readFileSync(file, 'utf8'), file, { loader: 'ts', target: 'safari14' });
    expect(LOOKBEHIND.test(out.code)).toBe(false);
  });
});

/** 懒加载模块(只经 dynamic import 进入独立 chunk,首屏与保存/导出文件名路径不加载)。
 * 这里的后行断言只影响对应导出格式,不影响启动、保存项目与文件名清洗。 */
const LAZY_ONLY = ['src/platform/officeExport.tsx'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === '__audit_scratch__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(relative('.', full).split(sep).join('/'));
    }
  }
  return out;
}

describe('C2 仓库卫生:非懒加载源码禁止后行断言(WebKit < 16.4 不支持)', () => {
  const files = sourceFiles('src');

  it('扫描到源码文件', () => {
    expect(files).toContain('src/platform/reportLabels.ts');
    expect(files.length).toBeGreaterThan(50);
  });

  it('除懒加载白名单外,src 源码不含后行断言', () => {
    const offenders = files
      .filter((file) => !LAZY_ONLY.includes(file))
      .filter((file) => LOOKBEHIND.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('白名单模块确实只被动态 import(无静态 import/re-export)', () => {
    for (const lazy of LAZY_ONLY) {
      const base = lazy.replace(/^.*\//, '').replace(/\.tsx?$/, '');
      const staticImport = new RegExp(`(?:^|\\n)\\s*(?:import|export)\\s+(?!type\\b)[^;]*?from\\s+['"][^'"]*/${base}['"]`);
      const importers = files.filter((file) => file !== lazy && staticImport.test(readFileSync(file, 'utf8')));
      expect(importers, `${lazy} 被静态导入,不再是懒加载 chunk`).toEqual([]);
      const dynamicImporters = files.filter((file) => readFileSync(file, 'utf8').includes(`import('./${base}')`));
      expect(dynamicImporters.length).toBeGreaterThan(0);
    }
  });
});
