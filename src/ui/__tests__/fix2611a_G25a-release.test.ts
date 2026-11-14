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
/** 本地开发缺 ruby 时守护跳过;CI(GitHub Actions 等设置 CI=true)上必须真跑(fix2611b G26a A3)。 */
const CI_VALUE = process.env.CI?.trim() ?? '';
const IN_CI = CI_VALUE !== '' && !/^(0|false)$/i.test(CI_VALUE);

interface Step {
  name?: string; run?: string; uses?: string; shell?: string; with?: Record<string, unknown>;
  if?: unknown; 'continue-on-error'?: unknown; 'working-directory'?: string; env?: Record<string, unknown>;
}
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
  // 只豁免「每一行都是纯 sudo apt-get update / sudo apt-get install <包名…>」的步骤:
  // 包名只允许字母数字与 -._+:=,任何 && ; | $( 等混写都会使整步不再豁免(fix2611b G26a A2)。
  const lines = normalizeRun(run).split('\n');
  return lines.every((line) => /^sudo apt-get update$/.test(line)
    || /^sudo apt-get install(?: [-A-Za-z0-9._+:=]+)+$/.test(line));
}

/**
 * ci.yml 中允许出现的 uses 型步骤(显式登记的豁免):均为检出/工具链/缓存的环境准备,不是质量门。
 * rust-toolchain 的版本与组件另在比对中逐项核对。新增任何 uses 型步骤都必须先在此登记并说明理由。
 */
const REGISTERED_CI_USES = ['actions/checkout@', 'actions/setup-node@', 'dtolnay/rust-toolchain@', 'swatinem/rust-cache@'];

/** env 映射按键排序、值取字符串后比较;未声明视为空映射。 */
const envSignature = (env: Record<string, unknown> | undefined) => JSON.stringify(
  Object.entries(env ?? {}).map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b)),
);

