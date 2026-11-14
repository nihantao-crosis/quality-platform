#!/usr/bin/env node
/* global process, console */
/**
 * v1.32 真实账本夹具生成器(fix2609m G23b-aql B1/B3)。
 *
 * CORE-06 链审计要兼容 v1.32 写出的 legacy 账本，回归用例就必须消费「v1.32 生产代码真实写出的」
 * 载荷，不能再拿 HEAD 的 recordInspection 生成后删字段来冒充(HEAD 的记录带 regime /
 * nonconformingDisposition，且 Ac≥2 时的严一档计分规则与 v1.32 不同)。
 *
 * 做法：用 `git show fa4b539:<文件>`(v1.32.0 发布提交)取出当时的 aqlSwitch.ts / aql.ts /
 * basicMath.ts 到临时目录，esbuild 打包后按 v1.32 的界面/Store 语义操作：
 * · 批次登记 → recordInspection(v1.32 不接收 regime / nonconformingDisposition);
 * · 管理条件勾选 → setSwitchConditions;放宽中「因其他条件恢复正常」→ restoreNormalInspection;
 *   暂停后「纠正措施有效」→ resumeTightenedInspection(都不写转移记录);
 * · 改检验水平/AQL → v1.32 appStore.setAql:任何状态下原地重置为 freshSwitchStatus()、保留全部记录。
 * 每一步把 v1.32 的状态序列化(与 v1.32 zustand persist 写入的 aqlSwitch 相同的 JSON)。
 *
 * 全部随机量来自固定种子的 LCG,时间戳由固定时钟推进 → 输出逐字节可重复。
 *
 * 用法(仓库根目录):node scripts/gen-aql-v132-ledgers.mjs [--check]
 *   输出 src/core/__tests__/fixtures/aql-v1.32-ledgers.json;--check 只比对不写入(夹具漂移时退出码 1)。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src/core/__tests__/fixtures/aql-v1.32-ledgers.json');
const V132_COMMIT = 'fa4b539';
const SOURCES = ['aqlSwitch.ts', 'aql.ts', 'basicMath.ts'];

const work = mkdtempSync(join(tmpdir(), 'aql-v132-'));
let v132;
let current;
try {
  for (const file of SOURCES) {
    const text = execFileSync('git', ['show', `${V132_COMMIT}:src/core/${file}`], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(work, file), text);
  }
  writeFileSync(join(work, 'entry.ts'), "export * from './aqlSwitch';\n"
    + "export { codeLetterGB as __codeLetterGB, normalPlanOneStepTighter as __tighter } from './aql';\n");
  const bundle = join(work, 'v132.mjs');
  buildSync({
    entryPoints: [join(work, 'entry.ts')], bundle: true, format: 'esm', platform: 'node',
    outfile: bundle, logLevel: 'silent',
  });
  v132 = await import(pathToFileURL(bundle).href);
  // 现行 aql.ts 只用于「跳过」下述已知不兼容格，绝不参与生成记录。
  const currentBundle = join(work, 'current-aql.mjs');
  buildSync({
    entryPoints: [join(root, 'src/core/aql.ts')], bundle: true, format: 'esm', platform: 'node',
    outfile: currentBundle, logLevel: 'silent',
  });
  current = await import(pathToFileURL(currentBundle).href);
} finally {
  // 打包产物已载入内存；临时目录不留在系统里。
  process.on('exit', () => rmSync(work, { recursive: true, force: true }));
}

const {
  freshSwitchStatus, normalizeSwitchStatus, plansByState, recordInspection,
  resumeTightenedInspection, restoreNormalInspection, setSwitchConditions,
} = v132;

/** v1.32 AQL 页只提供这 6 列与 I/II/III 三个水平。 */
const AQL_COLS = [0.65, 1.0, 1.5, 2.5, 4.0, 6.5];
const LEVELS = ['I', 'II', 'III'];
/** 偏向 ≥3201 的大批量：复审发现的分歧格集中在 M/N/P/Q/R 字码。 */
const LOTS = [90, 500, 1200, 3200, 5000, 10000, 35000, 150000, 500001];

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

let clock = Date.UTC(2026, 6, 1, 0, 0, 0);
const tick = () => new Date(clock += 60_000).toISOString();

const encodeResults = (items) => items.join('');

