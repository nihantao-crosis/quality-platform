/** fix2611a G25a-release:附录 F.1-2 / F.3-20 / F.3-21 的发版链与桌面写入守护。
 * @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MAX_QPROJ_IMPORT_BYTES, MAX_TEXT_DATA_IMPORT_BYTES } from '../../platform/importLimits';
import { MAX_XLSX_ENTRY_BYTES, MAX_XLSX_IMPORT_BYTES, MAX_XLSX_TOTAL_BYTES } from '../../platform/adapter';

/** 工作流 YAML 用 ruby 自带的 Psych 解析(仓库没有被锁文件固定的直接 YAML 依赖,不为测试新增依赖)。 */
const RUBY_YAML = (() => {
  const probe = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'exit 0'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
})();
const SKIP_REASON = '(跳过:未检测到可用的 ruby,无法解析工作流 YAML)';

interface Step { name?: string; run?: string; uses?: string; shell?: string; with?: Record<string, unknown> }
interface Job { steps?: Step[]; needs?: string | string[] }
interface Workflow { jobs: Record<string, Job> }

function parseWorkflow(file: string): Workflow {
  const yaml = readFileSync(file, 'utf8');
  const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [], aliases: true))',
  ], { input: yaml, encoding: 'utf8' });
  if (ruby.error || ruby.status !== 0) throw new Error(`ruby 解析 ${file} 失败:${ruby.stderr}`);
  return JSON.parse(ruby.stdout) as Workflow;
}

/** 多行 run 按行去首尾空白并去空行,使块标量缩进差异不影响比对。 */
const normalizeRun = (run: string) => run.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');

/** ci.yml 中不属于「代码质量门」或由发版作业以等价方式承担的步骤;每项都在比对中验证其等价物。 */
function isLinuxDependencyInstall(run: string): boolean {
  // ci 的 Rust 作业跑在 ubuntu,需要先装 webkit2gtk 等 Linux 依赖;发版构建跑在 Windows/macOS,无此步骤。
  return /apt-get install/.test(run);
}

/**
 * 返回 release.yml 的 build 作业相对 ci.yml 缺失/顺序错误的质量门(空数组表示同源齐备)。
 * 命令全部从 ci.yml 读取,不在测试中写死。
 */
function releaseQualityGateProblems(ci: Workflow, release: Workflow, beforeBuildCommand: string): string[] {
  const problems: string[] = [];
  const build = release.jobs.build;
  const steps = build?.steps ?? [];
  const tauriIndex = steps.findIndex((step) => step.uses?.startsWith('tauri-apps/tauri-action@'));
  if (tauriIndex < 0) return ['release build 作业缺少 tauri-action 构建/签名步骤'];
  const releaseRuns = steps.map((step) => (step.run ? normalizeRun(step.run) : null));

  for (const [jobName, job] of Object.entries(ci.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.run) {
        const command = normalizeRun(step.run);
        if (isLinuxDependencyInstall(command)) continue;
        const at = releaseRuns.indexOf(command);
        if (at >= 0) {
          if (at > tauriIndex) problems.push(`质量门「${command}」(ci ${jobName})排在构建与签名之后`);
          continue;
        }
        // 前端构建由 tauri-action 通过 tauri.conf.json 的 beforeBuildCommand 执行,命令必须完全同源。
        if (command === normalizeRun(beforeBuildCommand)) continue;
        problems.push(`release build 作业缺少 ci.yml(${jobName})的质量门「${command}」`);
      }
      if (step.uses?.startsWith('dtolnay/rust-toolchain@')) {
        const needed = String(step.with?.components ?? '').split(',').map((part) => part.trim()).filter(Boolean);
        const toolchainSteps = steps.filter((candidate) => candidate.uses === step.uses);
        if (toolchainSteps.length === 0) problems.push('release build 作业缺少与 ci.yml 同一版本的 rust-toolchain 步骤');
        for (const toolchain of toolchainSteps) {
          if (String(toolchain.with?.toolchain) !== String(step.with?.toolchain)) {
            problems.push(`release rust toolchain ${String(toolchain.with?.toolchain)} 与 ci.yml ${String(step.with?.toolchain)} 不一致`);
          }
          const have = new Set(String(toolchain.with?.components ?? '').split(',').map((part) => part.trim()));
          for (const component of needed) {
            if (!have.has(component)) problems.push(`release rust toolchain 缺少组件 ${component}`);
          }
        }
      }
    }
  }
  return problems;
}

