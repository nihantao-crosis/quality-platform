/**
 * fix2609n · G24c-store C3(第 7 批复审 P3 发布卫生)：
 * - tsconfig 的 include 含 src，会把已 gitignore 的审查临时复现目录 src/__audit_scratch__ 编进 `tsc -b`，
 *   本机工作树 npm run build 因复审临时文件失败；须 exclude 掉，且仍覆盖全部生产源码与测试。
 * - .github/scripts 的 Python 发布门禁运行后留下 __pycache__/，须忽略，避免被误提交/误打包。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function parsedTsconfig(base = root): ts.ParsedCommandLine {
  const configPath = path.join(base, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error).toBeUndefined();
  return ts.parseJsonConfigFileContent(read.config, ts.sys, base, undefined, configPath);
}

describe('C3 发布卫生', () => {
  it('tsconfig 显式 exclude src/__audit_scratch__', () => {
    const raw = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as { exclude?: string[] };
    expect(raw.exclude ?? []).toContain('src/__audit_scratch__');
  });

  it('按 tsconfig 解析出的编译文件：不含审查临时目录，仍覆盖生产源码、测试与浏览器门禁', () => {
    const files = parsedTsconfig().fileNames.map((file) => path.relative(root, file).split(path.sep).join('/'));
    expect(files.filter((file) => file.startsWith('src/__audit_scratch__/'))).toEqual([]);
    for (const expected of [
      'src/main.tsx', 'src/App.tsx', 'src/store/dataStore.ts', 'src/store/fishboneStore.ts',
      'src/platform/project.ts', 'src/ui/shell/MenuBar.tsx', 'src/ui/__tests__/fix2609n_G24c-store.test.ts',
      'src/core/__tests__/doeBlocks.test.ts', '.github/browser-harness/office-image-gate.ts',
    ]) {
      expect(files, expected).toContain(expected);
    }
  });

  it('复审者场景：工作树里存在审查临时复现文件时，真实 tsconfig 不把它编进来(同目录的普通源码照常编译)', () => {
    // 不触碰真实 src/__audit_scratch__:把真实 tsconfig.json 复制到临时目录，造出同样的目录结构再按它解析。
    const sandbox = mkdtempSync(path.join(os.tmpdir(), 'qp-tsconfig-'));
    try {
      writeFileSync(path.join(sandbox, 'tsconfig.json'), readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
      mkdirSync(path.join(sandbox, 'src', '__audit_scratch__', 'reviewG'), { recursive: true });
      mkdirSync(path.join(sandbox, '.github', 'browser-harness'), { recursive: true });
      writeFileSync(path.join(sandbox, 'src', 'main.tsx'), 'export {};\n');
      writeFileSync(path.join(sandbox, 'src', '__audit_scratch__', 'reviewG', 'a3_lazy.test.ts'), 'export {};\n');
      writeFileSync(path.join(sandbox, '.github', 'browser-harness', 'gate.ts'), 'export {};\n');
      const files = parsedTsconfig(sandbox).fileNames.map((file) => path.relative(sandbox, file).split(path.sep).join('/'));
      expect(files.sort()).toEqual(['.github/browser-harness/gate.ts', 'src/main.tsx']);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('.gitignore 忽略 __pycache__/', () => {
    const lines = readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('__pycache__/');
  });
});