/** 一次 v1.32 持久化快照：顶层字段 + 当时的记录条数(记录数组只追加不改写，夹具只存一份全量)。 */
function snapshot(sw, params, op) {
  const raw = JSON.parse(JSON.stringify(sw));
  const { records, history, sinceSwitch, ...top } = raw;
  return { op, params: { ...params }, top, history: encodeResults(history), sinceSwitch: encodeResults(sinceSwitch), recordCount: records.length };
}

function simulate(seed, steps) {
  const rand = lcg(seed);
  const pick = (items) => items[Math.floor(rand() * items.length)];
  const params = { lot: 5000, level: pick(LEVELS), aql: pick(AQL_COLS) };
  // 奇数种子少拒收(容易攒到 30 分转放宽)，偶数种子多拒收(容易转加严/暂停)。
  const normalReject = seed % 2 === 1 ? 0.07 : 0.22;
  let sw = freshSwitchStatus();
  const snapshots = [];
  for (let step = 0; step < steps; step += 1) {
    const roll = rand();
    let op = 'noop';
    if (sw.suspended) {
      if (roll < 0.7) { op = 'resume'; sw = resumeTightenedInspection(sw); }
    } else if (roll < 0.72) {
      op = 'batch';
      const lot = pick(LOTS);
      const plan = plansByState(lot, params.level, params.aql)[sw.state];
      const bad = rand() < (sw.state === 'tightened' ? 0.3 : normalReject);
      let d = bad ? Math.min(plan.n, plan.re + Math.floor(rand() * 2)) : Math.floor(rand() * (plan.ac + 1));
      // 以下两类 v1.32 记录会被现行「单条记录」校验拒绝，属与 B1 计分规则无关的既有口径，夹具不覆盖：
      // ① v1.32 允许全检批带不合格品而不记处置(v1.34 起要求处置);
      // ② v1.32 的表 2-C 有 42 格与国标原文不符(后续版本已更正)，这些格的放宽检验记录方案与现行表不同。
      if (plan.fullInspect) d = 0;
      const corrected = current.aqlPlanByState(lot, params.level, params.aql, sw.state);
      if (corrected.n !== plan.n || corrected.ac !== plan.ac || corrected.code !== plan.code) {
        snapshots.push(snapshot(sw, params, 'skip-table-2c-corrected'));
        continue;
      }
      params.lot = lot;
      sw = recordInspection(sw, {
        lot, level: params.level, aql: params.aql, nonconforming: d,
        batchId: `S${seed}-${String(step).padStart(3, '0')}`, inspector: '检验员', inspectedAt: tick(),
        originalInspection: rand() > 0.08,
      });
    } else if (roll < 0.86) {
      op = 'conditions';
      const patch = rand() < 0.5 ? { productionSteady: rand() < 0.75 } : { reducedApproved: rand() < 0.75 };
      if (rand() < 0.35) { patch.productionSteady = true; patch.reducedApproved = true; }
      sw = setSwitchConditions(sw, patch);
    } else if (roll < 0.9) {
      if (sw.state === 'reduced') { op = 'restore'; sw = restoreNormalInspection(sw, '负责部门因其他条件决定恢复正常检验'); }
    } else if (roll < 0.95) {
      const level = pick(LEVELS);
      const aql = pick(AQL_COLS);
      if (level !== params.level || aql !== params.aql) {
        op = 'setAql';
        // v1.32 appStore.setAql:换水平/AQL 在任何状态下都原地重置，已归档记录原样保留。
        const previous = normalizeSwitchStatus(sw);
        sw = { ...freshSwitchStatus(), records: previous.records.map((record) => ({ ...record })) };
        params.level = level;
        params.aql = aql;
      }
    }
    snapshots.push(snapshot(sw, params, op));
  }
  return { seed, records: JSON.parse(JSON.stringify(sw.records)), snapshots };
}

