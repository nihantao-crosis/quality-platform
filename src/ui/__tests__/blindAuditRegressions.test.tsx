/* eslint-disable no-control-regex -- 断言目标正是「产物不含控制字符」,正则必须含控制字符 */
/** 盲审整改回归(v1.43.0):原型键族 / 资源账 / 多标签 / 构建工作流。
 * 判据同 behaviorGuards:把实现改回旧行为,本文件必须转红。
 * @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evalFormula, parseMatrix, MAX_COLUMN_NAME_CHARS, MAX_RECENT_DATASETS, normalizeSwitchStatus, recordInspection, type SwitchStatus } from '../../core';
import { sanitizeFileName } from '../../platform/reportLabels';
import { toLookupMap } from '../../store/dataStore';
import { useApp, AQL_STATE_STORAGE_KEY } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { useAnalyses } from '../../store/analyses';

const ANALYSES_KEY = 'qp-analyses-v1';

beforeEach(() => {
  localStorage.clear();
  useData.getState().resetDemo();
});

const RESERVED = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('盲审:原型键族', () => {
  it('规格记忆查表不得命中 Object.prototype(切到保留名数据集不沿用上一个规格)', () => {
    useData.getState().importMatrix('A.csv', ['测量值'], [[100], [101], [99], [100.5]]);
    const a = useApp.getState();
    const specA = { lsl: a.lsl, tgt: a.tgt, usl: a.usl };
    expect(Number.isFinite(specA.tgt)).toBe(true);

    // 正常改名:规格必须按新数据重新建议
    useData.getState().importMatrix('B.csv', ['测量值'], [[110], [111], [109], [110.5]]);
    const b = useApp.getState();
    expect(b.tgt, '正常数据集未重建议规格,夹具无效').not.toBeCloseTo(specA.tgt, 6);

    // 保留原型名:写入口应直接拒绝(而不是让它进来再串味)
    for (const name of RESERVED) {
      expect(
        () => useData.getState().importMatrix(name, ['测量值'], [[110], [111], [109], [110.5]]),
        `保留名「${name}」未在写入口被拒`,
      ).toThrow(/保留名/);
    }
    // 写入口拒绝只是第一层。旧版本遗留的存档里可能**已经**有这种名字,
    // 所以查表本身必须是 null 原型(两层各自可被单独变异检出)。
    const plain = JSON.parse('{"正常":{"lsl":1,"tgt":2,"usl":3}}');
    const lookup = toLookupMap(plain);
    expect(Object.getPrototypeOf(lookup), '查表不是 null 原型').toBeNull();
    for (const name of RESERVED) {
      expect(lookup[name], `查表命中 Object.prototype 成员「${name}」`).toBeUndefined();
      expect((plain as Record<string, unknown>)[name], `夹具无效:普通对象应命中「${name}」`).toBeDefined();
    }
    expect(lookup['正常']).toEqual({ lsl: 1, tgt: 2, usl: 3 });
  });

  it('公式引擎不得把原型成员当成合法函数/常量名', () => {
    const ctx = { columns: [[1, 2, 3, 4]], colNames: ['C1'], rowCount: 4 };
    // 这一族与「写入口拒绝数据集名」无关:公式文本由用户直接输入,没有别的闸门
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(() => evalFormula(`${name}(C1)`, ctx), `${name}(C1) 被当成合法函数`).toThrow();
      expect(() => evalFormula(`${name} + 1`, ctx), `${name} 被当成合法常量`).toThrow();
    }
    // 两层防护各自单独可检:①表是 null 原型 ②判定用 hasOwnProperty 而非 in。
    // 只验行为会互相遮蔽(表若为 null 原型,in 也查不到),故对两层各断言一次。
    const formulaSrc = readFileSync('src/core/formula.ts', 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect((formulaSrc.match(/Object\.create\(null\)/g) ?? []).length, 'ELEM 与 CONSTS 两张表都必须是 null 原型').toBeGreaterThanOrEqual(2);
    expect(formulaSrc, '名字判定不得用 in(原型链)').not.toMatch(/\bt\.s in (ELEM|CONSTS)\b/);
    expect(formulaSrc).toMatch(/hasOwnProperty\.call\(ELEM/);
    expect(formulaSrc).toMatch(/hasOwnProperty\.call\(CONSTS/);

    // 真函数/常量仍可用,且结果是真数值(values 的 number[] 声明必须成立)
    const sq = evalFormula('sqrt(C1)', ctx);
    expect(sq.values.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
    const pi = evalFormula('pi * C1', ctx);
    expect(pi.values[0]).toBeCloseTo(Math.PI, 10);
  });
});

describe('盲审:资源账与构建', () => {
  it('撤销栈字节预算须贴近真实堆占用(窄表最吃亏,旧口径低估 3-8 倍)', () => {
    // 200k×1 窄表:每行是独立 JSArray,裸载荷只有 8B 但真实占用 ~100B+
    const rows = Array.from({ length: 200_000 }, (_, i) => [i]);
    useData.getState().importMatrix('窄表.csv', ['x'], rows);
    for (let i = 0; i < 20; i++) useData.getState().updateCell(0, 0, i + 1);
    const stack = useData.getState().undoStack;
    // 旧口径:200k×8B = 1.6MB/层 → 20 层才 32MB,不触发 48MB 预算(实测真占 244MB)
    // 新口径:200k×(96+8) ≈ 20.8MB/层 → 3 层即触顶
    expect(stack.length, `窄表 20 层未被裁剪(预算仍在低估)`).toBeLessThan(20);
    expect(stack.length).toBeGreaterThanOrEqual(1); // 至少留一层可撤销
    const before = useData.getState().model.subs[0].vals[0];
    useData.getState().undoEdit();
    expect(useData.getState().model.subs[0].vals[0]).not.toBe(before);
  });

  it('列名有长度闸,且与导入口共用同一常量', () => {
    useData.getState().importMatrix('列名.csv', ['a', 'b'], [[1, 1], [2, 2], [3, 3]]);
    const long = 'x'.repeat(MAX_COLUMN_NAME_CHARS + 1);
    const before = useData.getState().model.colNames[0];
    useData.getState().renameColumn(0, long);
    expect(useData.getState().model.colNames[0], '超长列名被接受').toBe(before);
    // 合法长度仍可改
    useData.getState().renameColumn(0, 'y'.repeat(MAX_COLUMN_NAME_CHARS));
    expect(useData.getState().model.colNames[0].length).toBe(MAX_COLUMN_NAME_CHARS);
    // 导入口同样拒(共用常量,不是两套阈值)
    expect(() => useData.getState().importMatrix(
      '超长列名.csv', [long], [[1], [2], [3]],
    )).toThrow(/列名长度/);
  });

  it('备用 Windows 构建的配置覆盖走文件而非内联 JSON', () => {
    const wf = readFileSync('.github/workflows/build-windows.yml', 'utf8');
    expect(wf, '内联 JSON 在 pwsh 下会被剥引号导致 CLI 解析失败').not.toMatch(/--config\s+'?\{/);
    expect(wf).toContain('--config ../.github/tauri.windows-unsigned.conf.json');
    expect(wf).toContain('--no-sign');
    const conf = JSON.parse(readFileSync('.github/tauri.windows-unsigned.conf.json', 'utf8'));
    expect(conf.bundle.createUpdaterArtifacts).toBe(false);
  });
});

describe('盲审:多标签页写冲突', () => {
  /** 模拟另一标签页写入某键并派发 storage 事件(jsdom 不会自动派发)。 */
  const otherTabWrite = (key: string, value: string) => {
    const oldValue = localStorage.getItem(key);
    localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent('storage', {
      key, oldValue, newValue: value, storageArea: localStorage,
    }));
  };

  it('AQL 责任账本:另一窗口的批次记录不得被本窗口的无关改动抹掉', () => {
    // 用**真实状态**生成夹具:账本 schema 很严(每条记录十余个必填字段),
    // 手编 JSON 会被校验器拒掉,水合便不会发生 —— 那样测的是夹具而不是修复。
    useApp.setState({ aqlLot: 500, aqlLevel: 'II', aqlAQL: 1.0 });
    const base = JSON.parse(localStorage.getItem(AQL_STATE_STORAGE_KEY) ?? '{}');
    expect(base.aqlSwitch, '夹具无效:本窗口尚未写出账本').toBeTruthy();

    // 模拟另一窗口:在同一份合法账本上真实登记 2 个接收批推进 switchingScore。
    // CORE-06 起状态字段必须与记录链重放一致,只改得分而不留批次记录会被当作篡改拒绝。
    const inspect = (status: SwitchStatus, batchId: string) => recordInspection(status, {
      lot: 500, level: 'II', aql: 1.0, regime: 'percent', nonconforming: 0,
      batchId, inspector: '另一窗口', inspectedAt: '2026-09-26T08:00:00.000Z',
    });
    const theirs = {
      ...base,
      aqlLot: 500,
      aqlSwitch: inspect(inspect(normalizeSwitchStatus(base.aqlSwitch), 'TAB-B-1'), 'TAB-B-2'),
    };
    expect(theirs.aqlSwitch.switchingScore, '夹具无效:另一窗口的登记没有推进得分').toBeGreaterThan(0);
    otherTabWrite(AQL_STATE_STORAGE_KEY, JSON.stringify(theirs));

    // 本窗口必须已水合对方的账本进展
    expect(useApp.getState().aqlSwitch.switchingScore, '未水合另一窗口的账本进展')
      .toBe(theirs.aqlSwitch.switchingScore);

    // 本窗口改一个**无关**字段 → 落盘后对方的进展必须还在
    useApp.setState({ aqlLot: 800 });
    const persisted = JSON.parse(localStorage.getItem(AQL_STATE_STORAGE_KEY) ?? '{}');
    expect(persisted.aqlSwitch?.switchingScore, '本窗口的无关改动抹掉了另一窗口的账本进展')
      .toBe(theirs.aqlSwitch.switchingScore);
    expect(persisted.aqlLot).toBe(800);
  });

  it('最近数据集列表:另一窗口新增的条目不得被本窗口整表覆盖', () => {
    useData.getState().importMatrix('本窗口.csv', ['x'], [[1], [2], [3]]);
    const mine = useData.getState().recents.length;
    expect(mine).toBeGreaterThan(0);

    // 另一窗口也必须遵守产品的 5 条最近项不变量；超限输入应被
    // .qproj/store 资源闸拒绝，不能用来测试合法跨窗口水合。
    const theirs = [
      { name: '另一窗口.csv', savedAt: new Date().toISOString() },
      ...JSON.parse(localStorage.getItem('qp-recents-v1') ?? '[]'),
    ].slice(0, MAX_RECENT_DATASETS);
    otherTabWrite('qp-recents-v1', JSON.stringify(theirs));

    expect(
      useData.getState().recents.some((r) => r.name === '另一窗口.csv'),
      '未水合另一窗口的最近列表条目',
    ).toBe(true);
  });

  // fix2609 TESTS-04:原「storage 监听真的装上了」只对未监听键派发事件再断言 aqlLot 不变,
  // 监听器全删也恒为真(events/orig 为死变量)。改为守护此前零覆盖的 qp-analyses-v1 跨窗口水合
  // (analyses.ts watchExternalWrite):删掉该注册或把水合改成空操作,本条必须转红。
  it('已保存分析:另一窗口保存的记录被水合,本窗口随后的删除不得整键抹掉它', () => {
    const previous = { page: useApp.getState().page, paretoView: useApp.getState().paretoView };
    useAnalyses.setState({ saved: [], lastError: null });
    useApp.setState({ page: 'pareto', paretoView: 'fishbone' });
    try {
      // 用**真实保存路径**生成夹具(记录 schema 严格,手编 JSON 会被校验器拒掉 → 测的是夹具)
      const mine = useAnalyses.getState().saveCurrent();
      const theirs = useAnalyses.getState().saveCurrent();
      expect(mine && theirs, '夹具无效:分析未保存').toBeTruthy();
      const theirText = localStorage.getItem(ANALYSES_KEY)!;
      expect(JSON.parse(theirText).map((a: { id: string }) => a.id)).toEqual([theirs!.id, mine!.id]);

      // 回到「另一窗口保存之前」的本窗口:内存与落盘都只有 mine(经本窗口自己的写登记)
      expect(useAnalyses.getState().remove(theirs!.id)).toBe(true);
      expect(useAnalyses.getState().saved.map((a) => a.id)).toEqual([mine!.id]);

      otherTabWrite(ANALYSES_KEY, theirText);
      expect(useAnalyses.getState().saved.map((a) => a.id), '未水合另一窗口保存的分析记录')
        .toEqual([theirs!.id, mine!.id]);

      // 本窗口删除自己的记录 → 落盘后对方那条必须还在
      expect(useAnalyses.getState().remove(mine!.id)).toBe(true);
      const persisted = JSON.parse(localStorage.getItem(ANALYSES_KEY) ?? '[]') as Array<{ id: string }>;
      expect(persisted.map((a) => a.id), '本窗口的删除把另一窗口的分析记录整键抹掉了')
        .toEqual([theirs!.id]);
    } finally {
      useApp.setState(previous);
    }
  });
});