describe('A1 发版构建作业必须执行 ci.yml 的全部质量门', () => {
  it.skipIf(!RUBY_YAML)(`release.yml build 作业包含 ci.yml 每一条质量门命令且都在构建签名之前${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    const ci = parseWorkflow('.github/workflows/ci.yml');
    const release = parseWorkflow('.github/workflows/release.yml');
    const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { build: { beforeBuildCommand: string } };
    // 比对对象确实来自 ci.yml(防止解析出空作业而「零缺失」假通过)
    const ciRuns = Object.values(ci.jobs).flatMap((job) => (job.steps ?? []).filter((step) => step.run));
    expect(ciRuns.length).toBeGreaterThanOrEqual(5);
    expect(releaseQualityGateProblems(ci, release, tauri.build.beforeBuildCommand)).toEqual([]);
  });

  it.skipIf(!RUBY_YAML)(`守护会咬:从 release 删掉任一 ci 质量门或把它挪到签名之后都会报出${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    const ci = parseWorkflow('.github/workflows/ci.yml');
    const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { build: { beforeBuildCommand: string } };
    const gates = Object.values(ci.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => (step.run ? normalizeRun(step.run) : ''))
      .filter((run) => run && !isLinuxDependencyInstall(run) && run !== tauri.build.beforeBuildCommand);
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) {
      const release = parseWorkflow('.github/workflows/release.yml');
      const steps = release.jobs.build.steps!;
      release.jobs.build.steps = steps.filter((step) => !step.run || normalizeRun(step.run) !== gate);
      expect(releaseQualityGateProblems(ci, release, tauri.build.beforeBuildCommand).join('\n')).toContain(gate);

      const moved = parseWorkflow('.github/workflows/release.yml');
      const movedSteps = moved.jobs.build.steps!;
      const index = movedSteps.findIndex((step) => step.run && normalizeRun(step.run) === gate);
      const [step] = movedSteps.splice(index, 1);
      movedSteps.push(step);
      expect(releaseQualityGateProblems(ci, moved, tauri.build.beforeBuildCommand).join('\n')).toContain('排在构建与签名之后');
    }
  });

  it.skipIf(!RUBY_YAML)(`签名、摘要固化与 draft 转正的既有顺序不变${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    const release = parseWorkflow('.github/workflows/release.yml');
    const steps = release.jobs.build.steps!;
    const tauriIndex = steps.findIndex((step) => step.uses?.startsWith('tauri-apps/tauri-action@'));
    const digestIndex = steps.findIndex((step) => step.run?.includes('release_asset_manifest.py create'));
    expect(tauriIndex).toBeGreaterThan(-1);
    expect(digestIndex).toBeGreaterThan(tauriIndex);
    expect(steps[tauriIndex].with?.releaseDraft).toBe(true);
    expect(release.jobs['publish-release'].needs).toEqual(['updater-json', 'portable']);
  });
});

describe('A2 发版结构测试在缺少 ruby 的环境显式跳过而不是变红', () => {
  it('PATH 中没有 ruby 时 v143StatsReleaseRound2 的 YAML 结构用例被跳过且整文件退出码为 0', () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'qp-no-ruby-'));
    try {
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key.toUpperCase() !== 'PATH') env[key] = value;
      }
      env.PATH = emptyBin;
      const run = spawnSync(process.execPath, [
        resolve('node_modules/vitest/vitest.mjs'), 'run',
        'src/ui/__tests__/v143StatsReleaseRound2.test.tsx',
        '-t', '发布工作流结构', '--reporter=json',
      ], { env, encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
      expect(run.status, `${run.stderr}\n${run.stdout.slice(-2000)}`).toBe(0);
      const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as {
        testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
      };
      const structural = report.testResults.flatMap((file) => file.assertionResults)
        .filter((result) => result.title.includes('draft 转正'));
      expect(structural).toHaveLength(1);
      expect(['skipped', 'pending']).toContain(structural[0].status);
      expect(structural[0].title).toContain('未检测到可用的 ruby');
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('A3 桌面端写文件硬上限不得小于任何合法导出/导入上限', () => {
  it('lib.rs 的 MAX_DESKTOP_EXPORT_BYTES 覆盖 qproj、CSV 与 xlsx 各上限', () => {
    const source = readFileSync('src-tauri/src/lib.rs', 'utf8');
    const match = /const MAX_DESKTOP_EXPORT_BYTES: u64 = (\d+) \* 1024 \* 1024;/.exec(source);
    expect(match, '桌面写入上限常量缺失').not.toBeNull();
    const limit = Number(match![1]) * 1024 * 1024;
    for (const floor of [MAX_QPROJ_IMPORT_BYTES, MAX_TEXT_DATA_IMPORT_BYTES, MAX_XLSX_IMPORT_BYTES, MAX_XLSX_ENTRY_BYTES, MAX_XLSX_TOTAL_BYTES]) {
      expect(limit).toBeGreaterThanOrEqual(floor);
    }
    // 两个写命令都必须经过同一闸门
    expect(source).toMatch(/fn save_text_file\([^)]*\)[^{]*\{[^}]*MAX_DESKTOP_EXPORT_BYTES/);
    expect(source).toMatch(/fn save_binary_file\([^)]*\)[^{]*\{[^}]*MAX_DESKTOP_EXPORT_BYTES/);
  });
});