/** 固定剧本：每步一个操作，便于在用例里按名称引用。 */
function scripted(name, description, level, aql, actions) {
  const params = { lot: 0, level, aql };
  let sw = freshSwitchStatus();
  const snapshots = [];
  for (const action of actions) {
    if (action.op === 'batch') {
      params.lot = action.lot;
      sw = recordInspection(sw, {
        lot: action.lot, level: params.level, aql: params.aql, nonconforming: action.d,
        batchId: action.id, inspector: '检验员', inspectedAt: tick(), originalInspection: action.original !== false,
      });
    } else if (action.op === 'conditions') {
      sw = setSwitchConditions(sw, action.patch);
    } else if (action.op === 'setAql') {
      const previous = normalizeSwitchStatus(sw);
      sw = { ...freshSwitchStatus(), records: previous.records.map((record) => ({ ...record })) };
      params.level = action.level;
      params.aql = action.aql;
    } else throw new Error(`未知操作 ${action.op}`);
    snapshots.push(snapshot(sw, params, action.op));
  }
  return { name, description, records: JSON.parse(JSON.stringify(sw.records)), snapshots };
}

const batches = (prefix, count, lot, d) => Array.from({ length: count }, (_, i) => ({ op: 'batch', id: `${prefix}${i + 1}`, lot, d }));

const cases = [
  scripted('ii-150000-aql4-two-accepted',
    '复审确定性复现：II/150000/AQL 4.0(字码 Q,n=315,Ac=21;严一档 AQL 2.5 为 n=500)两批接收，v1.32 得分 3→6',
    'II', 4.0, [{ op: 'batch', id: 'L1', lot: 150000, d: 0 }, { op: 'batch', id: 'L2', lot: 150000, d: 2 }]),
  scripted('ii-150000-aql4-to-reduced',
    'v1.32 严一档规则累计 10 批 +3 到 30 分，勾齐管理条件转放宽，放宽中再接收 2 批',
    'II', 4.0, [
      ...batches('R', 10, 150000, 1),
      { op: 'conditions', patch: { productionSteady: true, reducedApproved: true } },
      ...batches('RR', 2, 150000, 0),
    ]),
  scripted('tightened-then-setaql-reset',
    'v1.32 加严检验中改 AQL:状态不留痕地重置为正常(合法旧行为，报告须醒目提示「无法核对」)',
    'II', 1.0, [
      { op: 'batch', id: 'T1', lot: 1000, d: 5 },
      { op: 'batch', id: 'T2', lot: 1000, d: 5 },
      { op: 'setAql', level: 'II', aql: 1.5 },
      { op: 'batch', id: 'N1', lot: 1000, d: 0 },
    ]),
];

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const STEPS = 60;
const random = SEEDS.map((seed) => simulate(seed, STEPS));

/** 自检：记录数组只追加(快照可由「全量记录前 recordCount 条」精确还原)。 */
for (const item of [...cases, ...random]) {
  for (const snap of item.snapshots) {
    if (snap.recordCount > item.records.length) throw new Error('记录数组不是只追加，夹具压缩不成立');
  }
}

/** 统计 v1.32 与现行规则分歧的批次(Ac≥2、严一档 n 不同、d≤严一档 Ac 仍 +3)，保证夹具真覆盖 B1。 */
function divergentCount(records) {
  return records.filter((r) => r.originalInspection && r.stateBefore === 'normal' && r.decision === 'accepted'
    && r.acceptanceNumber >= 2 && /严一档 AQL 下仍可接收/.test(r.note)
    && (() => {
      const tighter = v132.__tighter(v132.__codeLetterGB(r.lot, r.level), r.aql);
      return tighter && tighter.n !== r.sampleSize;
    })()).length;
}
const divergent = [...cases, ...random].reduce((sum, item) => sum + divergentCount(item.records), 0);
if (divergent < 20) throw new Error(`夹具只含 ${divergent} 条 v1.32/现行计分分歧批次，覆盖不足`);

const fixture = {
  generator: 'scripts/gen-aql-v132-ledgers.mjs',
  source: `git show ${V132_COMMIT}:src/core/{${SOURCES.join(',')}}(v1.32.0 发布提交)`,
  note: '由 v1.32 生产代码真实生成；禁止手工改写或用现行代码重算。快照 = { ...top, history, sinceSwitch, records: records.slice(0, recordCount) }。',
  divergentBatches: divergent,
  cases,
  random,
};
const text = `${JSON.stringify(fixture)}\n`;
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== text) {
    console.error('aql-v1.32-ledgers.json 与生成器输出不一致');
    process.exit(1);
  }
  console.log(`夹具一致(${divergent} 条分歧批次)`);
} else {
  writeFileSync(OUT, text);
  console.log(`已写入 ${OUT}(${(text.length / 1024).toFixed(0)} KiB,${divergent} 条分歧批次)`);
}