/** release 门步骤相对 ci 对应步骤的修饰符偏差:不得带 if、不得 continue-on-error,working-directory 与 env 必须一致。 */
function stepModifierProblems(ciStep: Step, releaseStep: Step, command: string, jobName: string): string[] {
  const problems: string[] = [];
  if (releaseStep.if !== undefined) {
    problems.push(`release 质量门「${command}」带 if 条件(${String(releaseStep.if)}),可能被跳过`);
  }
  const continueOnError = releaseStep['continue-on-error'];
  if (continueOnError !== undefined && continueOnError !== false) {
    problems.push(`release 质量门「${command}」设置了 continue-on-error(${String(continueOnError)}),失败不会阻断发版`);
  }
  if ((ciStep['working-directory'] ?? '') !== (releaseStep['working-directory'] ?? '')) {
    problems.push(`release 质量门「${command}」的 working-directory 与 ci.yml(${jobName})不一致`);
  }
  if (envSignature(ciStep.env) !== envSignature(releaseStep.env)) {
    problems.push(`release 质量门「${command}」的 env 与 ci.yml(${jobName})不一致`);
  }
  return problems;
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
          problems.push(...stepModifierProblems(step, steps[at], command, jobName));
          continue;
        }
        // 前端构建由 tauri-action 通过 tauri.conf.json 的 beforeBuildCommand 执行,命令必须完全同源;
        // ci 侧若另带 working-directory / env,tauri-action 无法以同样方式执行,不能视为等价。
        if (command === normalizeRun(beforeBuildCommand)) {
          if (step['working-directory'] !== undefined || envSignature(step.env) !== envSignature(undefined)) {
            problems.push(`ci.yml(${jobName})的「${command}」带 working-directory/env,无法证明与 beforeBuildCommand 同源`);
          }
          continue;
        }
        problems.push(`release build 作业缺少 ci.yml(${jobName})的质量门「${command}」`);
      }
      if (step.uses && !REGISTERED_CI_USES.some((prefix) => step.uses!.startsWith(prefix))) {
        problems.push(`ci.yml(${jobName})出现未登记的 uses 型步骤「${step.uses}」:若是质量门须在 release build 作业中同源执行,并在 REGISTERED_CI_USES 显式登记豁免`);
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
  it('CI 环境必须提供 ruby 以解析工作流 YAML(本地开发缺 ruby 时只跳过守护)', () => {
    if (IN_CI) expect(RUBY_YAML, 'CI 环境必须提供 ruby 以解析工作流 YAML').toBe(true);
  });

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

describe('fix2611b G26a A1/A2 守护不能被步骤修饰符、uses 型门或 apt 混写绕过', () => {
  const tauriCommand = () => (JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { build: { beforeBuildCommand: string } }).build.beforeBuildCommand;
  const load = () => ({ ci: parseWorkflow('.github/workflows/ci.yml'), release: parseWorkflow('.github/workflows/release.yml') });
  const releaseGate = (release: Workflow, command: string) => release.jobs.build.steps!
    .find((step) => step.run && normalizeRun(step.run) === command)!;
  const ciGate = (ci: Workflow, command: string) => Object.values(ci.jobs).flatMap((job) => job.steps ?? [])
    .find((step) => step.run && normalizeRun(step.run) === command)!;
  const problemsOf = (ci: Workflow, release: Workflow) => releaseQualityGateProblems(ci, release, tauriCommand()).join('\n');

  it.skipIf(!RUBY_YAML)(`release 门步骤带 continue-on-error 或 if 条件时报出${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    for (const [key, value] of [['continue-on-error', true], ['continue-on-error', '${{ true }}'], ['if', '${{ false }}'], ['if', 'false']] as const) {
      const { ci, release } = load();
      Object.assign(releaseGate(release, 'npm run lint'), { [key]: value });
      const problems = problemsOf(ci, release);
      expect(problems, `${key}=${String(value)}`).toContain('npm run lint');
      expect(problems).toContain(key);
    }
    // continue-on-error: false 是默认语义,不算绕过
    const { ci, release } = load();
    Object.assign(releaseGate(release, 'npm run lint'), { 'continue-on-error': false });
    expect(releaseQualityGateProblems(ci, release, tauriCommand())).toEqual([]);
  });

  it.skipIf(!RUBY_YAML)(`working-directory 或 env 与 ci 对应步骤不一致时报出(两个方向)${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    const gate = 'cargo test --manifest-path src-tauri/Cargo.toml --locked';
    const mutations: Array<[string, (ci: Workflow, release: Workflow) => void, string]> = [
      ['ci 加 working-directory', (ci) => Object.assign(ciGate(ci, gate), { 'working-directory': 'src-tauri' }), 'working-directory'],
      ['release 加 working-directory', (_ci, release) => Object.assign(releaseGate(release, gate), { 'working-directory': 'src-tauri' }), 'working-directory'],
      ['ci 加 env', (ci) => Object.assign(ciGate(ci, gate), { env: { RUSTFLAGS: '-D warnings' } }), 'env'],
      ['release 加 env', (_ci, release) => Object.assign(releaseGate(release, gate), { env: { CARGO_INCREMENTAL: '0' } }), 'env'],
      ['env 同名不同值', (ci, release) => {
        Object.assign(ciGate(ci, gate), { env: { RUSTFLAGS: '-D warnings' } });
        Object.assign(releaseGate(release, gate), { env: { RUSTFLAGS: '' } });
      }, 'env'],
    ];
    for (const [label, mutate, keyword] of mutations) {
      const { ci, release } = load();
      mutate(ci, release);
      const problems = problemsOf(ci, release);
      expect(problems, label).toContain(gate);
      expect(problems, label).toContain(keyword);
    }
    // 两边一致时不报
    const { ci, release } = load();
    Object.assign(ciGate(ci, gate), { env: { RUSTFLAGS: '-D warnings' }, 'working-directory': '.' });
    Object.assign(releaseGate(release, gate), { env: { RUSTFLAGS: '-D warnings' }, 'working-directory': '.' });
    expect(releaseQualityGateProblems(ci, release, tauriCommand())).toEqual([]);
  });

  it.skipIf(!RUBY_YAML)(`由 beforeBuildCommand 承担的 ci 构建步骤带修饰符时无法证明同源,报出${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    const { ci, release } = load();
    Object.assign(ciGate(ci, normalizeRun(tauriCommand())), { env: { NODE_ENV: 'production' } });
    expect(problemsOf(ci, release)).toContain(normalizeRun(tauriCommand()));
  });

  it.skipIf(!RUBY_YAML)(`ci 出现未登记的 uses 型步骤直接报红,已登记的环境准备步骤不报${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    const { ci, release } = load();
    const declared = Object.values(ci.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses);
    expect(declared.length).toBeGreaterThanOrEqual(4);
    expect(releaseQualityGateProblems(ci, release, tauriCommand())).toEqual([]);
    ci.jobs.check.steps!.push({ uses: 'some/new-gate-action@v1' });
    const problems = problemsOf(ci, release);
    expect(problems).toContain('some/new-gate-action@v1');
    expect(problems).toContain('未登记');
    // 前缀相似但不是登记项(防止按子串放行)
    const { ci: ci2, release: release2 } = load();
    ci2.jobs.rust.steps!.push({ uses: 'evil/actions/checkout@v4' });
    expect(problemsOf(ci2, release2)).toContain('evil/actions/checkout@v4');
  });

  it.skipIf(!RUBY_YAML)(`apt 豁免只放行逐行纯 apt-get update/install 的步骤,与其它命令混写不被豁免${RUBY_YAML ? '' : SKIP_REASON}`, () => {
    expect(isLinuxDependencyInstall('sudo apt-get update\nsudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf')).toBe(true);
    for (const mixed of [
      'sudo apt-get install -y foo && cargo deny check',
      'sudo apt-get install -y foo; cargo deny check',
      'sudo apt-get install -y foo | tee log',
      'sudo apt-get install -y $(cargo deny check)',
      'sudo apt-get update\ncargo deny check',
      'cargo deny check # apt-get install',
      'sudo apt-get update && sudo apt-get install -y foo',
    ]) {
      expect(isLinuxDependencyInstall(mixed), mixed).toBe(false);
    }
    const { ci, release } = load();
    ci.jobs.rust.steps!.push({ run: 'sudo apt-get install -y foo && cargo deny check' });
    expect(problemsOf(ci, release)).toContain('cargo deny check');
  });
});

interface VitestJsonReport { testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> }

/** 在 PATH 只含空目录(没有 ruby)的子进程里跑指定测试文件;ci 为 undefined 时显式清掉 CI 变量模拟本地开发。 */
function runWithoutRuby(file: string, filter: string, ci: string | undefined) {
  const emptyBin = mkdtempSync(join(tmpdir(), 'qp-no-ruby-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'PATH' && key.toUpperCase() !== 'CI') env[key] = value;
    }
    env.PATH = emptyBin;
    if (ci !== undefined) env.CI = ci;
    const run = spawnSync(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'), 'run', file, '-t', filter, '--reporter=json',
    ], { env, encoding: 'utf8', cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    const json = run.stdout.indexOf('{');
    const report = (json >= 0 ? JSON.parse(run.stdout.slice(json)) : { testResults: [] }) as VitestJsonReport;
    const results = report.testResults.flatMap((entry) => entry.assertionResults);
    return { run, results, detail: `${run.stderr}\n${run.stdout.slice(-2000)}` };
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
  }
}

describe('A2 发版结构测试在缺少 ruby 的环境显式跳过而不是变红', () => {
  it('本地(无 CI 变量)PATH 中没有 ruby 时 v143StatsReleaseRound2 的 YAML 结构用例被跳过且整文件退出码为 0', () => {
    const { run, results, detail } = runWithoutRuby('src/ui/__tests__/v143StatsReleaseRound2.test.tsx', '发布工作流结构', undefined);
    expect(run.status, detail).toBe(0);
    const structural = results.filter((result) => result.title.includes('draft 转正'));
    expect(structural).toHaveLength(1);
    expect(['skipped', 'pending']).toContain(structural[0].status);
    expect(structural[0].title).toContain('未检测到可用的 ruby');
  }, 120_000);

  // fix2611b G26a A3:CI 上没有 ruby 时守护不能静默变成 skipped 而整体仍绿。
  it('CI=true 且 PATH 中没有 ruby 时 v143StatsReleaseRound2 与本文件的工作流守护都直接失败', () => {
    for (const file of ['src/ui/__tests__/v143StatsReleaseRound2.test.tsx', 'src/ui/__tests__/fix2611a_G25a-release.test.ts']) {
      const { run, results, detail } = runWithoutRuby(file, 'CI 环境必须提供 ruby', 'true');
      expect(run.status, `${file}\n${detail}`).not.toBe(0);
      const guard = results.filter((result) => result.title.includes('CI 环境必须提供 ruby 以解析工作流 YAML'));
      expect(guard, `${file}\n${detail}`).toHaveLength(1);
      expect(guard[0].status).toBe('failed');
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