describe('盲审:P3 批', () => {
  it('sanitizeFileName 挡住控制字符/NUL/超长/Windows 保留名', () => {
    expect(sanitizeFileName('正常名')).toBe('正常名');
    expect(sanitizeFileName('a/b:c*d')).toBe('a_b_c_d');
    // 控制字符与 NUL
    expect(sanitizeFileName('a\u0000b\u001fc')).not.toMatch(/[\u0000-\u001f]/);
    // Windows 保留设备名(带扩展名也无法创建)
    for (const n of ['CON', 'PRN', 'NUL', 'COM1', 'LPT9', 'con.txt']) {
      expect(sanitizeFileName(n), `保留名「${n}」未处理`).not.toMatch(/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i);
    }
    // 长度
    expect(sanitizeFileName('长'.repeat(500)).length).toBeLessThanOrEqual(80);
    // 结尾点/空格(Windows 不允许)
    expect(sanitizeFileName('名字. ')).not.toMatch(/[. ]$/);
    // 清干净后为空要有兜底
    expect(sanitizeFileName('///')).toBeTruthy();
  });

  it('CSV 单条逻辑记录有长度上限(未闭合引号的超长文本不得整份复制进内存)', () => {
    // 一条 200 万字符、无换行的记录:旧实现会把整份文本逐字符累积进 record
    const huge = `"${'x'.repeat(2_000_000)}`; // 未闭合引号 → 永远不换行
    const r = parseMatrix(huge);
    expect('error' in r, '超长单记录未被拒').toBe(true);
    // 必须以**资源闸**的专有文案拒绝(而不是碰巧被「引号未闭合」挡下)——
    // 后者是语法判定,发生在整份文本已复制进内存之后
    if ('error' in r) expect(r.error, `拒绝原因不是资源闸:${r.error}`).toMatch(/单条数据记录过长/);
    // 正常 CSV 不受影响
    const ok = parseMatrix('a,b\n1,2\n3,4\n5,6');
    expect('error' in ok).toBe(false);
  });

  it('响应式断点里的每个类选择器都必须在 JSX 里真实存在(不得是死选择器)', () => {
    // 盲审 P3:此前断点引用 .side-nav-label / .split-2col,而 JSX 里一个都没有,
    // <900px 的折叠逻辑整段不生效、375px 下恢复按钮 clientWidth=0。
    // 通用不变量:媒体查询里出现的类名,必须能在某个 tsx 里找到。
    const css = readFileSync('src/index.css', 'utf8');
    const mediaBlocks = css.split('@media').slice(1).join('\n');
    const classes = [...new Set(
      [...mediaBlocks.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
    )];
    expect(classes.length, '断点里没有任何类选择器,守护无效').toBeGreaterThan(2);

    const tsxSources: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); continue; }
        if (/\.tsx?$/.test(e.name)) tsxSources.push(readFileSync(full, 'utf8'));
      }
    };
    walk('src');
    const all = tsxSources.join('\n');
    const dead = classes.filter((c) => !all.includes(c));
    expect(dead, `断点引用了不存在的类(死选择器):${dead.join('、')}`).toEqual([]);
  });

  it('MES tick 任何异常都不产生未捕获错误,且会自停', () => {
    const src = readFileSync('src/platform/mes.ts', 'utf8');
    // setInterval 回调必须整体包在 try/catch 里
    const tickBlock = src.slice(src.indexOf('setInterval('), src.indexOf('}, 800);'));
    expect(tickBlock, 'tick 未包 try/catch').toContain('try {');
    expect(tickBlock).toContain('catch');
    expect(tickBlock).toContain('mesStop()');
  });
});
